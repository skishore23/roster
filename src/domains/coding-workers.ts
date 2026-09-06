import { realpath, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { hashCanonical } from "../core/canonical.js";
import type {
  RosterFunctionDescriptor,
  RosterFunctionDirectory,
  RosterFunctionProviderControl,
} from "../engine/functions/function-directory.js";
import type { JsonValue } from "../engine/orchestration/types.js";
import type { CommandRunner } from "../engine/runtime/command-node-runtime.js";
import {
  CODING_DEPENDENCY_RESOLUTION_OPERATION,
  createRepositoryDependencyResolver,
} from "../engine/runtime/repository-dependency-worker.js";
import type { RepositoryExecutionProfile } from "../engine/runtime/repository-toolchain.js";
import {
  CODING_CHANGE_FRONTIER_FUNCTION_ID,
  CODING_CHANGE_FRONTIER_SCHEMA,
  captureCodingChangeFrontier,
} from "./coding-change-frontier.js";
import {
  CODING_ROOM_POST_UPDATE_FUNCTION_ID,
  CODING_ROOM_UPDATE_SCOPE,
  type CodingRoomUpdateProviderOptions,
} from "./coding-room-updates.js";

export const CODING_WORKSPACE_READ_FUNCTION_ID = "coding::workspace.read" as const;
export const CODING_WORKSPACE_SEARCH_FUNCTION_ID = "coding::workspace.search" as const;
export const CODING_JSON_GET_FUNCTION_ID = "coding::json.get" as const;
export const CODING_TEXT_SPLIT_FUNCTION_ID = "coding::text.split" as const;
export const CODING_TEXT_FILTER_FUNCTION_ID = "coding::text.filter" as const;
export const CODING_TEXT_JOIN_FUNCTION_ID = "coding::text.join" as const;
export const CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID =
  "coding::repository.dependencies.resolve" as const;

const MAX_FILE_BYTES = 4 * 1_048_576;
const MAX_SEARCH_BYTES = 16 * 1_048_576;
const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_RESULTS = 100;
const MAX_TEXT_BYTES = 4 * 1_048_576;
const MAX_TEXT_VALUES = 4_096;
const MAX_JSON_POINTER_LENGTH = 2_048;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

const objectValue = (
  value: JsonValue,
  label = "Coding worker input",
): Readonly<Record<string, JsonValue>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, JsonValue>>;
};

const fencedMetadataString = (
  control: RosterFunctionProviderControl,
  key: "roster_run_id" | "roster_task_id" | "roster_execution_id",
): string => {
  const value = control.metadata?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Coding room update requires fenced ${key} metadata`);
  }
  return value;
};

const requiredString = (
  value: JsonValue | undefined,
  label: string,
  maximumBytes: number,
  trim = true,
): string => {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = trim ? value.trim() : value;
  if (trim && !normalized) throw new Error(`${label} is required`);
  if (Buffer.byteLength(normalized) > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  return normalized;
};

const optionalString = (
  value: JsonValue | undefined,
  fallback: string,
  label: string,
  maximumBytes: number,
): string => value === undefined
  ? fallback
  : requiredString(value, label, maximumBytes, false);

const boundedInteger = (
  value: JsonValue | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number => {
  const candidate = value ?? fallback;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return Math.max(minimum, Math.min(maximum, candidate));
};

const assertActive = (control: RosterFunctionProviderControl): void => {
  if (control.signal.aborted) throw control.signal.reason ?? new Error("Coding worker invocation aborted");
};

const assertWithinRoot = (root: string, candidate: string): void => {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === ".."
    || pathFromRoot.startsWith(`..${sep}`)
    || isAbsolute(pathFromRoot)
  ) {
    throw new Error("Coding workspace path escapes the authorized repository root");
  }
};

const resolveWorkspaceFile = async (
  root: string,
  requestedPath: JsonValue | undefined,
): Promise<{ readonly absolutePath: string; readonly relativePath: string }> => {
  const path = requiredString(requestedPath, "Workspace path", 4_096);
  if (isAbsolute(path)) throw new Error("Coding workspace path must be repository-relative");
  const lexicalPath = resolve(root, path);
  assertWithinRoot(root, lexicalPath);
  const canonicalPath = await realpath(lexicalPath);
  assertWithinRoot(root, canonicalPath);
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile()) throw new Error(`Coding workspace path ${path} is not a file`);
  if (metadata.size > MAX_FILE_BYTES) {
    throw new Error(`Coding workspace file exceeds ${MAX_FILE_BYTES} bytes`);
  }
  return {
    absolutePath: canonicalPath,
    relativePath: relative(root, canonicalPath).split(sep).join("/"),
  };
};

const readWorkspaceFile = async (
  root: string,
  value: JsonValue,
  control: RosterFunctionProviderControl,
): Promise<JsonValue> => {
  assertActive(control);
  const input = objectValue(value);
  const file = await resolveWorkspaceFile(root, input.path);
  assertActive(control);
  const text = await readFile(file.absolutePath, "utf8");
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
    throw new Error(`Coding workspace file exceeds ${MAX_FILE_BYTES} bytes`);
  }
  return {
    path: file.relativePath,
    text,
    contentHash: hashCanonical(text),
  };
};

type WorkspaceSearchResult = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
};

const searchWorkspace = async (
  root: string,
  value: JsonValue,
  control: RosterFunctionProviderControl,
): Promise<JsonValue> => {
  const input = objectValue(value);
  const query = requiredString(input.query, "Workspace search query", 1_024);
  const requestedLimit = boundedInteger(
    input.limit,
    40,
    1,
    MAX_SEARCH_RESULTS,
    "Workspace search limit",
  );
  const caseSensitive = input.caseSensitive === true;
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const results: WorkspaceSearchResult[] = [];
  const pending = [root];
  let scannedFiles = 0;
  let scannedBytes = 0;

  while (pending.length && scannedFiles < MAX_SEARCH_FILES && scannedBytes < MAX_SEARCH_BYTES) {
    assertActive(control);
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      assertActive(control);
      if (entry.isSymbolicLink()) continue;
      const absolutePath = resolve(directory, entry.name);
      assertWithinRoot(root, absolutePath);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || scannedFiles >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_BYTES) {
        continue;
      }
      const metadata = await stat(absolutePath);
      scannedFiles += 1;
      if (metadata.size > MAX_FILE_BYTES || scannedBytes + metadata.size > MAX_SEARCH_BYTES) continue;
      scannedBytes += metadata.size;
      const text = await readFile(absolutePath, "utf8");
      if (text.includes("\u0000")) continue;
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      const lines = text.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const haystack = caseSensitive ? line : line.toLocaleLowerCase();
        if (!haystack.includes(needle)) continue;
        results.push({
          path: relativePath,
          line: index + 1,
          text: line.slice(0, 2_000),
        });
        if (results.length >= requestedLimit) {
          return {
            query,
            results,
            truncated: true,
            scannedFiles,
            scannedBytes,
          };
        }
      }
    }
  }
  return {
    query,
    results,
    truncated: pending.length > 0 || scannedFiles >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_BYTES,
    scannedFiles,
    scannedBytes,
  };
};

const textArray = (
  value: JsonValue | undefined,
  label: string,
): ReadonlyArray<string> => {
  if (!Array.isArray(value) || value.length > MAX_TEXT_VALUES) {
    throw new Error(`${label} must be an array with at most ${MAX_TEXT_VALUES} strings`);
  }
  let bytes = 0;
  return value.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${label} must contain only strings`);
    bytes += Buffer.byteLength(entry);
    if (bytes > MAX_TEXT_BYTES) throw new Error(`${label} exceeds ${MAX_TEXT_BYTES} bytes`);
    return entry;
  });
};

const splitText = (value: JsonValue): JsonValue => {
  const input = objectValue(value);
  const text = requiredString(input.value, "Text split value", MAX_TEXT_BYTES, false);
  const separator = optionalString(input.separator, "\n", "Text split separator", 1_024);
  const limit = boundedInteger(input.limit, MAX_TEXT_VALUES, 1, MAX_TEXT_VALUES, "Text split limit");
  if (!separator) return [...text].slice(0, limit);
  return text.split(separator).slice(0, limit);
};

const filterText = (value: JsonValue): JsonValue => {
  const input = objectValue(value);
  const values = textArray(input.values, "Text filter values");
  const includes = requiredString(input.includes, "Text filter includes", 4_096, false);
  const caseSensitive = input.caseSensitive === true;
  const needle = caseSensitive ? includes : includes.toLocaleLowerCase();
  const limit = boundedInteger(input.limit, MAX_TEXT_VALUES, 1, MAX_TEXT_VALUES, "Text filter limit");
  return values.filter((entry) =>
    (caseSensitive ? entry : entry.toLocaleLowerCase()).includes(needle)).slice(0, limit);
};

const joinText = (value: JsonValue): JsonValue => {
  const input = objectValue(value);
  const values = textArray(input.values, "Text join values");
  const separator = optionalString(input.separator, "\n", "Text join separator", 1_024);
  const joined = values.join(separator);
  if (Buffer.byteLength(joined) > MAX_TEXT_BYTES) {
    throw new Error(`Text join output exceeds ${MAX_TEXT_BYTES} bytes`);
  }
  return joined;
};

const decodeJsonPointerToken = (token: string): string =>
  token.replaceAll("~1", "/").replaceAll("~0", "~");

const jsonPointer = (value: JsonValue): JsonValue => {
  const input = objectValue(value);
  const pointer = requiredString(input.pointer, "JSON pointer", MAX_JSON_POINTER_LENGTH, false);
  let current: JsonValue | undefined = input.value;
  if (!pointer) return current ?? null;
  if (!pointer.startsWith("/")) throw new Error("JSON pointer must be empty or begin with /");
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = decodeJsonPointerToken(rawToken);
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/u.test(token)) throw new Error(`JSON pointer array token ${token} is invalid`);
      current = current[Number(token)];
    } else if (current && typeof current === "object") {
      current = (current as Readonly<Record<string, JsonValue>>)[token];
    } else {
      current = undefined;
    }
    if (current === undefined) throw new Error(`JSON pointer ${pointer} does not resolve`);
  }
  return current;
};

const stringSchema = { type: "string", maxLength: MAX_TEXT_BYTES } as const;
const stringArraySchema = {
  type: "array",
  maxItems: MAX_TEXT_VALUES,
  items: stringSchema,
} as const;

const dependencyResolutionDescriptor = (): RosterFunctionDescriptor => ({
  id: CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID,
  version: "1.0.0",
  capability: "workspace",
  description: "Resolve one authorized npm registry manifest frontier and materialize dependencies outside the model sandbox.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["operation"],
    properties: {
      operation: { const: CODING_DEPENDENCY_RESOLUTION_OPERATION },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "manifestHashBefore",
      "manifestHashAfter",
      "lockHashBefore",
      "lockHashAfter",
      "changed",
      "audit",
      "commands",
      "durationMs",
    ],
    properties: {
      manifestHashBefore: { type: "string", pattern: "^[a-f0-9]{64}$" },
      manifestHashAfter: { type: "string", pattern: "^[a-f0-9]{64}$" },
      lockHashBefore: { type: "string", pattern: "^[a-f0-9]{64}$" },
      lockHashAfter: { type: "string", pattern: "^[a-f0-9]{64}$" },
      changed: { type: "boolean" },
      audit: {
        type: "object",
        additionalProperties: false,
        required: ["info", "low", "moderate", "high", "critical", "total"],
        properties: Object.fromEntries(
          ["info", "low", "moderate", "high", "critical", "total"]
            .map((key) => [key, { type: "integer", minimum: 0 }]),
        ),
      },
      commands: {
        type: "object",
        additionalProperties: false,
        required: ["lockfile", "materialize", "audit"],
        properties: {
          lockfile: { type: "integer", minimum: 0 },
          materialize: { type: "integer", minimum: 0 },
          audit: { type: "integer", minimum: 0 },
        },
      },
      durationMs: { type: "integer", minimum: 0 },
    },
  },
  effects: ["external", "write"],
  defaultTimeoutMs: 12 * 60_000,
});

const roomUpdateDescriptor = (): RosterFunctionDescriptor => ({
  id: CODING_ROOM_POST_UPDATE_FUNCTION_ID,
  version: "1.0.0",
  capability: "room",
  description: "Post one concise model-authored update to the current Coding room.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["updateKey", "text", "intent", "recipientNodeIds"],
    properties: {
      updateKey: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$" },
      text: { type: "string", minLength: 1, maxLength: 420 },
      intent: { enum: ["progress", "acknowledgement", "question"] },
      recipientNodeIds: {
        type: "array",
        maxItems: 6,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["updateId", "state"],
    properties: {
      updateId: { type: "string" },
      state: { const: "visible" },
    },
  },
  effects: ["write"],
  requiredScopes: [CODING_ROOM_UPDATE_SCOPE],
  idempotency: "supported",
  defaultTimeoutMs: 5_000,
  metadata: { "roster.executionProjection": "direct" },
});

const postRoomUpdate = async (
  value: JsonValue,
  control: RosterFunctionProviderControl,
  provider: CodingRoomUpdateProviderOptions,
): Promise<JsonValue> => {
  assertActive(control);
  const taskId = fencedMetadataString(control, "roster_task_id");
  const nodeId = requiredString(control.nodeId, "Coding room update author node", 512);
  const policy = await provider.recipientPolicyForTask(taskId, nodeId);
  assertActive(control);
  const input = objectValue(value, "Coding room update input");
  const updateKey = requiredString(input.updateKey, "Coding room update key", 48);
  if (typeof input.text !== "string") throw new Error("Coding room update text must be a string");
  const text = input.text;
  if (
    input.intent !== "progress"
    && input.intent !== "acknowledgement"
    && input.intent !== "question"
  ) {
    throw new Error("Coding room update intent is invalid");
  }
  if (!Array.isArray(input.recipientNodeIds)) {
    throw new Error("Coding room update recipientNodeIds must be an array");
  }
  const recipientNodeIds = input.recipientNodeIds.map((recipientNodeId) =>
    requiredString(recipientNodeId, "Coding room update recipient", 512));
  const upstreamRecipients = new Set(policy.upstreamNodeIds.map((nodeId) =>
    requiredString(nodeId, "Coding room update upstream recipient", 512)));
  const allRecipients = new Set([
    ...upstreamRecipients,
    ...policy.downstreamNodeIds.map((nodeId) =>
      requiredString(nodeId, "Coding room update downstream recipient", 512)),
    requiredString(policy.humanNodeId, "Coding room update human recipient", 512),
  ]);
  const humanNodeId = requiredString(
    policy.humanNodeId,
    "Coding room update human recipient",
    512,
  );
  const runId = fencedMetadataString(control, "roster_run_id");
  if (input.intent === "acknowledgement") {
    if (recipientNodeIds.length === 0) {
      throw new Error("Coding room acknowledgement recipients must not be empty");
    }
    const acknowledgementRecipients = new Set([...upstreamRecipients, humanNodeId]);
    const unauthorized = recipientNodeIds.find((nodeId) => !acknowledgementRecipients.has(nodeId));
    if (unauthorized) {
      throw new Error(`Coding room acknowledgement recipient ${unauthorized} is not authorized`);
    }
    const supplied = new Set(recipientNodeIds);
    if (
      supplied.size !== acknowledgementRecipients.size
      || [...acknowledgementRecipients].some((recipient) => !supplied.has(recipient))
    ) {
      throw new Error("Coding room acknowledgement must address every upstream participant and the human");
    }
  } else {
    const unauthorized = recipientNodeIds.find((nodeId) => !allRecipients.has(nodeId));
    if (unauthorized) throw new Error(`Coding room update recipient ${unauthorized} is not authorized`);
  }
  assertActive(control);
  const update = provider.roomUpdates.post({
    runId,
    taskId,
    executionId: fencedMetadataString(control, "roster_execution_id"),
    nodeId,
  }, {
    updateKey,
    text,
    intent: input.intent,
    recipientNodeIds,
  });
  return { updateId: update.updateId, state: "visible" };
};

/** Provider-neutral worker contracts exposed through compact RLM catalog search. */
export const createCodingWorkerFunctionDescriptors = (options: {
  readonly dependencyResolution?: "registry";
} = {}): ReadonlyArray<RosterFunctionDescriptor> => [
  {
    id: CODING_WORKSPACE_READ_FUNCTION_ID,
    version: "1.0.0",
    capability: "workspace",
    description: "Read one repository-relative UTF-8 file through a path-confined, bounded worker.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string", minLength: 1, maxLength: 4_096 } },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "text", "contentHash"],
      properties: {
        path: { type: "string" },
        text: stringSchema,
        contentHash: { type: "string" },
      },
    },
    effects: ["read"],
    defaultTimeoutMs: 10_000,
  },
  {
    id: CODING_WORKSPACE_SEARCH_FUNCTION_ID,
    version: "1.0.0",
    capability: "workspace",
    description: "Search bounded repository text without sending the repository catalog or unmatched files to the model.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 1_024 },
        limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS },
        caseSensitive: { type: "boolean" },
      },
    },
    outputSchema: {
      type: "object",
      required: ["query", "results", "truncated", "scannedFiles", "scannedBytes"],
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        results: {
          type: "array",
          maxItems: MAX_SEARCH_RESULTS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "line", "text"],
            properties: {
              path: { type: "string" },
              line: { type: "integer", minimum: 1 },
              text: { type: "string", maxLength: 2_000 },
            },
          },
        },
        truncated: { type: "boolean" },
        scannedFiles: { type: "integer", minimum: 0 },
        scannedBytes: { type: "integer", minimum: 0 },
      },
    },
    effects: ["read"],
    defaultTimeoutMs: 30_000,
  },
  {
    id: CODING_CHANGE_FRONTIER_FUNCTION_ID,
    version: "1.0.0",
    capability: "workspace",
    description: "Read the live Git ChangeFrontier as a bounded summary or path-scoped patch without mutating the checkout index.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: { type: "string", enum: ["summary", "patch"] },
        path: { type: "string", minLength: 1, maxLength: 4_096 },
        maxBytes: { type: "integer", minimum: 1, maximum: 256 * 1_024 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schema",
        "baselineCommit",
        "candidateTree",
        "patchHash",
        "patchBytes",
        "changedFiles",
        "omittedChangedFiles",
        "insertions",
        "deletions",
        "patch",
        "selectedPatchBytes",
        "patchTruncated",
      ],
      properties: {
        schema: { type: "string", const: CODING_CHANGE_FRONTIER_SCHEMA },
        baselineCommit: { type: "string", pattern: "^[a-f0-9]{40}([a-f0-9]{24})?$" },
        candidateTree: { type: "string", pattern: "^[a-f0-9]{40}([a-f0-9]{24})?$" },
        patchHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        patchBytes: { type: "integer", minimum: 0 },
        changedFiles: {
          type: "array",
          maxItems: 256,
          items: { type: "string", maxLength: 4_096 },
        },
        omittedChangedFiles: { type: "integer", minimum: 0 },
        insertions: { type: "integer", minimum: 0 },
        deletions: { type: "integer", minimum: 0 },
        selectedPath: { type: "string", maxLength: 4_096 },
        patch: { type: "string", maxLength: 256 * 1_024 },
        selectedPatchBytes: { type: "integer", minimum: 0 },
        patchTruncated: { type: "boolean" },
      },
    },
    effects: ["read"],
    defaultTimeoutMs: 30_000,
  },
  {
    id: CODING_JSON_GET_FUNCTION_ID,
    version: "1.0.0",
    capability: "workspace",
    description: "Select a JSON value by RFC 6901 pointer inside a worker pipeline.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value", "pointer"],
      properties: {
        value: true,
        pointer: { type: "string", maxLength: MAX_JSON_POINTER_LENGTH },
      },
    },
    outputSchema: true,
    effects: ["read"],
  },
  {
    id: CODING_TEXT_SPLIT_FUNCTION_ID,
    version: "1.0.0",
    capability: "workspace",
    description: "Split bounded text inside a worker pipeline.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: {
        value: stringSchema,
        separator: { type: "string", maxLength: 1_024 },
        limit: { type: "integer", minimum: 1, maximum: MAX_TEXT_VALUES },
      },
    },
    outputSchema: stringArraySchema,
    effects: ["read"],
  },
  {
    id: CODING_TEXT_FILTER_FUNCTION_ID,
    version: "1.0.0",
    capability: "workspace",
    description: "Filter bounded text values inside a worker pipeline.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["values", "includes"],
      properties: {
        values: stringArraySchema,
        includes: { type: "string", maxLength: 4_096 },
        caseSensitive: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: MAX_TEXT_VALUES },
      },
    },
    outputSchema: stringArraySchema,
    effects: ["read"],
  },
  {
    id: CODING_TEXT_JOIN_FUNCTION_ID,
    version: "1.0.0",
    capability: "workspace",
    description: "Join bounded text values inside a worker pipeline.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["values"],
      properties: {
        values: stringArraySchema,
        separator: { type: "string", maxLength: 1_024 },
      },
    },
    outputSchema: stringSchema,
    effects: ["read"],
  },
  roomUpdateDescriptor(),
  ...(options.dependencyResolution === "registry" ? [dependencyResolutionDescriptor()] : []),
];

export const bindCodingWorkerFunctionProviders = async (input: {
  readonly directory: RosterFunctionDirectory;
  readonly workingDirectory: string;
  /** Exact repository HEAD captured when the isolated run checkout was created. */
  readonly baselineCommit?: string;
  readonly dependencyResolution?: "registry";
  readonly repositoryExecutionProfile?: RepositoryExecutionProfile;
  readonly dependencyCommandRunner?: CommandRunner;
  readonly roomUpdateProvider?: CodingRoomUpdateProviderOptions;
  readonly providerId?: string;
  readonly epoch?: number;
}): Promise<() => void> => {
  const requestedRoot = resolve(input.workingDirectory);
  let rootPromise: Promise<string> | undefined;
  const workspaceRoot = (): Promise<string> => {
    rootPromise ??= realpath(requestedRoot);
    return rootPromise;
  };
  const providerId = input.providerId ?? `coding-workspace-${hashCanonical(requestedRoot).slice(0, 20)}`;
  const epoch = input.epoch ?? 1;
  const providers: Array<{
    readonly functionId: string;
    readonly invoke: (value: JsonValue, control: RosterFunctionProviderControl) => Promise<JsonValue>;
  }> = [
    {
      functionId: CODING_WORKSPACE_READ_FUNCTION_ID,
      invoke: async (value: JsonValue, control: RosterFunctionProviderControl) =>
        readWorkspaceFile(await workspaceRoot(), value, control),
    },
    {
      functionId: CODING_WORKSPACE_SEARCH_FUNCTION_ID,
      invoke: async (value: JsonValue, control: RosterFunctionProviderControl) =>
        searchWorkspace(await workspaceRoot(), value, control),
    },
    {
      functionId: CODING_JSON_GET_FUNCTION_ID,
      invoke: async (value: JsonValue, control: RosterFunctionProviderControl) => {
        assertActive(control);
        return jsonPointer(value);
      },
    },
    {
      functionId: CODING_TEXT_SPLIT_FUNCTION_ID,
      invoke: async (value: JsonValue, control: RosterFunctionProviderControl) => {
        assertActive(control);
        return splitText(value);
      },
    },
    {
      functionId: CODING_TEXT_FILTER_FUNCTION_ID,
      invoke: async (value: JsonValue, control: RosterFunctionProviderControl) => {
        assertActive(control);
        return filterText(value);
      },
    },
    {
      functionId: CODING_TEXT_JOIN_FUNCTION_ID,
      invoke: async (value: JsonValue, control: RosterFunctionProviderControl) => {
        assertActive(control);
        return joinText(value);
      },
    },
  ];
  const baselineCommit = input.baselineCommit;
  if (input.roomUpdateProvider) {
    providers.push({
      functionId: CODING_ROOM_POST_UPDATE_FUNCTION_ID,
      invoke: async (value: JsonValue, control: RosterFunctionProviderControl) =>
        postRoomUpdate(value, control, input.roomUpdateProvider!),
    });
  }
  if (baselineCommit) {
    providers.push({
      functionId: CODING_CHANGE_FRONTIER_FUNCTION_ID,
      invoke: async (value: JsonValue, control: RosterFunctionProviderControl) => {
        assertActive(control);
        const frontierInput = objectValue(value, "Coding ChangeFrontier input");
        const operationValue = frontierInput.operation === undefined
          ? undefined
          : requiredString(frontierInput.operation, "Coding ChangeFrontier operation", 16);
        if (
          operationValue !== undefined
          && operationValue !== "summary"
          && operationValue !== "patch"
        ) {
          throw new Error("Coding ChangeFrontier operation must be summary or patch");
        }
        const path = frontierInput.path === undefined
          ? undefined
          : requiredString(frontierInput.path, "Coding ChangeFrontier path", 4_096);
        const maxBytes = frontierInput.maxBytes === undefined
          ? undefined
          : boundedInteger(
              frontierInput.maxBytes,
              64 * 1_024,
              1,
              256 * 1_024,
              "Coding ChangeFrontier maxBytes",
            );
        return captureCodingChangeFrontier({
          workingDirectory: await workspaceRoot(),
          baselineCommit,
          ...(operationValue ? { operation: operationValue } : {}),
          ...(path ? { path } : {}),
          ...(maxBytes ? { maxBytes } : {}),
          signal: control.signal,
        });
      },
    });
  }
  if (input.dependencyResolution === "registry") {
    if (!input.repositoryExecutionProfile) {
      throw new Error("Authorized dependency resolution requires a repository execution profile");
    }
    providers.push({
      functionId: CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID,
      invoke: createRepositoryDependencyResolver({
        workingDirectory: requestedRoot,
        executionProfile: input.repositoryExecutionProfile,
        ...(input.dependencyCommandRunner ? { runner: input.dependencyCommandRunner } : {}),
      }),
    });
  }
  const generation = input.directory.bindProviderGeneration({
    providers: providers.map((provider) => ({
      providerId,
      functionId: provider.functionId,
      epoch,
      invoke: provider.invoke,
    })),
  });
  return () => {
    void generation.withdraw();
  };
};
