import { randomUUID } from "node:crypto";
import { watch, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { hashCanonical } from "../../core/canonical.js";
import type { JsonValue } from "../orchestration/types.js";
import { createNodeExecutionSurface } from "./node-runtime.js";
import type {
  NodeExecutionContextHandle,
  NodeExecutionEnvelope,
  NodeExecutionFunctionInvocation,
  NodeExecutionFunctionInvoker,
} from "./node-runtime.js";

const CLIENT_NAME = process.platform === "win32" ? "roster-tool.cmd" : "roster-tool";
const CLIENT_MODULE_NAME = "roster-tool.mjs";
const MAILBOX_SCAN_MIN_DELAY_MS = 50;
const MAILBOX_SCAN_MAX_DELAY_MS = 500;
const MAILBOX_SCAN_MAX_COUNT = 128;
const MAILBOX_SHUTDOWN_BUDGET_MS = 1_000;
const MAILBOX_JOB_CAPACITY = 128;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const REQUEST_FILENAME = new RegExp(`^request-(${UUID_PATTERN})\\.json$`, "u");
const ROSTER_MAILBOX_FILENAME = new RegExp(
  `^(?:request|response)-${UUID_PATTERN}\\.json(?:\\.pending)?$`,
  "u",
);
const GENERATION_MISMATCH_ERROR = "Roster code mode generation mismatch: execution generation is no longer active";

export type NodeCodeModeWatcher = {
  readonly close: () => void;
  on: (event: "error", listener: (error: Error) => void) => NodeCodeModeWatcher;
};

export type NodeCodeModeWatcherFactory = (
  directory: string,
  onEntry: (filename: string | Buffer | null) => void,
) => NodeCodeModeWatcher;

export type NodeCodeModeDirectoryReader = (
  directory: string,
) => Promise<ReadonlyArray<string>>;

export type NodeCodeModeFileRemover = (path: string) => Promise<void>;

export type NodeCodeModeScheduler = {
  readonly setTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly clearTimeout: (timer: NodeJS.Timeout) => void;
};

const defaultWatcherFactory: NodeCodeModeWatcherFactory = (directory, onEntry) =>
  watch(directory, (_event, filename) => onEntry(filename));

const snapshotEnvironment = (environment: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv => {
  const snapshot: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (key.includes("\0")) throw new Error("Node code mode environment names must not contain NUL");
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`Node code mode environment value ${key} must be a string`);
    }
    if (value?.includes("\0")) {
      throw new Error(`Node code mode environment value ${key} must not contain NUL`);
    }
    snapshot[key] = value;
  }
  return snapshot;
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const normalizeFailure = (error: unknown, message: string): Error & { readonly originalValue: unknown } => {
  if (error instanceof Error) {
    try {
      Object.defineProperty(error, "originalValue", {
        configurable: true,
        enumerable: false,
        value: error,
        writable: false,
      });
      return error as Error & { readonly originalValue: unknown };
    } catch {
      const wrapped = new Error(error.message || message, { cause: error });
      Object.defineProperty(wrapped, "originalValue", {
        configurable: false,
        enumerable: false,
        value: error,
        writable: false,
      });
      return wrapped as Error & { readonly originalValue: unknown };
    }
  }
  const normalized = new Error(message);
  Object.defineProperty(normalized, "originalValue", {
    configurable: false,
    enumerable: false,
    value: error,
    writable: false,
  });
  return normalized as Error & { readonly originalValue: unknown };
};

const throwPrimaryWithCleanup = (
  primary: unknown,
  cleanup: unknown,
  message: string,
): never => {
  const normalizedCleanup = normalizeFailure(cleanup, "Node code mode setup cleanup failed");
  if (primary !== null && (typeof primary === "object" || typeof primary === "function")) {
    try {
      Object.defineProperty(primary, "cleanupError", {
        configurable: true,
        enumerable: false,
        value: normalizedCleanup,
        writable: false,
      });
      throw primary;
    } catch (error) {
      if (error === primary) throw error;
    }
  }
  throw new AggregateError([primary, normalizedCleanup], message, { cause: primary });
};

type StoredContextValue = {
  readonly metadata: NodeExecutionContextHandle;
  readonly value: JsonValue;
};

type CodeModeRequest = (
  | { readonly op: "list" | "collect" }
  | {
      readonly op: "call";
      readonly functionId: string;
      readonly value: JsonValue;
      readonly action?: NodeExecutionFunctionInvocation["action"];
      readonly timeoutMs?: number;
    }
  | { readonly op: "read"; readonly handle: string }
  | {
      readonly op: "peek";
      readonly handle: string;
      readonly pointer?: string;
      readonly start?: number;
      readonly length?: number;
    }
  | {
      readonly op: "search";
      readonly handle: string;
      readonly query: string;
      readonly limit?: number;
    }
) & { readonly expectedGeneration?: string };

export type PreparedNodeCodeMode = {
  readonly envelope: NodeExecutionEnvelope;
  readonly environment: NodeJS.ProcessEnv;
  readonly clientDirectory: string;
  readonly close: () => Promise<void>;
};

const encodedBytes = (value: string): number => Buffer.byteLength(value, "utf8");

const jsonValue = (value: unknown, label: string): JsonValue => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`${label} is not JSON serializable`);
  return JSON.parse(encoded) as JsonValue;
};

const positiveInteger = (
  value: unknown,
  fallback: number,
  maximum: number,
): number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
  ? Math.min(value, maximum)
  : fallback;

const contextHandle = (
  executionId: string,
  label: string,
  value: JsonValue,
): NodeExecutionContextHandle => {
  const contentHash = hashCanonical(value);
  return {
    handle: `context_${hashCanonical({ executionId, label, contentHash }).slice(0, 28)}`,
    label,
    contentHash,
    byteLength: encodedBytes(JSON.stringify(value)),
  };
};

const jsonPointer = (value: JsonValue, pointer: string | undefined): JsonValue => {
  if (!pointer || pointer === "/") return value;
  if (!pointer.startsWith("/")) throw new Error("Context pointer must be a JSON Pointer beginning with /");
  let current: JsonValue = value;
  for (const encodedPart of pointer.slice(1).split("/")) {
    const part = encodedPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`Context pointer does not resolve at ${part}`);
      }
      current = current[index]!;
      continue;
    }
    if (!current || typeof current !== "object" || !(part in current)) {
      throw new Error(`Context pointer does not resolve at ${part}`);
    }
    current = (current as Readonly<Record<string, JsonValue>>)[part]!;
  }
  return current;
};

const resolveContextReferences = (
  value: JsonValue,
  get: (handle: string) => StoredContextValue,
  depth = 0,
): JsonValue => {
  if (depth > 32) throw new Error("Function input context references exceed maximum depth 32");
  if (Array.isArray(value)) {
    return value.map((item) => resolveContextReferences(item, get, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const object = value as Readonly<Record<string, JsonValue>>;
  const handle = object.$rosterContext;
  if (typeof handle === "string") {
    const pointer = object.pointer;
    if (pointer !== undefined && typeof pointer !== "string") {
      throw new Error("Function input context reference pointer must be a string");
    }
    return jsonPointer(get(handle).value, pointer);
  }
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [
    key,
    resolveContextReferences(item, get, depth + 1),
  ]));
};

const boundedText = (value: string, maxBytes: number): string => {
  if (encodedBytes(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && encodedBytes(value.slice(0, end)) > maxBytes) end -= 1;
  return value.slice(0, end);
};

const clientSource = (): string => `#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const mailboxDirectory = process.env.ROSTER_CODE_TOOL_MAILBOX_DIR;
const manifestPath = process.env.ROSTER_CODE_TOOL_MANIFEST;
const valueDirectory = process.env.ROSTER_CODE_TOOL_VALUE_DIR;
const markerPath = process.env.ROSTER_CODE_TOOL_MARKER;
const expectedGeneration = process.env.ROSTER_CODE_TOOL_GENERATION;
if ((!mailboxDirectory && !manifestPath) || !valueDirectory || !markerPath || !expectedGeneration) {
  process.stderr.write("roster-tool is available only inside a Roster code-mode execution\\n");
  process.exit(2);
}

const activeGeneration = async () => {
  try {
    const generation = await readFile(markerPath, "utf8");
    if (generation !== expectedGeneration) throw new Error("${GENERATION_MISMATCH_ERROR}");
    return generation;
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("${GENERATION_MISMATCH_ERROR}");
    throw error;
  }
};

const assertGeneration = async (generation) => {
  if (await activeGeneration() !== generation) throw new Error("${GENERATION_MISMATCH_ERROR}");
};

const contextPath = (handle) => {
  if (!/^context_[a-f0-9]{28}$/.test(handle)) throw new Error("Invalid Roster context handle");
  return join(valueDirectory, handle + ".json");
};

const localRequest = async (payload) => {
  const generation = await activeGeneration();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await assertGeneration(generation);
  if (payload.op === "list") return manifest;
  if (payload.op === "collect") {
    await assertGeneration(generation);
    return { contextValues: manifest.contextValues };
  }
  const context = manifest.contextValues.find((candidate) => candidate.handle === payload.handle);
  if (!context) throw new Error("Unknown context handle " + payload.handle);
  const path = contextPath(payload.handle);
  const value = JSON.parse(await readFile(path, "utf8"));
  await assertGeneration(generation);
  if (payload.op === "read") return { context, value, path };
  const selected = (() => {
    if (!payload.pointer || payload.pointer === "/") return value;
    if (!payload.pointer.startsWith("/")) throw new Error("Context pointer must begin with /");
    let current = value;
    for (const encodedPart of payload.pointer.slice(1).split("/")) {
      const part = encodedPart.replace(/~1/g, "/").replace(/~0/g, "~");
      if (Array.isArray(current)) current = current[Number(part)];
      else if (current && typeof current === "object" && part in current) current = current[part];
      else throw new Error("Context pointer does not resolve at " + part);
    }
    return current;
  })();
  const serialized = typeof selected === "string" ? selected : JSON.stringify(selected);
  if (payload.op === "peek") {
    const start = Number.isSafeInteger(payload.start) && payload.start > 0 ? payload.start : 0;
    const requested = Number.isSafeInteger(payload.length) && payload.length > 0
      ? payload.length
      : manifest.limits.maxObservationBytes;
    const length = Math.min(requested, manifest.limits.maxObservationBytes);
    const observation = serialized.slice(start, start + length);
    return {
      context,
      pointer: payload.pointer || "/",
      start,
      observation,
      truncated: start + observation.length < serialized.length,
    };
  }
  if (payload.op === "search") {
    if (!payload.query) throw new Error("Context search requires a non-empty literal query");
    const limit = Number.isSafeInteger(payload.limit) && payload.limit > 0 ? Math.min(payload.limit, 50) : 10;
    const matches = [];
    let cursor = 0;
    while (matches.length < limit) {
      const index = serialized.indexOf(payload.query, cursor);
      if (index < 0) break;
      const start = Math.max(0, index - 160);
      matches.push({
        index,
        excerpt: serialized.slice(start, index + payload.query.length + 320)
          .slice(0, Math.min(manifest.limits.maxObservationBytes, 2048)),
      });
      cursor = index + Math.max(1, payload.query.length);
    }
    return { context, query: payload.query, matches };
  }
  throw new Error("Unsupported local Roster code tool operation " + payload.op);
};

const parseResponse = (response) => {
  const parsed = JSON.parse(response);
  if (!parsed.ok) throw new Error(parsed.error || "Roster code tool failed");
  return parsed.result;
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const mailboxRequest = async (payload) => {
  const generation = await activeGeneration();
  const requestId = randomUUID();
  const requestPath = join(mailboxDirectory, "request-" + requestId + ".json");
  const pendingPath = requestPath + ".pending";
  const responsePath = join(mailboxDirectory, "response-" + requestId + ".json");
  try {
    await writeFile(
      pendingPath,
      JSON.stringify({ ...payload, expectedGeneration }) + "\\n",
      { mode: 0o600, flag: "wx" },
    );
    await rename(pendingPath, requestPath);
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      try {
        await assertGeneration(generation);
        const response = await readFile(responsePath, "utf8");
        await unlink(responsePath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        return parseResponse(response);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await delay(10);
      }
    }
    throw new Error("Roster code tool request timed out waiting for its execution mailbox");
  } finally {
    await Promise.all([
      unlink(requestPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
      unlink(pendingPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
      unlink(responsePath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
    ]);
  }
};

const request = (payload) => manifestPath && payload.op !== "call"
  ? localRequest(payload)
  : mailboxRequest(payload);

const [command = "list", ...args] = process.argv.slice(2);
let payload;
if (command === "list" || command === "collect") {
  payload = { op: command };
} else if (command === "call") {
  const [functionId, action = "await"] = args;
  if (!functionId) throw new Error("usage: roster-tool call <function-id> [await|void|enqueue]");
  const input = readFileSync(0, "utf8").trim();
  payload = {
    op: "call",
    functionId,
    value: input ? JSON.parse(input) : null,
    action: { kind: action },
  };
} else if (command === "materialize") {
  const [handle, requestedName] = args;
  if (!handle) throw new Error("usage: roster-tool materialize <handle> [filename]");
  const result = await request({ op: "read", handle });
  if (!requestedName && result.path) {
    process.stdout.write(JSON.stringify({
      status: "materialized",
      context: result.context,
      path: result.path,
      byteLength: result.context.byteLength,
    }) + "\\n");
    process.exit(0);
  }
  const filename = requestedName ? basename(requestedName) : handle + ".json";
  const path = join(valueDirectory, filename);
  const encoded = JSON.stringify(result.value);
  writeFileSync(path, encoded);
  process.stdout.write(JSON.stringify({
    status: "materialized",
    context: result.context,
    path,
    byteLength: Buffer.byteLength(encoded),
  }) + "\\n");
  process.exit(0);
} else if (command === "peek") {
  const [handle, pointer = "/", start = "0", length] = args;
  if (!handle) throw new Error("usage: roster-tool peek <handle> [json-pointer] [start] [length]");
  payload = {
    op: "peek",
    handle,
    pointer,
    start: Number(start),
    ...(length !== undefined ? { length: Number(length) } : {}),
  };
} else if (command === "search") {
  const [handle, query, limit] = args;
  if (!handle || !query) throw new Error("usage: roster-tool search <handle> <literal-query> [limit]");
  payload = {
    op: "search",
    handle,
    query,
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
  };
} else {
  throw new Error("usage: roster-tool <list|call|collect|materialize|peek|search>");
}

try {
  const result = await request(payload);
  process.stdout.write(JSON.stringify(result) + "\\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");
  process.exit(1);
}
`;

const writeClient = async (directory: string): Promise<void> => {
  const modulePath = join(directory, CLIENT_MODULE_NAME);
  await writeFile(modulePath, clientSource(), { encoding: "utf8", mode: 0o700 });
  await chmod(modulePath, 0o700);
  if (process.platform === "win32") {
    await writeFile(
      join(directory, CLIENT_NAME),
      `@echo off\r\n"${process.execPath}" "${modulePath}" %*\r\n`,
      { encoding: "utf8" },
    );
    return;
  }
  await writeFile(
    join(directory, CLIENT_NAME),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(modulePath)} "$@"\n`,
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(join(directory, CLIENT_NAME), 0o700);
};

/**
 * Creates one execution-scoped code environment. A private filesystem mailbox
 * transports calls across restrictive runtime sandboxes. The supplied invoker
 * remains the Roster-owned scheduling and authorization boundary. Completed
 * function bodies are retained as handles and never returned by `call`.
 */
export const prepareNodeCodeMode = async (input: {
  readonly envelope: NodeExecutionEnvelope;
  readonly invokeFunction?: NodeExecutionFunctionInvoker;
  readonly signal?: AbortSignal;
  /** Reuse an adapter-owned private directory when one already exists. */
  readonly directory?: string;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly watcherFactory?: NodeCodeModeWatcherFactory;
  readonly directoryReader?: NodeCodeModeDirectoryReader;
  readonly removeFile?: NodeCodeModeFileRemover;
  readonly scheduler?: NodeCodeModeScheduler;
}): Promise<PreparedNodeCodeMode> => {
  const codeMode = input.envelope.surface.codeMode;
  if (!codeMode) throw new Error("Node code mode preparation requires a code-mode envelope");
  // Snapshot enumerable values before allocating a generation. Besides
  // validating values accepted by child_process, this ensures a throwing
  // environment getter cannot strand generation-owned input on disk.
  const baseEnvironment = snapshotEnvironment(input.baseEnvironment);
  const ownsDirectory = !input.directory;
  const directory = input.directory ?? await mkdtemp(join(tmpdir(), "roster-code-mode-"));
  // Establish cleanup ownership immediately after mkdtemp allocates an owned
  // generation. A supplied parent is never cleanup-owned.
  let generationDirectory: string | undefined = ownsDirectory ? directory : undefined;
  let generationActive = true;
  let stopOwnedSetup = (): void => {
    generationActive = false;
  };
  let settleOwnedSetup = (): Promise<unknown> => Promise.resolve();
  let setupCleanupPromise: Promise<void> | undefined;
  const cleanupOwnedSetup = (): Promise<void> => {
    setupCleanupPromise ??= (async (): Promise<void> => {
      stopOwnedSetup();
      let cleanupError: unknown;
      let hasCleanupError = false;
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        settleOwnedSetup().then(
          () => ({ settled: true as const }),
          (error: unknown) => ({ settled: true as const, error }),
        ),
        new Promise<{ readonly settled: false }>((resolve) => {
          timer = setTimeout(() => resolve({ settled: false }), MAILBOX_SHUTDOWN_BUDGET_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!outcome.settled) {
        hasCleanupError = true;
        cleanupError = new Error(
          `Roster code mode setup cleanup did not settle before shutdown budget=${MAILBOX_SHUTDOWN_BUDGET_MS}ms`,
        );
      } else if ("error" in outcome) {
        hasCleanupError = true;
        cleanupError = outcome.error;
      }
      try {
        if (generationDirectory) {
          await rm(generationDirectory, { recursive: true, force: true });
        }
      } catch (error) {
        if (!hasCleanupError) {
          hasCleanupError = true;
          cleanupError = error;
        }
      }
      if (hasCleanupError) throw cleanupError;
    })();
    return setupCleanupPromise;
  };

  try {
    const generation = randomUUID();
    // A supplied adapter directory may be reused while an older generation is
    // still draining. Keep every path owned by this generation so an old
    // timeout/cleanup can never unlink a newer generation's resources.
    generationDirectory = ownsDirectory
      ? directory
      : join(directory, `.roster-code-mode-${generation}`);
    const activeGenerationDirectory = generationDirectory;
    const valueDirectory = join(activeGenerationDirectory, "values");
    const mailboxDirectory = join(activeGenerationDirectory, "mailbox");
    const manifestPath = join(activeGenerationDirectory, "manifest.json");
    const markerPath = join(activeGenerationDirectory, ".roster-code-mode");
    await mkdir(activeGenerationDirectory, { recursive: true, mode: 0o700 });
    await writeFile(markerPath, generation, {
      encoding: "utf8",
      mode: 0o600,
    });
    await mkdir(valueDirectory, { recursive: true, mode: 0o700 });
    await mkdir(mailboxDirectory, { recursive: true, mode: 0o700 });
    await writeClient(activeGenerationDirectory);

  const values = new Map<string, StoredContextValue>();
  const activeInvocations = new Set<AbortController>();
  let totalContextBytes = 0;
  let functionCalls = 0;
  let persistManifest = (): void => undefined;

  const assertGenerationActive = (): void => {
    if (!generationActive) throw new Error(GENERATION_MISMATCH_ERROR);
  };

  const store = (label: string, raw: unknown): NodeExecutionContextHandle => {
    assertGenerationActive();
    const value = jsonValue(raw, `Context value ${label}`);
    const metadata = contextHandle(input.envelope.executionId, label, value);
    if (metadata.byteLength > codeMode.maxValueBytes) {
      throw new Error(`Context value ${label} exceeded maxValueBytes=${codeMode.maxValueBytes}`);
    }
    const existing = values.get(metadata.handle);
    if (existing) return existing.metadata;
    if (values.size >= codeMode.maxContextValues) {
      throw new Error(`Node code mode reached maxContextValues=${codeMode.maxContextValues}`);
    }
    if (totalContextBytes + metadata.byteLength > codeMode.maxContextBytes) {
      throw new Error(`Node code mode exceeded maxContextBytes=${codeMode.maxContextBytes}`);
    }
    assertGenerationActive();
    values.set(metadata.handle, { metadata, value });
    writeFileSync(join(valueDirectory, `${metadata.handle}.json`), JSON.stringify(value), {
      encoding: "utf8",
      mode: 0o600,
    });
    totalContextBytes += metadata.byteLength;
    assertGenerationActive();
    persistManifest();
    return metadata;
  };

  let inputHandle: NodeExecutionContextHandle | undefined;
  inputHandle = input.envelope.input !== undefined
    ? store("task.input", input.envelope.input)
    : undefined;
  const projectedTools = new Map(input.envelope.surface.tools.map((tool) => [tool.id, tool]));
  const metadata = (): ReadonlyArray<NodeExecutionContextHandle> =>
    [...values.values()].map((entry) => entry.metadata).sort((left, right) => left.handle.localeCompare(right.handle));
  persistManifest = (): void => {
    assertGenerationActive();
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: codeMode.schemaVersion,
      tools: [...projectedTools.values()],
      contextValues: metadata(),
      limits: codeMode,
    }), {
      encoding: "utf8",
      mode: 0o600,
    });
  };
  persistManifest();
  const stored = (handle: string): StoredContextValue => {
    const value = values.get(handle);
    if (!value) throw new Error(`Unknown context handle ${handle}`);
    return value;
  };
  const runRequest = async (request: CodeModeRequest): Promise<unknown> => {
    if (!request || typeof request !== "object" || typeof request.op !== "string") {
      throw new Error("Roster code tool request requires an operation");
    }
    if (request.op === "list") {
      return {
        schemaVersion: codeMode.schemaVersion,
        tools: [...projectedTools.values()],
        contextValues: metadata(),
        limits: codeMode,
      };
    }
    if (request.op === "collect") return { contextValues: metadata() };
    if (request.op === "read") {
      const entry = stored(request.handle);
      return { context: entry.metadata, value: entry.value };
    }
    if (request.op === "peek") {
      const entry = stored(request.handle);
      const selected = jsonPointer(entry.value, request.pointer);
      const serialized = typeof selected === "string" ? selected : JSON.stringify(selected);
      const start = Math.max(0, positiveInteger(request.start, 0, serialized.length));
      const requestedLength = positiveInteger(
        request.length,
        codeMode.maxObservationBytes,
        codeMode.maxObservationBytes,
      );
      const observation = boundedText(serialized.slice(start), requestedLength);
      return {
        context: entry.metadata,
        pointer: request.pointer ?? "/",
        start,
        observation,
        truncated: start + observation.length < serialized.length,
      };
    }
    if (request.op === "search") {
      const query = typeof request.query === "string" ? request.query : "";
      if (!query) throw new Error("Context search requires a non-empty literal query");
      const entry = stored(request.handle);
      const serialized = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
      const limit = positiveInteger(request.limit, 10, 50);
      const matches: Array<{ readonly index: number; readonly excerpt: string }> = [];
      let cursor = 0;
      while (matches.length < limit) {
        const index = serialized.indexOf(query, cursor);
        if (index < 0) break;
        const excerptStart = Math.max(0, index - 160);
        matches.push({
          index,
          excerpt: boundedText(
            serialized.slice(excerptStart, index + query.length + 320),
            Math.min(codeMode.maxObservationBytes, 2_048),
          ),
        });
        cursor = index + Math.max(1, query.length);
      }
      return { context: entry.metadata, query, matches };
    }
    if (request.op === "call") {
      if (!input.invokeFunction) throw new Error("This execution has no callable Roster functions");
      if (typeof request.functionId !== "string" || !projectedTools.has(request.functionId)) {
        throw new Error(`Function ${String(request.functionId)} is not projected for this node`);
      }
      const requestedAction = (request as {
        readonly action?: { readonly kind?: unknown };
      }).action;
      const actionKind = requestedAction?.kind;
      if (
        actionKind !== undefined
        && actionKind !== "await"
        && actionKind !== "void"
        && actionKind !== "enqueue"
      ) {
        throw new Error(`Unsupported Roster function action ${String(actionKind)}`);
      }
      if (functionCalls >= codeMode.maxFunctionCalls) {
        throw new Error(`Node code mode reached maxFunctionCalls=${codeMode.maxFunctionCalls}`);
      }
      functionCalls += 1;
      const controller = new AbortController();
      const abort = (): void => controller.abort(
        input.signal?.reason instanceof Error ? input.signal.reason : new Error("Node code mode was aborted"),
      );
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
      activeInvocations.add(controller);
      try {
        const result = await input.invokeFunction({
          functionId: request.functionId,
          value: resolveContextReferences(
            jsonValue(request.value, `Function ${request.functionId} input`),
            stored,
          ),
          ...(actionKind ? { action: { kind: actionKind } } : {}),
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        }, {
          executionId: input.envelope.executionId,
          runId: input.envelope.runId,
          nodeId: input.envelope.node.id,
          taskId: input.envelope.task.taskId,
          ...(input.envelope.trace ? { trace: input.envelope.trace } : {}),
          signal: controller.signal,
        });
        if (result.status !== "completed") return result;
        const context = store(`function:${request.functionId}:${functionCalls}`, result.output);
        return {
          status: result.status,
          functionId: result.functionId,
          providerId: result.providerId,
          context,
        };
      } finally {
        activeInvocations.delete(controller);
        input.signal?.removeEventListener("abort", abort);
      }
    }
    throw new Error(`Unsupported Roster code tool operation ${String((request as { readonly op?: unknown }).op)}`);
  };

  let mailboxClosed = false;
  let mailboxFailure: unknown;
  let hasMailboxFailure = false;
  let markerInvalidation: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let mailboxWatcher: NodeCodeModeWatcher | undefined;
  let mailboxWatcherCloseError: unknown;
  let hasMailboxWatcherCloseError = false;
  let fallbackStarted = false;
  let fallbackTimer: NodeJS.Timeout | undefined;
  let scanInFlight = false;
  let scanPromise: Promise<void> | undefined;
  let scanDelayMs = MAILBOX_SCAN_MIN_DELAY_MS;
  let scanCount = 0;
  const mailboxJobs = new Set<Promise<void>>();
  const activeMailboxFiles = new Set<string>();
  let triggerEventualCleanup: () => void = () => undefined;
  const directoryReader = input.directoryReader ?? (async (path: string) => readdir(path));
  const removeFile = input.removeFile ?? (async (path: string) => unlink(path));
  const scheduler = input.scheduler ?? {
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer),
  };

  const unlinkIfPresent = async (path: string): Promise<void> => {
    await removeFile(path).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  };
  const clearFallbackTimer = (): void => {
    if (fallbackTimer) scheduler.clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
  };
  const invalidateMarker = (): void => {
    markerInvalidation ??= unlinkIfPresent(markerPath);
    void markerInvalidation.catch(() => undefined);
  };
  const closeMailboxWatcher = (): void => {
    const watcher = mailboxWatcher;
    mailboxWatcher = undefined;
    if (!watcher) return;
    try {
      watcher.close();
    } catch (error) {
      if (!hasMailboxWatcherCloseError) {
        hasMailboxWatcherCloseError = true;
        mailboxWatcherCloseError = error;
      }
    }
  };
  const failMailbox = (error: unknown): void => {
    if (!hasMailboxFailure) {
      hasMailboxFailure = true;
      mailboxFailure = normalizeFailure(error, "Roster code mode mailbox failed");
    }
    generationActive = false;
    mailboxClosed = true;
    clearFallbackTimer();
    closeMailboxWatcher();
    invalidateMarker();
    for (const controller of activeInvocations) {
      controller.abort(error instanceof Error ? error : new Error("Node code mode failed"));
    }
  };
  const stopMailbox = (): void => {
    generationActive = false;
    mailboxClosed = true;
    clearFallbackTimer();
    closeMailboxWatcher();
    invalidateMarker();
    for (const controller of activeInvocations) {
      controller.abort(new Error("Node code mode execution ended"));
    }
  };
  stopOwnedSetup = stopMailbox;
  settleOwnedSetup = async () => {
    await Promise.all([
      markerInvalidation ?? Promise.resolve(),
      scanPromise ?? Promise.resolve(),
      ...mailboxJobs,
    ]);
    if (hasMailboxWatcherCloseError) throw mailboxWatcherCloseError;
  };

  const serveMailboxFile = async (filename: string): Promise<void> => {
    const match = REQUEST_FILENAME.exec(filename);
    if (!match || mailboxClosed) return;
    const requestPath = join(mailboxDirectory, filename);
    const responsePath = join(mailboxDirectory, `response-${match[1]}.json`);
    let response: unknown;
    try {
      const body = await readFile(requestPath, "utf8");
      if (encodedBytes(body) > codeMode.maxRequestBytes) {
        throw new Error(`Roster code tool request exceeded maxRequestBytes=${codeMode.maxRequestBytes}`);
      }
      const request = JSON.parse(body.trim()) as CodeModeRequest;
      if (request.expectedGeneration !== generation) throw new Error(GENERATION_MISMATCH_ERROR);
      const marker = await readFile(markerPath, "utf8").catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") throw new Error(GENERATION_MISMATCH_ERROR);
        throw error;
      });
      if (marker !== generation) throw new Error(GENERATION_MISMATCH_ERROR);
      assertGenerationActive();
      response = { ok: true, result: await runRequest(request) };
      assertGenerationActive();
      const finalMarker = await readFile(markerPath, "utf8").catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") throw new Error(GENERATION_MISMATCH_ERROR);
        throw error;
      });
      if (finalMarker !== generation) throw new Error(GENERATION_MISMATCH_ERROR);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      response = { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await unlinkIfPresent(requestPath);
    }
    if (mailboxClosed || !generationActive) return;
    const pendingPath = `${responsePath}.pending`;
    try {
      await writeFile(pendingPath, `${JSON.stringify(response)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      // A pre-existing exact pending response is still owned mailbox state;
      // leave it for bounded shutdown cleanup instead of turning it into a
      // false mailbox failure.
      if (errorCode(error) === "EEXIST") return;
      throw error;
    }
    if (mailboxClosed || !generationActive) {
      await unlinkIfPresent(pendingPath);
      return;
    }
    await rename(pendingPath, responsePath);
  };
  const scheduleMailboxFile = (filename: string | Buffer | null): void => {
    const normalized = typeof filename === "string" ? filename : filename?.toString("utf8");
    if (!normalized || !REQUEST_FILENAME.test(normalized) || mailboxClosed || activeMailboxFiles.has(normalized)) return;
    if (mailboxJobs.size >= MAILBOX_JOB_CAPACITY) {
      failMailbox(new Error(`Roster code mode exceeded mailbox job capacity=${MAILBOX_JOB_CAPACITY}`));
      return;
    }
    activeMailboxFiles.add(normalized);
    let job: Promise<void>;
    job = serveMailboxFile(normalized)
      .catch((error: unknown) => failMailbox(error))
      .finally(() => {
        mailboxJobs.delete(job);
        activeMailboxFiles.delete(normalized);
        triggerEventualCleanup();
      });
    mailboxJobs.add(job);
  };

  const scanMailboxDirectory = (): Promise<void> => {
    if (mailboxClosed || scanCount >= MAILBOX_SCAN_MAX_COUNT) return Promise.resolve();
    if (scanInFlight) return scanPromise ?? Promise.resolve();
    scanInFlight = true;
    scanCount += 1;
    const current = (async (): Promise<void> => {
      try {
        const filenames = await directoryReader(mailboxDirectory);
        if (mailboxClosed) return;
        for (const filename of filenames) scheduleMailboxFile(filename);
      } catch (error) {
        failMailbox(error);
        throw error;
      } finally {
        scanInFlight = false;
        if (!mailboxClosed && scanCount >= MAILBOX_SCAN_MAX_COUNT) {
          failMailbox(new Error(
            `Roster code mode mailbox scan exhausted scanCount=${MAILBOX_SCAN_MAX_COUNT}`,
          ));
        } else if (!mailboxClosed && scanCount < MAILBOX_SCAN_MAX_COUNT && !fallbackTimer) {
          const nextDelayMs = scanDelayMs;
          scanDelayMs = Math.min(scanDelayMs * 2, MAILBOX_SCAN_MAX_DELAY_MS);
          fallbackTimer = scheduler.setTimeout(() => {
            fallbackTimer = undefined;
            void scanMailboxDirectory().catch(() => undefined);
          }, nextDelayMs);
          fallbackTimer.unref();
        }
        triggerEventualCleanup();
      }
    })();
    scanPromise = current;
    void current.finally(() => {
      if (scanPromise === current) scanPromise = undefined;
    }).catch(() => undefined);
    return current;
  };
  const startFallback = (): void => {
    if (mailboxClosed || fallbackStarted) return;
    fallbackStarted = true;
    scanDelayMs = MAILBOX_SCAN_MIN_DELAY_MS;
    void scanMailboxDirectory().catch(() => undefined);
  };
  const watcherError = (error: Error): void => {
    const code = errorCode(error);
    if (mailboxClosed) {
      if (code !== "EMFILE" && code !== "ENOSPC") failMailbox(error);
      return;
    }
    if (code === "EMFILE" || code === "ENOSPC") {
      if (!fallbackStarted) {
        closeMailboxWatcher();
        startFallback();
      }
      return;
    }
    failMailbox(error);
  };
  const watcherFactory = input.watcherFactory ?? defaultWatcherFactory;
  try {
    mailboxWatcher = watcherFactory(mailboxDirectory, scheduleMailboxFile);
    mailboxWatcher.on("error", watcherError);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EMFILE" || code === "ENOSPC") {
      startFallback();
    } else {
      failMailbox(error);
      throw error;
    }
  }

  const modelCodeMode = {
    ...codeMode,
    command: "roster-tool" as const,
    contextValues: metadata(),
  };
  const envelope: NodeExecutionEnvelope = {
    ...input.envelope,
    ...(inputHandle
      ? {
          input: {
            contextHandle: inputHandle.handle,
            contentHash: inputHandle.contentHash,
            byteLength: inputHandle.byteLength,
          },
        }
      : {}),
    surface: createNodeExecutionSurface({
      skills: input.envelope.surface.skills,
      tools: input.envelope.surface.tools,
      workspace: input.envelope.surface.workspace,
      codeMode: modelCodeMode,
    }),
  };
  const path = [activeGenerationDirectory, baseEnvironment.PATH, process.env.PATH]
    .filter((entry): entry is string => Boolean(entry))
    .join(delimiter);
  return {
    envelope,
    clientDirectory: activeGenerationDirectory,
    environment: {
      ...baseEnvironment,
      PATH: path,
      ROSTER_CODE_TOOL_MAILBOX_DIR: mailboxDirectory,
      ROSTER_CODE_TOOL_MANIFEST: manifestPath,
      ROSTER_CODE_TOOL_GENERATION: generation,
      ROSTER_CODE_TOOL_MARKER: markerPath,
      ROSTER_CODE_TOOL_VALUE_DIR: valueDirectory,
    },
    close: (() => {
      let cleanupExactPromise: Promise<void> | undefined;
      let directoryCleanupPromise: Promise<void> | undefined;
      let cleanupRequested = false;
      let eventualCleanupStarted = false;
      const onAbort = (): void => {
        stopMailbox();
        void close().catch(() => undefined);
      };
      const cleanupExactContents = async (): Promise<void> => {
        await Promise.all([
          unlinkIfPresent(markerPath),
          unlinkIfPresent(manifestPath),
          unlinkIfPresent(join(activeGenerationDirectory, CLIENT_MODULE_NAME)),
          unlinkIfPresent(join(activeGenerationDirectory, CLIENT_NAME)),
          ...[...values.keys()].map((handle) => unlinkIfPresent(join(valueDirectory, `${handle}.json`))),
        ]);
        let filenames: ReadonlyArray<string>;
        try {
          filenames = await directoryReader(mailboxDirectory);
        } catch (error) {
          // Generation-owned recursive removal may win this teardown-time
          // read. The pre-close scan above remains strict about ENOENT.
          if (errorCode(error) === "ENOENT") return;
          throw error;
        }
        await Promise.all(
          filenames
            .filter((filename) => ROSTER_MAILBOX_FILENAME.test(filename))
            .map((filename) => unlinkIfPresent(join(mailboxDirectory, filename))),
        );
      };
      const startExactCleanup = (): Promise<void> => {
        cleanupExactPromise ??= cleanupExactContents();
        cleanupExactPromise.catch(() => undefined);
        return cleanupExactPromise;
      };
      const startDirectoryCleanup = (): Promise<void> => {
        directoryCleanupPromise ??= rm(activeGenerationDirectory, { recursive: true, force: true });
        directoryCleanupPromise.catch(() => undefined);
        return directoryCleanupPromise;
      };
      const startEventualCleanup = (): void => {
        if (!cleanupRequested || eventualCleanupStarted || scanInFlight || mailboxJobs.size > 0) return;
        eventualCleanupStarted = true;
        void Promise.allSettled([
          scanPromise ?? Promise.resolve(),
          ...mailboxJobs,
        ]).then(() => {
          // Directory removal is generation-owned and must not wait for exact
          // cleanup. An adapter cleanup hook or directory reader may never
          // settle, while the owned generation must still be reclaimed.
          void startDirectoryCleanup().catch(() => undefined);
          void startExactCleanup().catch(() => undefined);
        });
      };
      triggerEventualCleanup = startEventualCleanup;
      const closeMode = async (): Promise<void> => {
        const deadline = Date.now() + MAILBOX_SHUTDOWN_BUDGET_MS;
        cleanupRequested = true;
        stopMailbox();
        let hasCloseError = false;
        let closeError: unknown;
        const recordCloseError = (error: unknown, label: string): void => {
          if (hasCloseError) return;
          hasCloseError = true;
          closeError = error instanceof Error
            ? error
            : normalizeFailure(error, `Roster code mode ${label} failed`);
        };
        if (hasMailboxFailure && hasMailboxWatcherCloseError) {
          try {
            throwPrimaryWithCleanup(
              mailboxFailure,
              mailboxWatcherCloseError,
              "Node code mode mailbox and watcher cleanup both failed",
            );
          } catch (error) {
            recordCloseError(error, "mailbox failure");
          }
        } else if (hasMailboxWatcherCloseError) {
          recordCloseError(mailboxWatcherCloseError, "mailbox watcher close");
        }
        const waitWithinBudget = async (promise: Promise<unknown>, label: string): Promise<boolean> => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            recordCloseError(new Error(
              `Roster code mode ${label} did not settle before shutdown budget=${MAILBOX_SHUTDOWN_BUDGET_MS}ms`,
            ), label);
            return false;
          }
          let timer: NodeJS.Timeout | undefined;
          const outcome = await Promise.race([
            promise.then(
              () => ({ settled: true as const }),
              (error: unknown) => ({ settled: true as const, error }),
            ),
            new Promise<{ readonly settled: false }>((resolve) => {
              timer = setTimeout(() => resolve({ settled: false }), remaining);
            }),
          ]);
          if (timer) clearTimeout(timer);
          if (!outcome.settled) {
            recordCloseError(new Error(
              `Roster code mode ${label} did not settle before shutdown budget=${MAILBOX_SHUTDOWN_BUDGET_MS}ms`,
            ), label);
            return false;
          }
          if ("error" in outcome) recordCloseError(outcome.error, label);
          return true;
        };

        const markerSettled = await waitWithinBudget(
          markerInvalidation ?? Promise.resolve(),
          "marker invalidation",
        );
        const scan = scanPromise;
        const scanSettled = await waitWithinBudget(scan ?? Promise.resolve(), "mailbox scan");
        const jobs = [...mailboxJobs];
        const jobsSettled = await waitWithinBudget(Promise.allSettled(jobs), "mailbox jobs");
        // Start cleanup only after tracked work has drained. If the deadline
        // expires first, the same operations are started by the eventual,
        // generation-owned cleanup trigger once the work settles.
        if (markerSettled && scanSettled && jobsSettled) {
          const exactCleanup = startExactCleanup();
          // Start directory removal at the same scan/job-settled boundary;
          // exact cleanup may be held by an adapter hook or reader forever.
          const directoryCleanup = startDirectoryCleanup();
          await waitWithinBudget(exactCleanup, "exact cleanup");
          await waitWithinBudget(directoryCleanup, "directory cleanup");
        } else {
          triggerEventualCleanup();
        }
        if (hasMailboxFailure && !hasMailboxWatcherCloseError) {
          recordCloseError(mailboxFailure, "mailbox failure");
        }
        if (hasCloseError) throw closeError;
      };
      const close = (): Promise<void> => {
        closePromise ??= closeMode().finally(() => {
          input.signal?.removeEventListener("abort", onAbort);
          startEventualCleanup();
        });
        return closePromise;
      };
      if (input.signal?.aborted) onAbort();
      else input.signal?.addEventListener("abort", onAbort, { once: true });
      return close;
    })(),
  };
  } catch (error) {
    try {
      await cleanupOwnedSetup();
    } catch (cleanupError) {
      throwPrimaryWithCleanup(
        error,
        cleanupError,
        "Node code mode setup and cleanup both failed",
      );
    }
    throw error;
  }
};

export const executeWithPreparedNodeCodeMode = async <Output>(
  prepared: { readonly close: () => Promise<void> } | undefined,
  execute: () => Promise<Output>,
): Promise<Output> => {
  const dualFailure = (primary: unknown, cleanup: unknown): AggregateError => {
    const aggregate = new AggregateError(
      [primary, cleanup],
      "Node execution and code-mode cleanup both failed",
      { cause: primary },
    );
    Object.defineProperties(aggregate, {
      primaryError: { configurable: false, enumerable: false, value: primary, writable: false },
      cleanupError: { configurable: false, enumerable: false, value: cleanup, writable: false },
    });
    return aggregate;
  };
  let primaryThrown = false;
  let primaryError: unknown;
  try {
    return await execute();
  } catch (error) {
    primaryThrown = true;
    primaryError = error;
    throw error;
  } finally {
    if (prepared) {
      try {
        await prepared.close();
      } catch (cleanupError) {
        if (!primaryThrown) throw cleanupError;
        if (primaryError !== null && (typeof primaryError === "object" || typeof primaryError === "function")) {
          try {
            Object.defineProperty(primaryError, "cleanupError", {
              configurable: true,
              enumerable: false,
              value: cleanupError,
              writable: false,
            });
          } catch {
            // Frozen and otherwise non-extensible primary values use the stable wrapper below.
            throw dualFailure(primaryError, cleanupError);
          }
        } else {
          throw dualFailure(primaryError, cleanupError);
        }
      }
    }
  }
};
