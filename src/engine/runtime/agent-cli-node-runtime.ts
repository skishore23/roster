import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  listTrajectories,
  type NormalizationBounds,
  type NormalizationFilters,
  type TranscriptTrajectorySource,
} from "@letta-ai/trajectory";

import {
  runCommand,
  type CommandRunner,
} from "./command-node-runtime.js";
import {
  bindPreparedNodeRuntimeExecutor,
  createNodeExecutionCodeMode,
  createNodeExecutionSurface,
  NODE_EXECUTION_SCHEMA_VERSION,
  type NodeExecutionLog,
  type NodeExecutionEnvelope,
  type NodeExecutionResult,
  type NodeRuntimeAdapter,
  type PreparedExecutionTransport,
} from "./node-runtime.js";
import { prepareNodeCodeMode, type PreparedNodeCodeMode } from "./node-code-mode.js";
import type { JsonValue, NodeExecutionUsage, WorkspaceNodeRuntime } from "../orchestration/types.js";
import { compileNodeExecutionPrompt } from "./node-execution-prompt.js";
import {
  DEFAULT_NODE_TRAJECTORY_LIMITS,
  normalizeNodeExecutionTrajectory,
  type NodeExecutionTrajectoryLimits,
} from "./node-trajectory.js";

const DEFAULT_MAX_INPUT_BYTES = 1_048_576;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1_048_576;
const DEFAULT_MAX_CAPTURE_BYTES = 1_048_576;
const DEFAULT_PI_MAX_TRANSPORT_BYTES = 512 * 1_048_576;
const DEFAULT_HERMES_MAX_INPUT_BYTES = 128 * 1_024;
const MAX_JSON_EVENT_BYTES = 4 * 1_048_576;
const PI_MESSAGE_UPDATE_BUDGET_BYTES = 1_024;
const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const CLAUDE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_RESUMABLE_CLAUDE_SESSIONS = 128;
const execFileAsync = promisify(execFile);

const IMAGE_EXTENSION_BY_MEDIA_TYPE = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

type MaterializedNodeExecutionAttachment = {
  readonly attachmentId: string;
  readonly runtimePath: string;
};

type AgentCliTaskGitEnvironment = {
  readonly environment: NodeJS.ProcessEnv;
  readonly indexFile?: string;
  readonly objectDirectory?: string;
  readonly alternateObjectDirectories?: string;
};

/**
 * Model-side frontier hashing stages the shared working tree, but its index and
 * newly written Git objects are execution-local. Roster alone stages into the
 * authoritative run index after the graph reaches quiescence.
 */
const prepareAgentCliTaskGitEnvironment = async (
  workingDirectory: string | undefined,
  runtimeTempDirectory: string,
  environment: NodeJS.ProcessEnv | undefined,
): Promise<AgentCliTaskGitEnvironment> => {
  const baseEnvironment = { ...(environment ?? {}) };
  if (!workingDirectory) return { environment: baseEnvironment };
  let searchDirectory = resolve(workingDirectory);
  let gitMarker: string | undefined;
  while (true) {
    const candidate = join(searchDirectory, ".git");
    try {
      await stat(candidate);
      gitMarker = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Cannot inspect Git marker ${candidate}`);
      }
    }
    const parent = dirname(searchDirectory);
    if (parent === searchDirectory) break;
    searchDirectory = parent;
  }
  if (!gitMarker) return { environment: baseEnvironment };
  let commonDirectory: string;
  try {
    const result = await execFileAsync(
      "git",
      ["rev-parse", "--git-common-dir"],
      {
        cwd: workingDirectory,
        env: { ...process.env, ...baseEnvironment, GIT_OPTIONAL_LOCKS: "0" },
        encoding: "utf8",
        maxBuffer: 1_048_576,
      },
    );
    const output = String(result.stdout).trim();
    if (!output) {
      throw new Error("git rev-parse returned an empty common directory");
    }
    commonDirectory = resolve(workingDirectory, output);
  } catch (error) {
    throw new Error(
      `Cannot resolve Git administration for ${workingDirectory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const indexFile = join(runtimeTempDirectory, "git-index");
  const objectDirectory = join(runtimeTempDirectory, "git-objects");
  await mkdir(objectDirectory, { recursive: true });
  const commonObjectDirectory = join(commonDirectory, "objects");
  const inheritedAlternates = baseEnvironment.GIT_ALTERNATE_OBJECT_DIRECTORIES
    ?? process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  const alternateObjectDirectories = [
    commonObjectDirectory,
    ...(inheritedAlternates ? [inheritedAlternates] : []),
  ].join(delimiter);
  const isolated = {
    ...baseEnvironment,
    GIT_INDEX_FILE: indexFile,
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectDirectories,
    GIT_OPTIONAL_LOCKS: "0",
  };
  try {
    await execFileAsync(
      "git",
      ["read-tree", "HEAD"],
      {
        cwd: workingDirectory,
        env: { ...process.env, ...isolated },
        encoding: "utf8",
        maxBuffer: 1_048_576,
      },
    );
  } catch (error) {
    throw new Error(
      `Cannot initialize private Git index for ${workingDirectory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    environment: isolated,
    indexFile,
    objectDirectory,
    alternateObjectDirectories,
  };
};

const materializeNodeExecutionAttachments = async (
  envelope: NodeExecutionEnvelope,
  directory: string,
): Promise<ReadonlyArray<MaterializedNodeExecutionAttachment>> => {
  const materialized: MaterializedNodeExecutionAttachment[] = [];
  for (const [index, attachment] of (envelope.attachments ?? []).entries()) {
    const prefix = `data:${attachment.mediaType};base64,`;
    const encoded = attachment.dataUrl.slice(prefix.length);
    const runtimePath = join(
      directory,
      `attachment-${String(index + 1)}-${attachment.contentHash.slice(0, 12)}.${IMAGE_EXTENSION_BY_MEDIA_TYPE[attachment.mediaType]}`,
    );
    await writeFile(runtimePath, Buffer.from(encoded, "base64"), { mode: 0o600 });
    materialized.push({ attachmentId: attachment.attachmentId, runtimePath });
  }
  return materialized;
};

export type AgentCliTrajectoryLocator = {
  readonly source: Extract<TranscriptTrajectorySource, "codex" | "claude-code" | "pi" | "hermes">;
  readonly sourceId: string;
  /** Provider-native store root when the execution owns one. */
  readonly root?: string;
};

export type AgentCliTrajectoryOptions = {
  readonly bounds?: NormalizationBounds;
  readonly filters?: NormalizationFilters;
  readonly limits?: NodeExecutionTrajectoryLimits;
  /**
   * Test/custom-store seam. Production defaults read the exact native session
   * selected by sourceId, never the newest session by arrival time.
   */
  readonly readTranscript?: (locator: AgentCliTrajectoryLocator) => Promise<string>;
};

type AgentCliRuntimeOptions = {
  readonly runner?: CommandRunner;
  /** Trusted child-process environment additions, kept outside model-visible envelopes. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxCaptureBytes?: number;
  readonly maxTransportBytes?: number;
  readonly trajectory?: AgentCliTrajectoryOptions;
};

export type PiProjectTrust = "approve" | "no-approve" | "default";

const metadataString = (runtime: WorkspaceNodeRuntime, key: string): string | undefined => {
  const value = runtime.metadata?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Node runtime ${runtime.kind} metadata.${key} must be a non-blank string`);
  }
  return value.trim();
};

const metadataBoolean = (runtime: WorkspaceNodeRuntime, key: string): boolean | undefined => {
  const value = runtime.metadata?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Node runtime ${runtime.kind} metadata.${key} must be a boolean`);
  }
  return value;
};

const metadataStringArray = (runtime: WorkspaceNodeRuntime, key: string): ReadonlyArray<string> | undefined => {
  const value = runtime.metadata?.[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Node runtime ${runtime.kind} metadata.${key} must be an array of non-blank strings`);
  }
  return value.map((item) => item.trim());
};

const metadataOneOf = <Value extends string>(
  runtime: WorkspaceNodeRuntime,
  key: string,
  allowed: ReadonlyArray<Value>,
): Value | undefined => {
  const value = metadataString(runtime, key);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as Value)) {
    throw new Error(`Node runtime ${runtime.kind} metadata.${key} must be one of ${allowed.join(", ")}`);
  }
  return value as Value;
};

const commandPrefix = (
  runtime: WorkspaceNodeRuntime,
  fallback: string,
): { readonly command: string; readonly args: string[] } => ({
  command: runtime.command?.[0] ?? fallback,
  args: [...(runtime.command?.slice(1) ?? [])],
});

const unwrapJson = (text: string, label: string): unknown => {
  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1].trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // Fall through to the provider-specific error below.
      }
    }
    throw new Error(`${label} returned a final response that is not JSON`);
  }
};

const decodeFinalResponse = (
  envelope: NodeExecutionEnvelope,
  text: string,
  label: string,
): JsonValue => {
  switch (envelope.resultContract.mode) {
    case "json":
      return unwrapJson(text, label) as JsonValue;
    case "none":
      return null;
    case "text":
    case "artifact":
      return text.trim();
  }
};

type JsonObject = Readonly<Record<string, unknown>>;

const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

const usageInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const usageNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const safeTokenSum = (...values: ReadonlyArray<number>): number | undefined => {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
};

const tokenUsage = (input: {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly costUsd?: number;
  readonly durationMs?: number;
}): NodeExecutionUsage | undefined => {
  if (input.inputTokens === undefined && input.outputTokens === undefined) return undefined;
  const totalTokens = safeTokenSum(input.inputTokens ?? 0, input.outputTokens ?? 0);
  if (totalTokens === undefined) return undefined;
  return {
    ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
    ...(input.cachedInputTokens !== undefined ? { cachedInputTokens: input.cachedInputTokens } : {}),
    ...(input.cacheWriteTokens !== undefined ? { cacheWriteTokens: input.cacheWriteTokens } : {}),
    ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
    ...(input.reasoningTokens !== undefined ? { reasoningTokens: input.reasoningTokens } : {}),
    totalTokens,
    ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
};

const codexEventUsage = (event: JsonObject): NodeExecutionUsage | undefined => {
  if (event.type !== "turn.completed") return undefined;
  const usage = asObject(event.usage);
  if (!usage) return undefined;
  return tokenUsage({
    inputTokens: usageInteger(usage.input_tokens),
    cachedInputTokens: usageInteger(usage.cached_input_tokens),
    outputTokens: usageInteger(usage.output_tokens),
  });
};

const claudeResultUsage = (result: JsonObject): NodeExecutionUsage | undefined => {
  const usage = asObject(result.usage);
  if (!usage) return undefined;
  const uncachedInput = usageInteger(usage.input_tokens);
  const cachedInputTokens = usageInteger(usage.cache_read_input_tokens) ?? 0;
  const cacheWriteTokens = usageInteger(usage.cache_creation_input_tokens) ?? 0;
  const inputTokens = uncachedInput === undefined
    ? undefined
    : safeTokenSum(uncachedInput, cachedInputTokens, cacheWriteTokens);
  return tokenUsage({
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: usageInteger(usage.output_tokens),
    costUsd: usageNumber(result.total_cost_usd),
    durationMs: usageInteger(result.duration_ms),
  });
};

const claudeAssistantUsage = (event: JsonObject): NodeExecutionUsage | undefined => {
  if (event.type !== "assistant") return undefined;
  const message = asObject(event.message);
  const usage = asObject(message?.usage);
  if (!usage) return undefined;
  const uncachedInput = usageInteger(usage.input_tokens);
  const cachedInputTokens = usageInteger(usage.cache_read_input_tokens) ?? 0;
  const cacheWriteTokens = usageInteger(usage.cache_creation_input_tokens) ?? 0;
  const inputTokens = uncachedInput === undefined
    ? undefined
    : safeTokenSum(uncachedInput, cachedInputTokens, cacheWriteTokens);
  return tokenUsage({
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: usageInteger(usage.output_tokens),
  });
};

const piMessageUsage = (messageValue: unknown): NodeExecutionUsage | undefined => {
  const message = asObject(messageValue);
  if (message?.role !== "assistant") return undefined;
  const usage = asObject(message.usage);
  if (!usage) return undefined;
  const uncachedInput = usageInteger(usage.input);
  const cachedInputTokens = usageInteger(usage.cacheRead) ?? 0;
  const cacheWriteTokens = usageInteger(usage.cacheWrite) ?? 0;
  const inputTokens = uncachedInput === undefined
    ? undefined
    : safeTokenSum(uncachedInput, cachedInputTokens, cacheWriteTokens);
  return tokenUsage({
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: usageInteger(usage.output),
    costUsd: usageNumber(asObject(usage.cost)?.total),
  });
};

const sumExecutionUsage = (
  left: NodeExecutionUsage | undefined,
  right: NodeExecutionUsage | undefined,
): NodeExecutionUsage | undefined => {
  if (!left) return right;
  if (!right) return left;
  const sumOptionalTokens = (field: keyof Pick<NodeExecutionUsage,
    "inputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "outputTokens" | "reasoningTokens" | "totalTokens"
  >): number | undefined => {
    const leftValue = left[field];
    const rightValue = right[field];
    return leftValue === undefined && rightValue === undefined
      ? undefined
      : safeTokenSum(leftValue ?? 0, rightValue ?? 0);
  };
  const sumOptionalNumber = (field: "costUsd" | "durationMs"): number | undefined => {
    const leftValue = left[field];
    const rightValue = right[field];
    return leftValue === undefined && rightValue === undefined ? undefined : (leftValue ?? 0) + (rightValue ?? 0);
  };
  const inputTokens = sumOptionalTokens("inputTokens");
  const cachedInputTokens = sumOptionalTokens("cachedInputTokens");
  const cacheWriteTokens = sumOptionalTokens("cacheWriteTokens");
  const outputTokens = sumOptionalTokens("outputTokens");
  const reasoningTokens = sumOptionalTokens("reasoningTokens");
  const totalTokens = sumOptionalTokens("totalTokens");
  const costUsd = sumOptionalNumber("costUsd");
  const durationMs = sumOptionalNumber("durationMs");
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
};

const piEventsUsage = (events: ReadonlyArray<JsonObject>): NodeExecutionUsage | undefined => {
  let usage: NodeExecutionUsage | undefined;
  for (const event of events) {
    if (event.type === "message_end") usage = sumExecutionUsage(usage, piMessageUsage(event.message));
  }
  if (usage) return usage;
  const agentEnd = [...events].reverse().find((event) => event.type === "agent_end");
  if (!Array.isArray(agentEnd?.messages)) return undefined;
  for (const message of agentEnd.messages) usage = sumExecutionUsage(usage, piMessageUsage(message));
  return usage;
};

const jsonLines = (text: string, label: string, leadingPartial = false): ReadonlyArray<JsonObject> => {
  const values: JsonObject[] = [];
  const lines = text.split(/\r?\n/u);
  if (leadingPartial) lines.shift();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = asObject(JSON.parse(line));
      if (value) values.push(value);
    } catch {
      throw new Error(`${label} returned an invalid JSON event stream`);
    }
  }
  return values;
};

const compactJson = (value: unknown, maxLength = 1_200): string => {
  let encoded: string;
  try {
    encoded = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    encoded = String(value);
  }
  return encoded.length > maxLength ? `${encoded.slice(0, maxLength)}…` : encoded;
};

const commandFailureDetail = (stdout: string, stderr: string): string => {
  const detail = stderr.trim() || stdout.trim() || "no command output";
  return detail.length > 4_000 ? `${detail.slice(0, 4_000)}…` : detail;
};

const messageText = (value: unknown): string | undefined => {
  const message = asObject(value);
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const text = message.content.flatMap((content) => {
    const block = asObject(content);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("");
  return text || undefined;
};

const isPiMessageUpdatePrefix = (value: string): boolean =>
  /^\s*\{\s*"type"\s*:\s*"message_update"/u.test(value);

const createJsonLogForwarder = (
  onLog: ((entry: NodeExecutionLog) => void) | undefined,
  format: (event: JsonObject) => string | undefined,
  onEvent?: (event: JsonObject) => void,
  allowOversizedEvent?: (prefix: string) => boolean,
) => {
  let pending = "";
  let discardingOversizedEvent = false;
  const emitLine = (line: string): void => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_JSON_EVENT_BYTES) {
      onLog?.({ stream: "stdout", text: "Oversized provider event omitted from process logs\n" });
      return;
    }
    try {
      const event = asObject(JSON.parse(line));
      if (event) onEvent?.(event);
      const formatted = event ? format(event) : undefined;
      if (formatted) onLog?.({ stream: "stdout", text: `${formatted}\n` });
    } catch {
      onLog?.({ stream: "stdout", text: `${line}\n` });
    }
  };
  return {
    push: (entry: NodeExecutionLog): void => {
      if (entry.stream === "stderr") {
        onLog?.(entry);
        return;
      }
      let remaining = entry.text;
      while (remaining) {
        if (discardingOversizedEvent) {
          const newline = remaining.indexOf("\n");
          if (newline < 0) return;
          remaining = remaining.slice(newline + 1);
          discardingOversizedEvent = false;
          continue;
        }
        const newline = remaining.indexOf("\n");
        pending += newline < 0 ? remaining : remaining.slice(0, newline + 1);
        remaining = newline < 0 ? "" : remaining.slice(newline + 1);
        if (Buffer.byteLength(pending) > MAX_JSON_EVENT_BYTES) {
          const allowed = allowOversizedEvent?.(pending) === true;
          onLog?.({
            stream: "stdout",
            text: allowed
              ? "Oversized incremental provider snapshot compacted\n"
              : "Oversized provider event omitted from process logs\n",
          });
          pending = "";
          if (newline < 0) discardingOversizedEvent = true;
          continue;
        }
        if (newline >= 0) {
          emitLine(pending.replace(/\r?\n$/u, ""));
          pending = "";
        }
      }
    },
    flush: (): void => {
      if (pending && !discardingOversizedEvent) emitLine(pending);
      pending = "";
      discardingOversizedEvent = false;
    },
  };
};

/**
 * Pi's JSON protocol publishes the full accumulating assistant message on each
 * `message_update`. Charging every repeated snapshot as new semantic output
 * makes ordinary bounded turns grow quadratically and hit the command ceiling
 * before the final result. Charge those updates at a fixed per-event cost while
 * runCommand independently enforces the larger raw transport ceiling.
 */
const createPiOutputBudget = () => {
  let pending = "";
  let discardingOversizedUpdate = false;
  return (entry: NodeExecutionLog): number => {
    if (entry.stream === "stderr") return Buffer.byteLength(entry.text);
    let bytes = 0;
    let remaining = entry.text;
    while (remaining) {
      if (discardingOversizedUpdate) {
        const newline = remaining.indexOf("\n");
        if (newline < 0) return bytes;
        remaining = remaining.slice(newline + 1);
        discardingOversizedUpdate = false;
        continue;
      }
      const newline = remaining.indexOf("\n");
      pending += newline < 0 ? remaining : remaining.slice(0, newline + 1);
      remaining = newline < 0 ? "" : remaining.slice(newline + 1);
      if (Buffer.byteLength(pending) > MAX_JSON_EVENT_BYTES) {
        if (!isPiMessageUpdatePrefix(pending)) {
          throw new Error(`Pi agent event exceeded maxEventBytes=${MAX_JSON_EVENT_BYTES}`);
        }
        bytes += PI_MESSAGE_UPDATE_BUDGET_BYTES;
        pending = "";
        if (newline < 0) discardingOversizedUpdate = true;
        continue;
      }
      if (newline < 0) continue;
      const line = pending.replace(/\r?\n$/u, "");
      pending = "";
      if (!line.trim()) continue;
      const lineBytes = Buffer.byteLength(line) + 1;
      if (lineBytes > MAX_JSON_EVENT_BYTES) {
        throw new Error(`Pi agent event exceeded maxEventBytes=${MAX_JSON_EVENT_BYTES}`);
      }
      let type: unknown;
      try {
        type = asObject(JSON.parse(line))?.type;
      } catch {
        // Invalid protocol output is charged in full and rejected by parsing.
      }
      bytes += type === "message_update"
        ? Math.min(lineBytes, PI_MESSAGE_UPDATE_BUDGET_BYTES)
        : lineBytes;
    }
    return bytes;
  };
};

const codexLog = (event: JsonObject): string | undefined => {
  const type = typeof event.type === "string" ? event.type : "event";
  const item = asObject(event.item);
  if (item?.type === "command_execution") {
    return `${type}: ${compactJson(item.command)}`;
  }
  if (item?.type === "file_change") return `${type}: ${compactJson(item.changes ?? item)}`;
  if (item?.type === "agent_message" && typeof item.text === "string") return item.text;
  if (type === "turn.completed" && event.usage) return `Turn completed · ${compactJson(event.usage)}`;
  if (type === "thread.started" && typeof event.thread_id === "string") return `Session ${event.thread_id} started`;
  return type;
};

const claudeLog = (event: JsonObject): string | undefined => {
  const type = typeof event.type === "string" ? event.type : "event";
  if (type === "assistant") {
    const message = asObject(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const rendered = content.flatMap((value) => {
      const block = asObject(value);
      if (block?.type === "text" && typeof block.text === "string") return [block.text];
      if (block?.type === "tool_use") return [`Tool ${String(block.name ?? "call")}: ${compactJson(block.input)}`];
      return [];
    });
    return rendered.join("\n") || "Assistant update";
  }
  if (type === "result") return event.is_error === true ? "Claude Code failed" : "Claude Code completed";
  if (type === "system" && event.subtype === "init") return "Claude Code session started";
  return type;
};

const piLog = (event: JsonObject): string | undefined => {
  const type = typeof event.type === "string" ? event.type : "event";
  if (type === "message_update") return undefined;
  if (type === "message_end") return messageText(event.message);
  if (type === "tool_execution_start") {
    return `Tool ${String(event.toolName ?? "call")}: ${compactJson(event.args)}`;
  }
  if (type === "tool_execution_end") {
    return `Tool ${String(event.toolName ?? "call")} ${event.isError === true ? "failed" : "completed"}`;
  }
  if (type === "turn_start" && typeof event.turnIndex === "number") return `Turn ${event.turnIndex + 1} started`;
  if (type === "turn_end" && typeof event.turnIndex === "number") return `Turn ${event.turnIndex + 1} completed`;
  if (type === "agent_start") return "Pi agent started";
  if (type === "agent_end" || type === "agent_settled") return "Pi agent completed";
  return undefined;
};

const codexFinalResponse = (events: ReadonlyArray<JsonObject>): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = asObject(events[index]?.item);
    if (item?.type === "agent_message" && typeof item.text === "string") return item.text;
  }
  return undefined;
};

const piFinalResponse = (events: ReadonlyArray<JsonObject>): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const direct = messageText(event?.message);
    if (direct) return direct;
    if (!Array.isArray(event?.messages)) continue;
    for (let messageIndex = event.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const text = messageText(event.messages[messageIndex]);
      if (text) return text;
    }
  }
  return undefined;
};

const piFailureDetail = (events: ReadonlyArray<JsonObject>): string | undefined => {
  const messages: JsonObject[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const direct = asObject(event?.message);
    if (direct) messages.push(direct);
    if (Array.isArray(event?.messages)) {
      for (let messageIndex = event.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const message = asObject(event.messages[messageIndex]);
        if (message) messages.push(message);
      }
    }
  }
  const failed = messages.find((message) =>
    message.stopReason === "error" || typeof message.errorMessage === "string");
  return typeof failed?.errorMessage === "string"
    ? compactJson(failed.errorMessage, 2_000)
    : undefined;
};

const hermesQuietOutput = (
  stdout: string,
): { readonly response: string; readonly sourceId?: string } => {
  const match = stdout.match(/(?:^|\n)session_id:\s*([^\s]+)\s*$/u);
  if (!match || match.index === undefined) return { response: stdout.trim() };
  return {
    response: stdout.slice(0, match.index).trim(),
    sourceId: match[1],
  };
};

const hermesSessionUsage = (stdout: string): NodeExecutionUsage | undefined => {
  const line = stdout.split(/\r?\n/u).find((candidate) => candidate.trim());
  if (!line) return undefined;
  let session: JsonObject | undefined;
  try {
    session = asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
  if (!session) return undefined;
  const uncachedInput = usageInteger(session.input_tokens);
  const cachedInputTokens = usageInteger(session.cache_read_tokens) ?? 0;
  const cacheWriteTokens = usageInteger(session.cache_write_tokens) ?? 0;
  const inputTokens = uncachedInput === undefined
    ? undefined
    : safeTokenSum(uncachedInput, cachedInputTokens, cacheWriteTokens);
  return tokenUsage({
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: usageInteger(session.output_tokens),
    reasoningTokens: usageInteger(session.reasoning_tokens),
    costUsd: usageNumber(session.actual_cost_usd) ?? usageNumber(session.estimated_cost_usd),
  });
};

const prepareHermesIsolatedHome = async (
  runtimeTempDirectory: string,
  configuredEnvironment: NodeJS.ProcessEnv | undefined,
): Promise<string> => {
  const isolatedHome = join(runtimeTempDirectory, "hermes-home");
  await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
  const credentialSource = configuredEnvironment?.HERMES_HOME
    ?? process.env.HERMES_HOME
    ?? join(homedir(), ".hermes");
  for (const name of ["auth.json"] as const) {
    const source = join(credentialSource, name);
    const metadata = await lstat(source).catch(() => undefined);
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 1_048_576) continue;
    const destination = join(isolatedHome, name);
    await copyFile(source, destination);
    await chmod(destination, 0o600);
  }
  return isolatedHome;
};

const completed = (output: unknown, usage?: NodeExecutionUsage): NodeExecutionResult => ({
  schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
  status: "completed",
  output: output as JsonValue,
  ...(usage ? { usage } : {}),
});

const limits = (options: AgentCliRuntimeOptions) => ({
  maxInputBytes: Math.max(1_024, options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES),
  maxOutputBytes: Math.max(1_024, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES),
  maxCaptureBytes: Math.max(1_024, options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES),
});

const validatePrompt = (prompt: string, maxInputBytes: number, kind: string): void => {
  if (Buffer.byteLength(prompt) > maxInputBytes) {
    throw new Error(`Node runtime ${kind} prompt exceeded maxInputBytes=${maxInputBytes}`);
  }
};

const repeatedArgs = (
  flag: string,
  values: ReadonlyArray<string> | undefined,
): string[] => values?.flatMap((value) => [flag, value]) ?? [];

const optionalFlag = (enabled: boolean | undefined, flag: string): string[] => enabled === true ? [flag] : [];

const agentExecutionTransport = (
  envelope: NodeExecutionEnvelope,
  environment: NodeJS.ProcessEnv | undefined,
): {
  readonly envelope: NodeExecutionEnvelope;
  readonly environment: NodeJS.ProcessEnv | undefined;
} => ({ envelope, environment });

/**
 * An explicit empty workspace grant means the provider has no authority over
 * the repository at all. Keep this stricter than ordinary read-only work: a
 * read-only investigation may inspect its configured checkout, while a room
 * announcement must execute without receiving that checkout as ambient cwd.
 * Code mode retains its separately prepared, explicitly admitted surface.
 */
const isolatesProviderFromWorkspace = (envelope: NodeExecutionEnvelope): boolean =>
  envelope.surface.codeMode === undefined
  && envelope.grant.workspaceOperations.length === 0;

const withoutRuntimeWorkingDirectory = (
  runtime: WorkspaceNodeRuntime,
): WorkspaceNodeRuntime => {
  if (!runtime.metadata || !("workingDirectory" in runtime.metadata)) return runtime;
  const { workingDirectory: _workingDirectory, ...metadata } = runtime.metadata;
  const { metadata: _metadata, ...rest } = runtime;
  return {
    ...rest,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
};

/**
 * A no-workspace turn must not learn the configured checkout through the
 * provider-neutral prompt either. Runtime bindings repeat runtime placement,
 * so redact both copies before compiling provider-visible context.
 */
const providerFacingEnvelope = (
  envelope: NodeExecutionEnvelope,
  isolateWorkspace: boolean,
): NodeExecutionEnvelope => isolateWorkspace
  ? {
      ...envelope,
      runtime: withoutRuntimeWorkingDirectory(envelope.runtime),
      ...(envelope.binding
        ? {
            binding: {
              ...envelope.binding,
              runtime: withoutRuntimeWorkingDirectory(envelope.binding.runtime),
            },
          }
        : {}),
    }
  : envelope;

const CODEX_ROOM_PERMISSION_PROFILE = "roster_room";

const codexRoomPermissionProfile = (runtimeTempDirectory: string): string =>
  `permissions.${CODEX_ROOM_PERMISSION_PROFILE}={`
  + 'description="Roster room announcement",'
  + 'filesystem={":minimal"="read",":workspace_roots"="read"},'
  + `workspace_roots={${JSON.stringify(runtimeTempDirectory)}=true}`
  + "}";

const trajectoryError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 500);
};

const executionSessionId = (executionId: string): string => {
  const hash = executionId.replace(/^node_execution_/u, "").padEnd(32, "0").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20)}`;
};

const readBoundedTranscript = async (
  path: string,
  maxTranscriptBytes: number,
): Promise<string> => {
  const details = await stat(path);
  if (!details.isFile()) throw new Error("Native trajectory path is not a file");
  if (details.size > maxTranscriptBytes) {
    throw new Error(`Node trajectory transcript exceeded maxTranscriptBytes=${maxTranscriptBytes}`);
  }
  return readFile(path, "utf8");
};

const listedTrajectoryTranscript = async (
  locator: AgentCliTrajectoryLocator,
  maxTranscriptBytes: number,
): Promise<string> => {
  if (locator.source === "pi" && locator.root) {
    const entries = await readdir(locator.root, { withFileTypes: true });
    const entry = entries.find((candidate) =>
      candidate.isFile()
      && candidate.name.endsWith(".jsonl")
      && candidate.name.slice(0, -".jsonl".length).endsWith(locator.sourceId));
    if (!entry) throw new Error(`Native pi trajectory ${locator.sourceId} was not found`);
    return readBoundedTranscript(join(locator.root, entry.name), maxTranscriptBytes);
  }
  const listing = await listTrajectories({
    source: locator.source,
    ...(locator.root ? { root: locator.root } : {}),
    limit: 1_000,
  });
  const match = listing.items.find((candidate) =>
    candidate.id === locator.sourceId || candidate.id.endsWith(locator.sourceId));
  if (!match) throw new Error(`Native ${locator.source} trajectory ${locator.sourceId} was not found`);
  return readBoundedTranscript(match.path, maxTranscriptBytes);
};

const emitTrajectory = async (input: {
  readonly envelope: Parameters<NonNullable<NodeRuntimeAdapter["executeEnvelope"]>>[0];
  readonly control: Parameters<NonNullable<NodeRuntimeAdapter["executeEnvelope"]>>[1];
  readonly options: AgentCliRuntimeOptions;
  readonly source: AgentCliTrajectoryLocator["source"];
  readonly sourceId: string;
  readonly root?: string;
  readonly transcript?: string;
}): Promise<void> => {
  if (!input.control.onTrajectory) return;
  try {
    const maxTranscriptBytes = input.options.trajectory?.limits?.maxTranscriptBytes
      ?? DEFAULT_NODE_TRAJECTORY_LIMITS.maxTranscriptBytes;
    const transcript = input.transcript
      ?? await (input.options.trajectory?.readTranscript ?? ((locator) =>
        listedTrajectoryTranscript(locator, maxTranscriptBytes)))({
        source: input.source,
        sourceId: input.sourceId,
        ...(input.root ? { root: input.root } : {}),
      });
    const trajectory = normalizeNodeExecutionTrajectory({
      envelope: input.envelope,
      source: input.source,
      transcript,
      sourceGroupId: input.sourceId,
      ...(input.options.trajectory?.bounds ? { bounds: input.options.trajectory.bounds } : {}),
      ...(input.options.trajectory?.filters ? { filters: input.options.trajectory.filters } : {}),
      ...(input.options.trajectory?.limits ? { limits: input.options.trajectory.limits } : {}),
    });
    await input.control.onTrajectory(trajectory);
  } catch (error) {
    input.control.onLog?.({
      stream: "stderr",
      text: `Trajectory capture unavailable: ${trajectoryError(error)}\n`,
    });
  }
};

const codexCliNodeRuntimeAdapter = (
  options: AgentCliRuntimeOptions = {},
): NodeRuntimeAdapter => {
  const runner = options.runner ?? runCommand;
  const { maxInputBytes, maxOutputBytes, maxCaptureBytes } = limits(options);
  const validateRuntime: NonNullable<NodeRuntimeAdapter["validateRuntime"]> = (runtime) => {
      if (runtime.command && runtime.command.length === 0) {
        throw new Error("Node runtime codex-cli has an empty command");
      }
      const sandbox = metadataString(runtime, "sandbox");
      if (sandbox && sandbox !== "read-only" && sandbox !== "workspace-write") {
        throw new Error("Node runtime codex-cli metadata.sandbox must be read-only or workspace-write");
      }
      metadataString(runtime, "workingDirectory");
      metadataString(runtime, "model");
      metadataOneOf(runtime, "reasoningEffort", CODEX_REASONING_EFFORTS);
  };
  const executeEnvelope = async (
    envelope: NodeExecutionEnvelope,
    control: Parameters<NonNullable<NodeRuntimeAdapter["executeEnvelope"]>>[1],
    preparedTransport?: PreparedExecutionTransport,
  ): Promise<NodeExecutionResult> => {
      if (envelope.surface.codeMode && !preparedTransport) {
        throw new Error("Node runtime codex-cli requires registry-prepared code mode");
      }
      const prefix = commandPrefix(envelope.runtime, "codex");
      const configuredWorkingDirectory = metadataString(envelope.runtime, "workingDirectory");
      const grantAllowsWrite = Boolean(envelope.surface.codeMode)
        || envelope.grant.functionAccess.allowedEffects.includes("write");
      const sandbox = grantAllowsWrite
        ? metadataString(envelope.runtime, "sandbox") ?? "workspace-write"
        : "read-only";
      const model = metadataString(envelope.runtime, "model");
      const reasoningEffort = metadataOneOf(envelope.runtime, "reasoningEffort", CODEX_REASONING_EFFORTS);
      const runtimeTempDirectory = await mkdtemp(join(tmpdir(), "roster-codex-runtime-"));
      const isolateWorkspace = isolatesProviderFromWorkspace(envelope);
      const runtimeEnvelope = providerFacingEnvelope(envelope, isolateWorkspace);
      const workingDirectory = isolateWorkspace
        ? runtimeTempDirectory
        : configuredWorkingDirectory;
      let prepared: ReturnType<typeof agentExecutionTransport> | undefined;
      let result!: Awaited<ReturnType<typeof runner>>;
      let streamedFinalResponse: string | undefined;
      let streamedUsage: NodeExecutionUsage | undefined;
      let sourceId: string | undefined;
      const logs = createJsonLogForwarder(control.onLog, codexLog, (event) => {
        if (event.type === "thread.started" && typeof event.thread_id === "string") {
          sourceId = event.thread_id;
        }
        const item = asObject(event.item);
        if (item?.type === "agent_message" && typeof item.text === "string") {
          streamedFinalResponse = item.text;
          control.onModelOutput?.({ kind: "snapshot", text: item.text });
        }
        streamedUsage = codexEventUsage(event) ?? streamedUsage;
      });
      try {
        prepared = agentExecutionTransport(
          runtimeEnvelope,
          preparedTransport?.environment ?? options.environment,
        );
        return await (async () => {
          const taskGit = await prepareAgentCliTaskGitEnvironment(
            isolateWorkspace ? undefined : workingDirectory,
            runtimeTempDirectory,
            prepared!.environment,
          );
          const attachments = await materializeNodeExecutionAttachments(prepared!.envelope, runtimeTempDirectory);
          const prompt = compileNodeExecutionPrompt(prepared!.envelope, attachments);
          validatePrompt(prompt, maxInputBytes, "codex-cli");
          const shellEnvironment = {
            TMPDIR: runtimeTempDirectory,
            ...(taskGit.indexFile ? { GIT_INDEX_FILE: taskGit.indexFile } : {}),
            ...(taskGit.objectDirectory ? { GIT_OBJECT_DIRECTORY: taskGit.objectDirectory } : {}),
            ...(taskGit.alternateObjectDirectories
              ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: taskGit.alternateObjectDirectories }
              : {}),
            ...(taskGit.indexFile ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
          };
          const shellEnvironmentConfig = Object.entries(shellEnvironment)
            .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
            .join(",");
          const args = [
            ...prefix.args,
            "exec",
            "--json",
            "--color", "never",
            ...(isolateWorkspace
              ? [
                  "--ignore-user-config",
                  "--ignore-rules",
                  "--ephemeral",
                  "--config", codexRoomPermissionProfile(runtimeTempDirectory),
                  "--config", `default_permissions=${JSON.stringify(CODEX_ROOM_PERMISSION_PROFILE)}`,
                ]
              : ["--sandbox", sandbox]),
            "--add-dir", runtimeTempDirectory,
            ...(preparedTransport
              ? ["--add-dir", preparedTransport.clientDirectory]
              : []),
            "--config", `shell_environment_policy.set={${shellEnvironmentConfig}}`,
            "--config", "sandbox_workspace_write.exclude_tmpdir_env_var=false",
            "--skip-git-repo-check",
            ...(!isolateWorkspace && envelope.runtime.profile
              ? ["--profile", envelope.runtime.profile]
              : []),
            ...(model ? ["--model", model] : []),
            ...(reasoningEffort
              ? ["--config", `model_reasoning_effort="${reasoningEffort}"`]
              : []),
            ...attachments.flatMap((attachment) => ["--image", attachment.runtimePath]),
            "-",
          ];
          result = await runner({
            command: prefix.command,
            args,
            stdin: prompt,
            cwd: workingDirectory,
            env: {
              ...taskGit.environment,
              TMPDIR: runtimeTempDirectory,
            },
            signal: control.signal,
            timeoutMs: envelope.timeoutMs,
            maxOutputBytes,
            maxCaptureBytes,
            onOutput: logs.push,
          });
          logs.flush();
          if (!sourceId) {
            sourceId = jsonLines(result.stdout, "Codex CLI", result.stdoutTruncated)
              .map((event) => event.type === "thread.started" ? event.thread_id : undefined)
              .find((value): value is string => typeof value === "string");
          }
          if (sourceId) {
            await emitTrajectory({
              envelope,
              control,
              options,
              source: "codex",
              sourceId,
            });
          } else if (control.onTrajectory) {
            control.onLog?.({
              stream: "stderr",
              text: "Trajectory capture unavailable: Codex did not report a session ID\n",
            });
          }
          if (result.exitCode !== 0) {
            const detail = commandFailureDetail(result.stdout, result.stderr);
            throw new Error(`Codex CLI exited with code ${String(result.exitCode)}: ${detail}`);
          }
          const events = jsonLines(result.stdout, "Codex CLI", result.stdoutTruncated);
          const finalResponse = streamedFinalResponse ?? codexFinalResponse(events);
          if (!finalResponse) throw new Error("Codex CLI event stream did not contain a final agent message");
          const usage = streamedUsage ?? [...events].reverse().map(codexEventUsage).find((value) => value !== undefined);
          return completed(decodeFinalResponse(envelope, finalResponse, "Codex CLI"), usage);
        })();
      } finally {
        await rm(runtimeTempDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
  };
  const adapter: NodeRuntimeAdapter = {
    kind: "codex-cli",
    supportsCodeMode: true,
    validateRuntime,
    executeEnvelope: (envelope, control) => executeEnvelope(envelope, control),
  };
  return bindPreparedNodeRuntimeExecutor(adapter, {
    environment: options.environment,
    execute: (transport, control) => executeEnvelope(transport.envelope, control, transport),
  });
};

/** Runs a Roster node through the native non-interactive Codex CLI. */
export const createCodexCliNodeRuntimeAdapter = (
  options: AgentCliRuntimeOptions = {},
): NodeRuntimeAdapter => codexCliNodeRuntimeAdapter(options);

type ClaudeJsonOutput = {
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly structured_output?: unknown;
};

const claudeCodeNodeRuntimeAdapter = (
  options: AgentCliRuntimeOptions = {},
): NodeRuntimeAdapter => {
  const runner = options.runner ?? runCommand;
  const { maxInputBytes, maxOutputBytes, maxCaptureBytes } = limits(options);
  const resumableSessions = new Set<string>();
  const rememberResumableSession = (sessionId: string): void => {
    resumableSessions.delete(sessionId);
    resumableSessions.add(sessionId);
    while (resumableSessions.size > MAX_RESUMABLE_CLAUDE_SESSIONS) {
      const oldest = resumableSessions.values().next().value as string | undefined;
      if (!oldest) break;
      resumableSessions.delete(oldest);
    }
  };
  const validateRuntime: NonNullable<NodeRuntimeAdapter["validateRuntime"]> = (runtime) => {
      if (runtime.command && runtime.command.length === 0) {
        throw new Error("Node runtime claude-code has an empty command");
      }
      const permissionMode = metadataString(runtime, "permissionMode");
      if (permissionMode && !["acceptEdits", "dontAsk", "plan"].includes(permissionMode)) {
        throw new Error("Node runtime claude-code metadata.permissionMode must be acceptEdits, dontAsk, or plan");
      }
      metadataString(runtime, "workingDirectory");
      metadataString(runtime, "model");
      metadataOneOf(runtime, "effort", ["low", "medium", "high", "xhigh", "max"]);
  };
  const executeEnvelope = async (
    envelope: NodeExecutionEnvelope,
    control: Parameters<NonNullable<NodeRuntimeAdapter["executeEnvelope"]>>[1],
    preparedTransport?: PreparedExecutionTransport,
  ): Promise<NodeExecutionResult> => {
      if (envelope.surface.codeMode && !preparedTransport) {
        throw new Error("Node runtime claude-code requires registry-prepared code mode");
      }
      const runtimeTempDirectory = await mkdtemp(join(tmpdir(), "roster-claude-runtime-"));
      const isolateWorkspace = isolatesProviderFromWorkspace(envelope);
      const prepared = agentExecutionTransport(
        providerFacingEnvelope(envelope, isolateWorkspace),
        preparedTransport?.environment ?? options.environment,
      );
      try {
      return await (async () => {
        const configuredWorkingDirectory = metadataString(envelope.runtime, "workingDirectory");
        const workingDirectory = isolateWorkspace
          ? runtimeTempDirectory
          : configuredWorkingDirectory;
        const taskGit = await prepareAgentCliTaskGitEnvironment(
          isolateWorkspace ? undefined : workingDirectory,
          runtimeTempDirectory,
          prepared.environment,
        );
        const attachments = await materializeNodeExecutionAttachments(prepared.envelope, runtimeTempDirectory);
        const prompt = compileNodeExecutionPrompt(prepared.envelope, attachments);
        validatePrompt(prompt, maxInputBytes, "claude-code");
        const prefix = commandPrefix(envelope.runtime, "claude");
        // A no-workspace announcement must not resume a provider session that
        // may contain repository context from an earlier bounded task.
        const boundSessionId = isolateWorkspace
          ? undefined
          : envelope.binding?.sessionId;
        if (boundSessionId && !CLAUDE_SESSION_ID_PATTERN.test(boundSessionId)) {
          throw new Error("Node runtime claude-code binding sessionId must be a UUID");
        }
        const sourceId = isolateWorkspace
          ? undefined
          : boundSessionId
            ?? (control.onTrajectory ? executionSessionId(envelope.executionId) : undefined);
        const resumeBoundSession = boundSessionId !== undefined
          && resumableSessions.has(boundSessionId);
        const grantAllowsWrite = Boolean(envelope.surface.codeMode)
          || envelope.grant.functionAccess.allowedEffects.includes("write");
        const permissionMode = grantAllowsWrite
          ? metadataString(envelope.runtime, "permissionMode") ?? "acceptEdits"
          : "plan";
        const effort = metadataOneOf(
          envelope.runtime,
          "effort",
          ["low", "medium", "high", "xhigh", "max"],
        );
        const args = [
          ...prefix.args,
          "--print",
          "--output-format", "stream-json",
          "--verbose",
          "--safe-mode",
          "--permission-mode", permissionMode,
          ...(isolateWorkspace
            ? [
                "--restricted",
                "--tools", "",
                "--no-chrome",
                "--strict-mcp-config",
                "--mcp-config", "{}",
              ]
            : []),
          "--include-partial-messages",
          ...(permissionMode === "acceptEdits" ? ["--allowedTools", "Bash"] : []),
          ...(sourceId
            ? [resumeBoundSession ? "--resume" : "--session-id", sourceId]
            : ["--no-session-persistence"]),
          ...(!isolateWorkspace && envelope.runtime.profile
            ? ["--agent", envelope.runtime.profile]
            : []),
          ...(metadataString(envelope.runtime, "model") ? ["--model", metadataString(envelope.runtime, "model")!] : []),
          ...(effort ? ["--effort", effort] : []),
          ...(attachments.length ? ["--add-dir", runtimeTempDirectory] : []),
          ...(preparedTransport
            ? ["--add-dir", preparedTransport.clientDirectory]
            : []),
        ];
        let streamedProviderOutput: ClaudeJsonOutput | undefined;
        let streamedUsage: NodeExecutionUsage | undefined;
        const logs = createJsonLogForwarder(control.onLog, claudeLog, (event) => {
          if (
            boundSessionId
            && event.type === "system"
            && event.subtype === "init"
          ) {
            rememberResumableSession(boundSessionId);
          }
          if (event.type === "result") streamedProviderOutput = event as ClaudeJsonOutput;
          const assistantText = event.type === "assistant" ? messageText(event.message) : undefined;
          if (assistantText) control.onModelOutput?.({ kind: "snapshot", text: assistantText });
          const streamEvent = event.type === "stream_event" ? asObject(event.event) : undefined;
          const streamDelta = asObject(streamEvent?.delta);
          if (streamEvent?.type === "content_block_delta"
            && streamDelta?.type === "text_delta"
            && typeof streamDelta.text === "string") {
            control.onModelOutput?.({ kind: "delta", text: streamDelta.text });
          }
          streamedUsage = sumExecutionUsage(streamedUsage, claudeAssistantUsage(event));
        });
        let result: Awaited<ReturnType<typeof runner>>;
        try {
          result = await runner({
            command: prefix.command,
            args,
            stdin: prompt,
            cwd: workingDirectory,
            env: taskGit.environment,
            signal: control.signal,
            timeoutMs: envelope.timeoutMs,
            maxOutputBytes,
            maxCaptureBytes,
            onOutput: logs.push,
          });
        } catch (error) {
          logs.flush();
          if (streamedUsage && control.onUsage) {
            try {
              await control.onUsage({ ...streamedUsage, partial: true });
            } catch (usageError) {
              control.onLog?.({
                stream: "stderr",
                text: `Partial usage reporting failed: ${trajectoryError(usageError)}\n`,
              });
            }
          }
          throw error;
        }
        logs.flush();
        if (sourceId) {
          await emitTrajectory({
            envelope,
            control,
            options,
            source: "claude-code",
            sourceId,
          });
        }
        if (result.exitCode !== 0) {
          const detail = commandFailureDetail(result.stdout, result.stderr);
          throw new Error(`Claude Code exited with code ${String(result.exitCode)}: ${detail}`);
        }
        const providerOutput = streamedProviderOutput
          ?? [...jsonLines(result.stdout, "Claude Code", result.stdoutTruncated)]
            .reverse()
            .find((event) => event.type === "result") as ClaudeJsonOutput | undefined;
        if (!providerOutput) throw new Error("Claude Code event stream did not contain a result");
        if (providerOutput.is_error === true) {
          throw new Error(`Claude Code failed: ${String(providerOutput.result ?? "unknown error")}`);
        }
        if (providerOutput.structured_output !== undefined && envelope.resultContract.mode === "json") {
          return completed(providerOutput.structured_output, claudeResultUsage(providerOutput as JsonObject));
        }
        if (typeof providerOutput.result !== "string") {
          throw new Error("Claude Code JSON output did not contain a result string");
        }
        return completed(
          decodeFinalResponse(envelope, providerOutput.result, "Claude Code"),
          claudeResultUsage(providerOutput as JsonObject),
        );
      })();
      } finally {
        await rm(runtimeTempDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
  };
  const adapter: NodeRuntimeAdapter = {
    kind: "claude-code",
    supportsCodeMode: true,
    validateRuntime,
    executeEnvelope: (envelope, control) => executeEnvelope(envelope, control),
  };
  return bindPreparedNodeRuntimeExecutor(adapter, {
    environment: options.environment,
    execute: (transport, control) => executeEnvelope(transport.envelope, control, transport),
  });
};

/** Runs a Roster node through Claude Code's native print-mode JSON protocol. */
export const createClaudeCodeNodeRuntimeAdapter = (
  options: AgentCliRuntimeOptions = {},
): NodeRuntimeAdapter => claudeCodeNodeRuntimeAdapter(options);

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const PI_PROJECT_TRUST: ReadonlyArray<PiProjectTrust> = ["approve", "no-approve", "default"];

type PiNativeFunctionBridge = {
  readonly prepared: PreparedNodeCodeMode;
  readonly extensionPath: string;
  readonly toolNames: ReadonlyArray<string>;
  readonly prompt: string;
};

const piNativeFunctionToolNames = (
  tools: NodeExecutionEnvelope["surface"]["tools"],
): ReadonlyArray<{ readonly functionId: string; readonly name: string }> => {
  const used = new Set<string>();
  return tools.map((tool, index) => {
    const base = `roster_${tool.id.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "")}`
      .slice(0, 56);
    let name = base || `roster_function_${index + 1}`;
    let suffix = 2;
    while (used.has(name)) name = `${base.slice(0, 52)}_${suffix++}`;
    used.add(name);
    return { functionId: tool.id, name };
  });
};

const piNativeFunctionExtension = (
  envelope: NodeExecutionEnvelope,
  mappings: ReadonlyArray<{ readonly functionId: string; readonly name: string }>,
): string => {
  const tools = new Map(envelope.surface.tools.map((tool) => [tool.id, tool]));
  const registrations = mappings.map(({ functionId, name }) => {
    const tool = tools.get(functionId)!;
    return `pi.registerTool({
      name: ${JSON.stringify(name)},
      label: ${JSON.stringify(tool.description)},
      description: ${JSON.stringify(`Call the exact fenced Roster function ${functionId}.`)},
      parameters: ${JSON.stringify(tool.inputSchema)},
      async execute(_toolCallId, params, signal) {
        await callRoster(${JSON.stringify(functionId)}, params, signal);
        return {
          content: [{ type: "text", text: ${JSON.stringify(`Roster function ${functionId} delivered.`)} }],
          details: { functionId: ${JSON.stringify(functionId)} },
        };
      },
    });`;
  }).join("\n");
  return `import { spawn } from "node:child_process";

const callRoster = (functionId, value, signal) => new Promise((resolve, reject) => {
  const child = spawn("roster-tool", ["call", functionId, "await"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", abort);
    error ? reject(error) : resolve();
  };
  const abort = () => {
    child.kill("SIGTERM");
    finish(new Error("Roster function call was aborted"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  child.on("error", () => finish(new Error("Roster function transport failed")));
  child.on("close", (code) => finish(code === 0 ? undefined : new Error("Roster function call failed")));
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.end(JSON.stringify(value));
});

export default function rosterFunctionBridge(pi) {
${registrations}
}
`;
};

const preparePiNativeFunctionBridge = async (input: {
  readonly envelope: NodeExecutionEnvelope;
  readonly invokeFunction: NonNullable<Parameters<typeof prepareNodeCodeMode>[0]["invokeFunction"]>;
  readonly signal?: AbortSignal;
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<PiNativeFunctionBridge | undefined> => {
  if (input.envelope.surface.codeMode || input.envelope.surface.tools.length === 0) return undefined;
  const codeMode = createNodeExecutionCodeMode({
    inputMode: "external",
    maxFunctionCalls: input.envelope.grant.budgets.maxFunctionCalls,
  })!;
  const bridgeEnvelope: NodeExecutionEnvelope = {
    ...input.envelope,
    input: undefined,
    surface: createNodeExecutionSurface({
      skills: input.envelope.surface.skills,
      tools: input.envelope.surface.tools,
      workspace: input.envelope.surface.workspace,
      codeMode,
    }),
  };
  const prepared = await prepareNodeCodeMode({
    envelope: bridgeEnvelope,
    invokeFunction: input.invokeFunction,
    ...(input.signal ? { signal: input.signal } : {}),
    directory: input.directory,
    baseEnvironment: input.environment,
  });
  const mappings = piNativeFunctionToolNames(input.envelope.surface.tools);
  const extensionPath = join(input.directory, "roster-pi-function-bridge.mjs");
  await writeFile(extensionPath, piNativeFunctionExtension(input.envelope, mappings), {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    prepared,
    extensionPath,
    toolNames: mappings.map(({ name }) => name),
    prompt: [
      "Pi exposes the following authorized Roster functions as native tools for this turn:",
      ...mappings.map(({ functionId, name }) => `- ${functionId}: call the Pi tool ${name}`),
      "Use the mapped native tool whenever the task instructions require that Roster function.",
    ].join("\n"),
  };
};

const piAgentNodeRuntimeAdapter = (
  options: AgentCliRuntimeOptions = {},
): NodeRuntimeAdapter => {
  const runner = options.runner ?? runCommand;
  const { maxInputBytes, maxOutputBytes, maxCaptureBytes } = limits(options);
  const validateRuntime: NonNullable<NodeRuntimeAdapter["validateRuntime"]> = (runtime) => {
      if (runtime.command && runtime.command.length === 0) {
        throw new Error("Node runtime pi-agent has an empty command");
      }
      metadataString(runtime, "workingDirectory");
      metadataString(runtime, "provider");
      metadataString(runtime, "model");
      metadataString(runtime, "sessionDir");
      metadataOneOf(runtime, "thinking", PI_THINKING_LEVELS);
      metadataOneOf(runtime, "projectTrust", PI_PROJECT_TRUST);
      metadataStringArray(runtime, "extensions");
      metadataStringArray(runtime, "skills");
      metadataStringArray(runtime, "promptTemplates");
      metadataStringArray(runtime, "themes");
      metadataStringArray(runtime, "tools");
      metadataStringArray(runtime, "excludeTools");
      metadataBoolean(runtime, "noExtensions");
      metadataBoolean(runtime, "noSkills");
      metadataBoolean(runtime, "noPromptTemplates");
      metadataBoolean(runtime, "noThemes");
      metadataBoolean(runtime, "noBuiltinTools");
      metadataBoolean(runtime, "noTools");
      metadataBoolean(runtime, "noContextFiles");
      metadataBoolean(runtime, "offline");
  };
  const executeEnvelope = async (
    envelope: NodeExecutionEnvelope,
    control: Parameters<NonNullable<NodeRuntimeAdapter["executeEnvelope"]>>[1],
    preparedTransport?: PreparedExecutionTransport,
  ): Promise<NodeExecutionResult> => {
      if (envelope.surface.codeMode && !preparedTransport) {
        throw new Error("Node runtime pi-agent requires registry-prepared code mode");
      }
      const configuredTools = metadataStringArray(envelope.runtime, "tools");
      const excludedTools = metadataStringArray(envelope.runtime, "excludeTools");
      const grantAllowsWrite = Boolean(envelope.surface.codeMode)
        || envelope.grant.functionAccess.allowedEffects.includes("write");
      const grantDisablesTools = !grantAllowsWrite && envelope.surface.tools.length === 0;
      const shellUnavailable = grantDisablesTools
        || metadataBoolean(envelope.runtime, "noTools")
        || metadataBoolean(envelope.runtime, "noBuiltinTools")
        || (configuredTools !== undefined && !configuredTools.includes("bash"))
        || excludedTools?.includes("bash");
      if (envelope.surface.codeMode && shellUnavailable) {
        throw new Error("Node runtime pi-agent cannot use code mode without its bash tool");
      }
      const runtimeTempDirectory = await mkdtemp(join(tmpdir(), "roster-pi-runtime-"));
      const prepared = agentExecutionTransport(
        envelope,
        preparedTransport?.environment ?? options.environment,
      );
      try {
      return await (async () => {
      const workingDirectory = metadataString(envelope.runtime, "workingDirectory");
      const taskGit = await prepareAgentCliTaskGitEnvironment(
        workingDirectory,
        runtimeTempDirectory,
        prepared.environment,
      );
      const needsNativeFunctionBridge = Boolean(
        control.invokeFunction
        && !preparedTransport
        && prepared.envelope.surface.tools.length > 0,
      );
      if (needsNativeFunctionBridge && metadataBoolean(envelope.runtime, "noTools")) {
        throw new Error("Node runtime pi-agent cannot expose Roster functions when tools are disabled");
      }
      const nativeFunctionBridge = needsNativeFunctionBridge && control.invokeFunction
        ? await preparePiNativeFunctionBridge({
            envelope: prepared.envelope,
            invokeFunction: control.invokeFunction,
            signal: control.signal,
            directory: runtimeTempDirectory,
            environment: taskGit.environment,
          })
        : undefined;
      const attachments = await materializeNodeExecutionAttachments(prepared.envelope, runtimeTempDirectory);
      const prompt = [
        compileNodeExecutionPrompt(prepared.envelope, attachments),
        nativeFunctionBridge?.prompt,
      ].filter((part): part is string => Boolean(part)).join("\n\n");
      validatePrompt(prompt, maxInputBytes, "pi-agent");
      const prefix = commandPrefix(envelope.runtime, "pi");
      const provider = metadataString(envelope.runtime, "provider");
      const model = metadataString(envelope.runtime, "model");
      const thinking = metadataString(envelope.runtime, "thinking");
      const configuredSessionDir = metadataString(envelope.runtime, "sessionDir");
      const trajectorySessionDirectory = control.onTrajectory
        ? await mkdtemp(join(tmpdir(), "roster-pi-trajectory-"))
        : undefined;
      const sourceId = trajectorySessionDirectory
        ? executionSessionId(envelope.executionId)
        : undefined;
      const extensions = metadataStringArray(envelope.runtime, "extensions");
      const skills = metadataStringArray(envelope.runtime, "skills");
      const promptTemplates = metadataStringArray(envelope.runtime, "promptTemplates");
      const themes = metadataStringArray(envelope.runtime, "themes");
      const tools = !grantDisablesTools && configuredTools
        ? [...new Set([...configuredTools, ...(nativeFunctionBridge?.toolNames ?? [])])]
        : grantDisablesTools ? undefined : configuredTools;
      const excludeTools = excludedTools;
      const projectTrust = grantDisablesTools
        ? "no-approve"
        : metadataOneOf(envelope.runtime, "projectTrust", PI_PROJECT_TRUST) ?? "approve";
      const args = [
        ...prefix.args,
        "--print",
        "--mode", "json",
        ...(sourceId
          ? ["--session-id", sourceId]
          : ["--no-session"]),
        "--name", `Roster ${envelope.executionId.slice(0, 48)}`,
        ...(provider ? ["--provider", provider] : []),
        ...(model ? ["--model", model] : []),
        ...(thinking ? ["--thinking", thinking] : []),
        ...(trajectorySessionDirectory
          ? ["--session-dir", trajectorySessionDirectory]
          : configuredSessionDir
            ? ["--session-dir", configuredSessionDir]
            : []),
        ...repeatedArgs("--extension", [
          ...(nativeFunctionBridge ? [nativeFunctionBridge.extensionPath] : []),
          ...(extensions ?? []),
        ]),
        ...repeatedArgs("--skill", skills),
        ...repeatedArgs("--prompt-template", promptTemplates),
        ...repeatedArgs("--theme", themes),
        ...(tools?.length ? ["--tools", tools.join(",")] : []),
        ...(excludeTools?.length ? ["--exclude-tools", excludeTools.join(",")] : []),
        ...optionalFlag(grantDisablesTools || Boolean(nativeFunctionBridge) || metadataBoolean(envelope.runtime, "noExtensions"), "--no-extensions"),
        ...optionalFlag(grantDisablesTools || metadataBoolean(envelope.runtime, "noSkills"), "--no-skills"),
        ...optionalFlag(grantDisablesTools || metadataBoolean(envelope.runtime, "noPromptTemplates"), "--no-prompt-templates"),
        ...optionalFlag(grantDisablesTools || metadataBoolean(envelope.runtime, "noThemes"), "--no-themes"),
        ...optionalFlag(grantDisablesTools || metadataBoolean(envelope.runtime, "noBuiltinTools"), "--no-builtin-tools"),
        ...optionalFlag(grantDisablesTools || metadataBoolean(envelope.runtime, "noTools"), "--no-tools"),
        ...optionalFlag(grantDisablesTools || metadataBoolean(envelope.runtime, "noContextFiles"), "--no-context-files"),
        ...optionalFlag(metadataBoolean(envelope.runtime, "offline"), "--offline"),
        ...(projectTrust === "approve" ? ["--approve"] : projectTrust === "no-approve" ? ["--no-approve"] : []),
        ...attachments.map((attachment) => `@${attachment.runtimePath}`),
        "Execute the Roster node task described on stdin and return only the requested JSON.",
      ];
      let streamedFinalResponse: string | undefined;
      let streamedUsage: NodeExecutionUsage | undefined;
      const logs = createJsonLogForwarder(control.onLog, piLog, (event) => {
        const assistantUpdate = event.type === "message_update"
          ? asObject(event.assistantMessageEvent)
          : undefined;
        if (assistantUpdate?.type === "text_delta" && typeof assistantUpdate.delta === "string") {
          control.onModelOutput?.({ kind: "delta", text: assistantUpdate.delta });
        }
        streamedFinalResponse = piFinalResponse([event]) ?? streamedFinalResponse;
        if (event.type === "message_end") {
          streamedUsage = sumExecutionUsage(streamedUsage, piMessageUsage(event.message));
        }
      }, isPiMessageUpdatePrefix);
      try {
        const result = await runner({
          command: prefix.command,
          args,
          stdin: prompt,
          cwd: workingDirectory,
          env: nativeFunctionBridge?.prepared.environment ?? taskGit.environment,
          signal: control.signal,
          timeoutMs: envelope.timeoutMs,
          maxOutputBytes,
          maxTransportBytes: Math.max(
            maxOutputBytes,
            options.maxTransportBytes ?? DEFAULT_PI_MAX_TRANSPORT_BYTES,
          ),
          maxCaptureBytes,
          outputBudgetBytes: createPiOutputBudget(),
          onOutput: logs.push,
        });
        logs.flush();
        if (sourceId && trajectorySessionDirectory) {
          await emitTrajectory({
            envelope,
            control,
            options,
            source: "pi",
            sourceId,
            root: trajectorySessionDirectory,
          });
        }
        if (result.exitCode !== 0) {
          const detail = commandFailureDetail(result.stdout, result.stderr);
          throw new Error(`Pi agent exited with code ${String(result.exitCode)}: ${detail}`);
        }
        const events = jsonLines(result.stdout, "Pi agent", result.stdoutTruncated);
        const finalResponse = streamedFinalResponse ?? piFinalResponse(events);
        if (!finalResponse) {
          const failureDetail = piFailureDetail(events);
          throw new Error(failureDetail
            ? `Pi agent provider failed: ${failureDetail}`
            : "Pi agent event stream did not contain a final assistant message");
        }
        return completed(
          decodeFinalResponse(envelope, finalResponse, "Pi agent"),
          streamedUsage ?? piEventsUsage(events),
        );
      } finally {
        try {
          await nativeFunctionBridge?.prepared.close();
        } finally {
          if (trajectorySessionDirectory) {
            await rm(trajectorySessionDirectory, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }
      })();
      } finally {
        await rm(runtimeTempDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
  };
  const adapter: NodeRuntimeAdapter = {
    kind: "pi-agent",
    supportsCodeMode: true,
    validateRuntime,
    executeEnvelope: (envelope, control) => executeEnvelope(envelope, control),
  };
  return bindPreparedNodeRuntimeExecutor(adapter, {
    environment: options.environment,
    execute: (transport, control) => executeEnvelope(transport.envelope, control, transport),
  });
};

/** Runs a Roster node through Pi's non-interactive coding-agent CLI. */
export const createPiAgentNodeRuntimeAdapter = (
  options: AgentCliRuntimeOptions = {},
): NodeRuntimeAdapter => piAgentNodeRuntimeAdapter(options);

/**
 * Runs a Roster node through Hermes Agent's quiet one-shot mode.
 *
 * Hermes intentionally receives the same provider-neutral execution prompt as
 * every other coding runtime. Quiet single-query mode returns the final response
 * plus a parseable session ID, which can be exported through Hermes' own session
 * command for trajectory normalization.
 */
const hermesAgentNodeRuntimeAdapter = (
  options: AgentCliRuntimeOptions = {},
): NodeRuntimeAdapter => {
  const runner = options.runner ?? runCommand;
  const { maxOutputBytes, maxCaptureBytes } = limits(options);
  const maxInputBytes = Math.max(
    1_024,
    Math.min(options.maxInputBytes ?? DEFAULT_HERMES_MAX_INPUT_BYTES, DEFAULT_HERMES_MAX_INPUT_BYTES),
  );
  const validateRuntime: NonNullable<NodeRuntimeAdapter["validateRuntime"]> = (runtime) => {
      if (runtime.command && runtime.command.length === 0) {
        throw new Error("Node runtime hermes-agent has an empty command");
      }
      if (runtime.profile) {
        throw new Error(
          "Node runtime hermes-agent does not support runtime.profile; use a Hermes profile alias as runtime.command",
        );
      }
      metadataString(runtime, "workingDirectory");
      metadataString(runtime, "provider");
      metadataString(runtime, "model");
      metadataOneOf(runtime, "thinking", ["none", "low", "medium", "high", "xhigh"]);
      metadataBoolean(runtime, "yolo");
  };
  const executeEnvelope = async (
    envelope: NodeExecutionEnvelope,
    control: Parameters<NonNullable<NodeRuntimeAdapter["executeEnvelope"]>>[1],
    preparedTransport?: PreparedExecutionTransport,
  ): Promise<NodeExecutionResult> => {
      if (envelope.surface.codeMode && !preparedTransport) {
        throw new Error("Node runtime hermes-agent requires registry-prepared code mode");
      }
      const runtimeTempDirectory = await mkdtemp(join(tmpdir(), "roster-hermes-runtime-"));
      const isolateWorkspace = isolatesProviderFromWorkspace(envelope);
      const prepared = agentExecutionTransport(
        providerFacingEnvelope(envelope, isolateWorkspace),
        preparedTransport?.environment ?? options.environment,
      );
      try {
      return await (async () => {
      const configuredWorkingDirectory = metadataString(envelope.runtime, "workingDirectory");
      const workingDirectory = isolateWorkspace
        ? runtimeTempDirectory
        : configuredWorkingDirectory;
      const taskGit = await prepareAgentCliTaskGitEnvironment(
        isolateWorkspace ? undefined : workingDirectory,
        runtimeTempDirectory,
        prepared.environment,
      );
      const hermesHome = await prepareHermesIsolatedHome(
        runtimeTempDirectory,
        prepared.environment,
      );
      const thinking = metadataOneOf(
        envelope.runtime,
        "thinking",
        ["none", "low", "medium", "high", "xhigh"],
      );
      if (thinking || isolateWorkspace) {
        await writeFile(
          join(hermesHome, "config.yaml"),
          `${JSON.stringify({
            ...(thinking ? { agent: { reasoning_effort: thinking } } : {}),
            ...(isolateWorkspace ? { platform_toolsets: { cli: [] } } : {}),
          })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      }
      const hermesEnvironment = {
        ...taskGit.environment,
        HERMES_HOME: hermesHome,
      };
      const attachments = await materializeNodeExecutionAttachments(prepared.envelope, runtimeTempDirectory);
      if (attachments.length > 1) {
        throw new Error("Node runtime hermes-agent supports at most one image attachment per execution");
      }
      const prompt = compileNodeExecutionPrompt(prepared.envelope, attachments);
      validatePrompt(prompt, maxInputBytes, "hermes-agent");
      const prefix = commandPrefix(envelope.runtime, "hermes");
      const args = [
        ...prefix.args,
        "chat",
        "--quiet",
        "--query", prompt,
        ...(metadataString(envelope.runtime, "provider")
          ? ["--provider", metadataString(envelope.runtime, "provider")!]
          : []),
        ...(metadataString(envelope.runtime, "model")
          ? ["--model", metadataString(envelope.runtime, "model")!]
          : []),
        ...(attachments[0] ? ["--image", attachments[0].runtimePath] : []),
        ...optionalFlag(
          (Boolean(envelope.surface.codeMode)
            || envelope.grant.functionAccess.allowedEffects.includes("write"))
            && metadataBoolean(envelope.runtime, "yolo"),
          "--yolo",
        ),
        "--source", "roster",
      ];
      const result = await runner({
        command: prefix.command,
        args,
        stdin: "",
        cwd: workingDirectory,
        env: hermesEnvironment,
        signal: control.signal,
        timeoutMs: envelope.timeoutMs,
        maxOutputBytes,
        maxCaptureBytes,
        onOutput: control.onLog,
      });
      const quiet = hermesQuietOutput(result.stdout);
      if (result.exitCode !== 0) {
        const detail = commandFailureDetail(result.stdout, result.stderr);
        throw new Error(`Hermes Agent exited with code ${String(result.exitCode)}: ${detail}`);
      }
      let exportedTranscript: string | undefined;
      if (quiet.sourceId) {
        try {
          const exported = await runner({
            command: prefix.command,
            args: [
              ...prefix.args,
              ...(envelope.runtime.profile ? ["--profile", envelope.runtime.profile] : []),
              "sessions", "export",
              "--session-id", quiet.sourceId,
              "-",
            ],
            stdin: "",
            cwd: workingDirectory,
            env: hermesEnvironment,
            signal: control.signal,
            maxOutputBytes,
            maxCaptureBytes,
          });
          if (exported.exitCode === 0) {
            exportedTranscript = exported.stdout;
          } else {
            control.onLog?.({
              stream: "stderr",
              text: `Hermes session telemetry unavailable: export exited with code ${String(exported.exitCode)}\n`,
            });
          }
        } catch (error) {
          control.onLog?.({
            stream: "stderr",
            text: `Hermes session telemetry unavailable: ${trajectoryError(error)}\n`,
          });
        }
      }
      if (quiet.sourceId && control.onTrajectory) {
        if (options.trajectory?.readTranscript) {
          await emitTrajectory({
            envelope,
            control,
            options,
            source: "hermes",
            sourceId: quiet.sourceId,
          });
        } else if (exportedTranscript !== undefined) {
          await emitTrajectory({
            envelope,
            control,
            options,
            source: "hermes",
            sourceId: quiet.sourceId,
            transcript: exportedTranscript,
          });
        } else {
          control.onLog?.({
            stream: "stderr",
            text: "Trajectory capture unavailable: Hermes session export was unavailable\n",
          });
        }
      } else if (control.onTrajectory) {
        control.onLog?.({
          stream: "stderr",
          text: "Trajectory capture unavailable: Hermes did not report a session ID\n",
        });
      }
      return completed(
        decodeFinalResponse(envelope, quiet.response, "Hermes Agent"),
        exportedTranscript === undefined ? undefined : hermesSessionUsage(exportedTranscript),
      );
      })();
      } finally {
        await rm(runtimeTempDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
  };
  const adapter: NodeRuntimeAdapter = {
    kind: "hermes-agent",
    supportsCodeMode: true,
    validateRuntime,
    executeEnvelope: (envelope, control) => executeEnvelope(envelope, control),
  };
  return bindPreparedNodeRuntimeExecutor(adapter, {
    environment: options.environment,
    execute: (transport, control) => executeEnvelope(transport.envelope, control, transport),
  });
};

export const createHermesAgentNodeRuntimeAdapter = (
  options: AgentCliRuntimeOptions = {},
): NodeRuntimeAdapter => hermesAgentNodeRuntimeAdapter(options);

export type { AgentCliRuntimeOptions };
