import { hashCanonical } from "../../core/canonical.js";
import type {
  RosterCapabilityCatalogSearchResult,
  RosterFunctionAccess,
  RosterFunctionDirectory,
  RosterFunctionInvocationAction,
  RosterFunctionTool,
} from "../functions/function-directory.js";
import type { DataReferenceStore } from "../dataflow/data-reference-store.js";
import {
  ROSTER_WORKER_PIPELINE_VERSION,
  WorkerPipelineExecutor,
  type WorkerPipelineDefinition,
  type WorkerPipelineFinalProjection,
  type WorkerPipelineLimits,
  type WorkerPipelineReferenceProjection,
  type WorkerPipelineStep,
} from "../dataflow/worker-pipeline.js";
import type {
  JsonValue,
  TaskBinding,
  WorkspaceNode,
} from "../orchestration/types.js";
import { executionTraceMetadata } from "../observability/trace.js";
import {
  ROSTER_DATA_REFERENCE_VERSION,
  type DataReference,
} from "../platform/protocol.js";
import type { NodeExecutionFunctionInvoker } from "./node-runtime.js";

export const ROSTER_CATALOG_SEARCH_FUNCTION_ID = "roster::catalog.search" as const;
export const ROSTER_CATALOG_INVOKE_FUNCTION_ID = "roster::catalog.invoke" as const;
const MAX_CATALOG_SNAPSHOTS_PER_TASK = 32;
const DIRECT_EXECUTION_PROJECTION_METADATA_KEY = "roster.executionProjection";

const catalogTools = (includePipeline: boolean): ReadonlyArray<RosterFunctionTool> => [{
  id: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
  version: "1",
  capability: "roster.catalog",
  description: "Search the live authorized worker catalog as an external RLM environment and return only bounded versioned matches.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", maxLength: 500 },
      capabilities: {
        type: "array",
        maxItems: 16,
        items: { type: "string", minLength: 1, maxLength: 200 },
      },
      limit: { type: "integer", minimum: 1, maximum: 32 },
    },
  },
  outputSchema: true,
  effects: ["read"],
}, {
  id: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
  version: "1",
  capability: "roster.catalog",
  description: includePipeline
    ? "Describe, call, or compose workers from one task-local search snapshot. Every target and pipeline step is pinned to its function version, provider, and provider epoch."
    : "Describe or call one worker from a task-local search snapshot, pinned to its function version, provider, and provider epoch.",
  inputSchema: {
    type: "object",
    required: ["operation", "catalogVersion"],
    additionalProperties: false,
    properties: {
      operation: {
        enum: includePipeline
          ? ["describe", "call", "pipeline"]
          : ["describe", "call"],
      },
      catalogVersion: { type: "string", minLength: 1, maxLength: 200 },
      functionId: { type: "string", minLength: 1, maxLength: 240 },
      functionVersion: { type: "string", minLength: 1, maxLength: 120 },
      providerId: { type: "string", minLength: 1, maxLength: 240 },
      providerEpoch: { type: "integer", minimum: 1 },
      value: true,
      action: { enum: ["await", "void"] },
      timeoutMs: { type: "integer", minimum: 1 },
      ...(includePipeline ? {
        pipelineId: { type: "string", minLength: 1, maxLength: 200 },
        initialReference: { type: "object" },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: {
            type: "object",
            required: ["stepId", "functionId", "functionVersion", "providerId", "providerEpoch"],
            additionalProperties: false,
            properties: {
              stepId: { type: "string", minLength: 1, maxLength: 200 },
              functionId: { type: "string", minLength: 1, maxLength: 240 },
              functionVersion: { type: "string", minLength: 1, maxLength: 120 },
              providerId: { type: "string", minLength: 1, maxLength: 240 },
              providerEpoch: { type: "integer", minimum: 1 },
              input: true,
              timeoutMs: { type: "integer", minimum: 1 },
              output: { type: "object" },
            },
          },
        },
        limits: { type: "object" },
        finalProjection: { type: "object" },
        initialValue: true,
        initialMediaType: { type: "string", minLength: 1, maxLength: 160 },
      } : {}),
    },
  },
  outputSchema: true,
  effects: ["external"],
}];

const objectValue = (
  value: JsonValue,
  label: string,
): Readonly<Record<string, JsonValue>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} requires an object input`);
  }
  return value as Readonly<Record<string, JsonValue>>;
};

const optionalStrings = (
  value: JsonValue | undefined,
  label: string,
): ReadonlyArray<string> | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as ReadonlyArray<string>;
};

const catalogAction = (
  kind: JsonValue | undefined,
): RosterFunctionInvocationAction | undefined => {
  if (kind === undefined || kind === "await") return undefined;
  if (kind === "void") return { kind: "void" };
  throw new Error("Pinned catalog invocation action must be await or void");
};

const requiredString = (
  value: JsonValue | undefined,
  label: string,
  maximum: number,
): string => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value;
};

const positiveInteger = (
  value: JsonValue | undefined,
  label: string,
): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
};

const assertKeys = (
  value: Readonly<Record<string, JsonValue>>,
  allowed: ReadonlyArray<string>,
  label: string,
): void => {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new Error(`${label} contains unsupported field ${unexpected}`);
};

const dataReference = (
  value: JsonValue | undefined,
  label: string,
): DataReference => {
  if (value === undefined) throw new Error(`${label} is required`);
  const record = objectValue(value, label);
  const storage = record.storage;
  if (
    record.schemaVersion !== ROSTER_DATA_REFERENCE_VERSION
    || typeof record.referenceId !== "string"
    || !record.referenceId
    || typeof record.contentHash !== "string"
    || !record.contentHash
    || typeof record.mediaType !== "string"
    || !record.mediaType
    || !Number.isSafeInteger(record.byteLength)
    || Number(record.byteLength) < 0
    || (storage !== "ephemeral" && storage !== "artifact" && storage !== "object")
  ) {
    throw new Error(`${label} does not match the frozen DataReference protocol`);
  }
  if (
    (record.producerFunctionId !== undefined && typeof record.producerFunctionId !== "string")
    || (record.producerFunctionVersion !== undefined && typeof record.producerFunctionVersion !== "string")
    || (record.artifactId !== undefined && typeof record.artifactId !== "string")
    || (record.uri !== undefined && typeof record.uri !== "string")
    || (record.metadata !== undefined
      && (!record.metadata || typeof record.metadata !== "object" || Array.isArray(record.metadata)))
  ) {
    throw new Error(`${label} contains invalid optional DataReference fields`);
  }
  return JSON.parse(JSON.stringify(record)) as DataReference;
};

const referenceProjection = (
  value: JsonValue | undefined,
  label: string,
): WorkerPipelineReferenceProjection | undefined => {
  if (value === undefined) return undefined;
  const record = objectValue(value, label);
  assertKeys(record, ["mediaType", "storage", "artifactId", "uri", "metadata"], label);
  const storage = record.storage;
  if (
    storage !== undefined
    && storage !== "ephemeral"
    && storage !== "artifact"
    && storage !== "object"
  ) {
    throw new Error(`${label}.storage is invalid`);
  }
  for (const key of ["mediaType", "artifactId", "uri"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      throw new Error(`${label}.${key} must be a string`);
    }
  }
  if (
    record.metadata !== undefined
    && (!record.metadata || typeof record.metadata !== "object" || Array.isArray(record.metadata))
  ) {
    throw new Error(`${label}.metadata must be an object`);
  }
  return {
    ...(typeof record.mediaType === "string" ? { mediaType: record.mediaType } : {}),
    ...(storage ? { storage } : {}),
    ...(typeof record.artifactId === "string" ? { artifactId: record.artifactId } : {}),
    ...(typeof record.uri === "string" ? { uri: record.uri } : {}),
    ...(record.metadata ? { metadata: record.metadata as Readonly<Record<string, JsonValue>> } : {}),
  };
};

const pipelineLimits = (
  value: JsonValue | undefined,
): WorkerPipelineLimits | undefined => {
  if (value === undefined) return undefined;
  const record = objectValue(value, "Roster pipeline limits");
  const keys = [
    "maxSteps",
    "maxValueBytes",
    "maxTotalBytes",
    "maxReferenceBytes",
    "maxWallTimeMs",
    "maxStepTimeMs",
    "maxPreviewBytes",
  ] as const;
  assertKeys(record, keys, "Roster pipeline limits");
  const result: Record<string, number> = {};
  for (const key of keys) {
    if (record[key] !== undefined) result[key] = positiveInteger(record[key], `Roster pipeline limits.${key}`);
  }
  return result;
};

const finalProjection = (
  value: JsonValue | undefined,
): WorkerPipelineFinalProjection => {
  if (value === undefined) throw new Error("Roster pipeline finalProjection is required");
  const record = objectValue(value, "Roster pipeline finalProjection");
  assertKeys(record, ["pointer", "maxPreviewBytes", "output"], "Roster pipeline finalProjection");
  if (record.pointer !== undefined && typeof record.pointer !== "string") {
    throw new Error("Roster pipeline finalProjection.pointer must be a string");
  }
  return {
    ...(typeof record.pointer === "string" ? { pointer: record.pointer } : {}),
    ...(record.maxPreviewBytes !== undefined
      ? { maxPreviewBytes: positiveInteger(record.maxPreviewBytes, "Roster pipeline finalProjection.maxPreviewBytes") }
      : {}),
    ...(record.output !== undefined
      ? { output: referenceProjection(record.output, "Roster pipeline finalProjection.output")! }
      : {}),
  };
};

const pipelineSteps = (
  value: JsonValue | undefined,
): ReadonlyArray<WorkerPipelineStep> => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error("Roster pipeline steps must contain between 1 and 64 entries");
  }
  return value.map((candidate, index): WorkerPipelineStep => {
    const record = objectValue(candidate, `Roster pipeline step ${index}`);
    assertKeys(
      record,
      ["stepId", "functionId", "functionVersion", "providerId", "providerEpoch", "input", "timeoutMs", "output"],
      `Roster pipeline step ${index}`,
    );
    return {
      stepId: requiredString(record.stepId, `Roster pipeline step ${index}.stepId`, 200),
      functionId: requiredString(record.functionId, `Roster pipeline step ${index}.functionId`, 240),
      functionVersion: requiredString(record.functionVersion, `Roster pipeline step ${index}.functionVersion`, 120),
      providerId: requiredString(record.providerId, `Roster pipeline step ${index}.providerId`, 240),
      providerEpoch: positiveInteger(record.providerEpoch, `Roster pipeline step ${index}.providerEpoch`),
      ...(record.input !== undefined ? { input: record.input } : {}),
      ...(record.timeoutMs !== undefined
        ? { timeoutMs: positiveInteger(record.timeoutMs, `Roster pipeline step ${index}.timeoutMs`) }
        : {}),
      ...(record.output !== undefined
        ? { output: referenceProjection(record.output, `Roster pipeline step ${index}.output`)! }
        : {}),
    };
  });
};

export type RosterFunctionExecutionPlane = {
  readonly functionTools: (
    node: WorkspaceNode,
    task: TaskBinding,
  ) => ReadonlyArray<RosterFunctionTool>;
  readonly functionInvoker: (
    node: WorkspaceNode,
    task: TaskBinding,
  ) => NodeExecutionFunctionInvoker;
};

export type RosterFunctionActivity = {
  readonly activityId: string;
  readonly operation: "catalog.search" | "catalog.describe" | "function.call" | "pipeline.execute";
  readonly nodeId: string;
  readonly taskId: string;
  readonly catalogVersion?: string;
  readonly functionId?: string;
  readonly functionVersion?: string;
  readonly providerId?: string;
  readonly providerEpoch?: number;
  readonly resultCount?: number;
  readonly invocationStatus?: "completed" | "accepted" | "enqueued";
  readonly pipelineId?: string;
  readonly stepCount?: number;
  readonly transferredBytes?: number;
};

/**
 * Binds the stable function directory to one node execution without granting
 * runtime adapters scheduling or authorization authority. The `rlm`
 * projection keeps the catalog outside the model context and normally exposes
 * only bounded search and pinned invoke. Small interaction functions may opt
 * into direct execution projection so a model can perform a time-sensitive,
 * explicitly granted action without first navigating the external catalog.
 */
export const createRosterFunctionExecutionPlane = (input: {
  readonly directory: RosterFunctionDirectory;
  readonly access?: (
    node: WorkspaceNode,
    task: TaskBinding,
  ) => RosterFunctionAccess;
  readonly pipeline?: {
    readonly store: DataReferenceStore;
    readonly limits?: WorkerPipelineLimits;
    readonly now?: () => number;
  };
  /** Content-free observational receipt for catalog and worker activity. */
  readonly onActivity?: (activity: RosterFunctionActivity) => Promise<void>;
}): RosterFunctionExecutionPlane => {
  const pipelineExecutor = input.pipeline
    ? new WorkerPipelineExecutor({
      directory: input.directory,
      store: input.pipeline.store,
      ...(input.pipeline.limits ? { limits: input.pipeline.limits } : {}),
      ...(input.pipeline.now ? { now: input.pipeline.now } : {}),
    })
    : undefined;
  const accessFor = (node: WorkspaceNode, task: TaskBinding): RosterFunctionAccess =>
    input.access?.(node, task) ?? {};
  const directToolsFor = (
    node: WorkspaceNode,
    task: TaskBinding,
  ): ReadonlyArray<RosterFunctionTool> => {
    const access = accessFor(node, task);
    const grants = new Set(access.functionGrants ?? []);
    const scopes = new Set(access.scopes ?? []);
    const effects = new Set(access.allowedEffects ?? ["read"]);
    return input.directory.descriptors().flatMap((descriptor) => {
      if (
        descriptor.metadata?.[DIRECT_EXECUTION_PROJECTION_METADATA_KEY] !== "direct"
        || !grants.has(descriptor.id)
        || descriptor.effects.some((effect) => !effects.has(effect))
        || descriptor.requiredScopes?.some((scope) => !scopes.has(scope))
        || !input.directory.providerHealth(descriptor.id).some((provider) => provider.live)
      ) return [];
      return input.directory.projectCatalog({
        node,
        access,
        functionIds: [descriptor.id],
      }).tools;
    });
  };
  const recordActivity = async (
    activity: Omit<RosterFunctionActivity, "activityId">,
  ): Promise<void> => {
    if (!input.onActivity) return;
    const receipt: RosterFunctionActivity = {
      ...activity,
      activityId: `function_activity_${hashCanonical(activity).slice(0, 32)}`,
    };
    try {
      await input.onActivity(receipt);
    } catch {
      // Observability must not change a worker result or weaken graph authority.
    }
  };
  return {
    functionTools: (node, task) => [
      ...catalogTools(Boolean(pipelineExecutor)),
      ...directToolsFor(node, task),
    ],
    functionInvoker: (node, task) => {
      // Search snapshots are execution-local capabilities: a different bound
      // node task cannot replay a discovered catalog version.
      const snapshots = new Map<string, RosterCapabilityCatalogSearchResult>();
      return async (invocation, control) => {
        if (control.nodeId !== node.id || control.taskId !== task.taskId) {
          throw new Error("Roster function invocation does not match its bound node task");
        }
        const access = accessFor(node, task);
        const metadata = {
          roster_execution_id: control.executionId,
          roster_run_id: control.runId,
          roster_task_id: control.taskId,
          ...(control.trace ? executionTraceMetadata(control.trace) : {}),
        };
        if (directToolsFor(node, task).some((tool) => tool.id === invocation.functionId)) {
          const invoked = await input.directory.invokeWithTrace({
            node,
            access,
            functionId: invocation.functionId,
            value: invocation.value,
            ...(invocation.action ? { action: invocation.action } : {}),
            ...(invocation.timeoutMs !== undefined ? { timeoutMs: invocation.timeoutMs } : {}),
            ...(control.signal ? { signal: control.signal } : {}),
            metadata,
          });
          await recordActivity({
            operation: "function.call",
            nodeId: node.id,
            taskId: task.taskId,
            functionId: invoked.trace.functionId,
            functionVersion: invoked.trace.functionVersion,
            providerId: invoked.trace.providerId,
            providerEpoch: invoked.trace.providerEpoch,
            invocationStatus: invoked.result.status,
          });
          return invoked.result;
        }
        if (invocation.functionId === ROSTER_CATALOG_SEARCH_FUNCTION_ID) {
          const value = objectValue(invocation.value, "Roster catalog search");
          assertKeys(value, ["query", "capabilities", "limit"], "Roster catalog search");
          const query = value.query;
          const limit = value.limit;
          if (query !== undefined && typeof query !== "string") {
            throw new Error("Roster catalog search query must be a string");
          }
          if (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1)) {
            throw new Error("Roster catalog search limit must be a positive safe integer");
          }
          const capabilities = optionalStrings(
            value.capabilities,
            "Roster catalog search capabilities",
          );
          const snapshot = input.directory.searchCatalog({
            node,
            access,
            ...(typeof query === "string" ? { query } : {}),
            ...(capabilities ? { capabilities } : {}),
            ...(typeof limit === "number" ? { limit } : {}),
          });
          snapshots.set(snapshot.catalogVersion, snapshot);
          while (snapshots.size > MAX_CATALOG_SNAPSHOTS_PER_TASK) {
            const oldest = snapshots.keys().next().value as string | undefined;
            if (!oldest) break;
            snapshots.delete(oldest);
          }
          await recordActivity({
            operation: "catalog.search",
            nodeId: node.id,
            taskId: task.taskId,
            catalogVersion: snapshot.catalogVersion,
            resultCount: snapshot.entries.length,
          });
          return {
            status: "completed",
            functionId: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
            providerId: "roster-catalog",
            output: cloneAsJson(snapshot),
          };
        }
        if (invocation.functionId === ROSTER_CATALOG_INVOKE_FUNCTION_ID) {
          const value = objectValue(invocation.value, "Roster catalog invocation");
          const operation = requiredString(
            value.operation,
            "Roster catalog invocation.operation",
            20,
          );
          const catalogVersion = requiredString(
            value.catalogVersion,
            "Roster catalog invocation.catalogVersion",
            200,
          );
          const snapshot = snapshots.get(catalogVersion);
          if (!snapshot) {
            throw new Error("Roster catalog invocation was not present in this task's search snapshot");
          }
          if (operation === "describe") {
            assertKeys(
              value,
              ["operation", "catalogVersion", "functionId", "functionVersion", "providerId", "providerEpoch"],
              "Roster catalog description",
            );
            const description = input.directory.describeCatalog({
              node,
              access,
              snapshot,
              functionId: requiredString(
                value.functionId,
                "Roster catalog description.functionId",
                240,
              ),
              functionVersion: requiredString(
                value.functionVersion,
                "Roster catalog description.functionVersion",
                120,
              ),
              providerId: requiredString(
                value.providerId,
                "Roster catalog description.providerId",
                240,
              ),
              providerEpoch: positiveInteger(
                value.providerEpoch,
                "Roster catalog description.providerEpoch",
              ),
            });
            await recordActivity({
              operation: "catalog.describe",
              nodeId: node.id,
              taskId: task.taskId,
              catalogVersion,
              functionId: description.tool.id,
              functionVersion: description.tool.version,
              providerId: description.provider.providerId,
              providerEpoch: description.provider.epoch,
            });
            return {
              status: "completed",
              functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
              providerId: "roster-catalog",
              output: cloneAsJson(description),
            };
          }
          if (operation === "call") {
            assertKeys(
              value,
              [
                "operation",
                "catalogVersion",
                "functionId",
                "functionVersion",
                "providerId",
                "providerEpoch",
                "value",
                "action",
                "timeoutMs",
              ],
              "Roster catalog call",
            );
            const functionId = requiredString(
              value.functionId,
              "Roster catalog call.functionId",
              240,
            );
            const functionVersion = requiredString(
              value.functionVersion,
              "Roster catalog call.functionVersion",
              120,
            );
            const providerId = requiredString(
              value.providerId,
              "Roster catalog call.providerId",
              240,
            );
            const providerEpoch = positiveInteger(
              value.providerEpoch,
              "Roster catalog call.providerEpoch",
            );
            if (value.value === undefined) {
              throw new Error("Roster catalog call.value is required");
            }
            const entry = snapshot.entries.find((candidate) =>
              candidate.id === functionId
              && candidate.version === functionVersion
              && candidate.providers.some((provider) =>
                provider.providerId === providerId && provider.epoch === providerEpoch));
            if (!entry) {
              throw new Error("Roster catalog call was not present in this task's search snapshot");
            }
            const result = await input.directory.invoke({
              node,
              functionId,
              value: value.value,
              action: catalogAction(value.action),
              ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
              access,
              signal: control.signal,
              expectedProvider: { providerId, epoch: providerEpoch },
              metadata: {
                ...metadata,
                roster_catalog_version: catalogVersion,
              },
            });
            await recordActivity({
              operation: "function.call",
              nodeId: node.id,
              taskId: task.taskId,
              catalogVersion,
              functionId,
              functionVersion,
              providerId,
              providerEpoch,
              invocationStatus: result.status,
            });
            return result;
          }
          if (operation === "pipeline") {
            if (!pipelineExecutor) {
              throw new Error("Roster pipeline execution is not configured");
            }
            assertKeys(
              value,
              [
                "operation",
                "pipelineId",
                "catalogVersion",
                "initialReference",
                "initialValue",
                "initialMediaType",
                "steps",
                "limits",
                "finalProjection",
              ],
              "Roster pipeline execution",
            );
            const limits = pipelineLimits(value.limits);
            const pipeline: WorkerPipelineDefinition = {
              schemaVersion: ROSTER_WORKER_PIPELINE_VERSION,
              pipelineId: requiredString(
                value.pipelineId,
                "Roster pipeline execution.pipelineId",
                200,
              ),
              catalogVersion,
              initialReference: await (async () => {
                const hasReference = value.initialReference !== undefined;
                const hasValue = value.initialValue !== undefined;
                if (hasReference === hasValue) {
                  throw new Error(
                    "Roster pipeline execution requires exactly one of initialReference or initialValue",
                  );
                }
                if (hasReference) {
                  if (value.initialMediaType !== undefined) {
                    throw new Error(
                      "Roster pipeline execution.initialMediaType requires initialValue",
                    );
                  }
                  return dataReference(
                    value.initialReference,
                    "Roster pipeline execution.initialReference",
                  );
                }
                if (value.initialMediaType !== undefined && typeof value.initialMediaType !== "string") {
                  throw new Error("Roster pipeline execution.initialMediaType must be a string");
                }
                return input.pipeline!.store.put({
                  value: value.initialValue!,
                  ...(typeof value.initialMediaType === "string"
                    ? { mediaType: value.initialMediaType }
                    : {}),
                }, { signal: control.signal });
              })(),
              steps: pipelineSteps(value.steps),
              ...(limits ? { limits } : {}),
              finalProjection: finalProjection(value.finalProjection),
            };
            const result = await pipelineExecutor.execute({
              node,
              access,
              pipeline,
              catalogSnapshot: snapshot,
              ...(control.trace ? { trace: control.trace } : {}),
              signal: control.signal,
            });
            await recordActivity({
              operation: "pipeline.execute",
              nodeId: node.id,
              taskId: task.taskId,
              catalogVersion,
              pipelineId: pipeline.pipelineId,
              stepCount: result.receipts.length,
              transferredBytes: result.transferredBytes,
              invocationStatus: "completed",
            });
            return {
              status: "completed",
              functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
              providerId: "roster-pipeline",
              output: cloneAsJson(result),
            };
          }
          throw new Error("Roster catalog invocation operation must be describe, call, or pipeline");
        }
        throw new Error(
          `Roster function ${invocation.functionId} is not a virtual catalog function; `
          + "discover it with roster::catalog.search and invoke the pinned result through roster::catalog.invoke",
        );
      };
    },
  };
};

const cloneAsJson = (
  value: object,
): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
