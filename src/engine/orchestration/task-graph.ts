import Ajv from "ajv";

import { systemClock, type Clock, type ClockTimer } from "../../core/clock.js";
import { hashCanonical } from "../../core/canonical.js";
import {
  ROSTER_DATA_REFERENCE_VERSION,
  ROSTER_TASK_DEFINITION_VERSION,
  ROSTER_TASK_OUTCOME_VERSION,
  type AcceptedArtifactReference,
  type AcceptedTaskOutcome,
  type DynamicTaskDefinition,
  type RunExecutionPolicy,
  type TaskDependency,
  type TaskResultContract,
} from "../platform/protocol.js";
import type { DataReferenceStore } from "../dataflow/data-reference-store.js";
import {
  createTaskContextManifest,
  validateTaskContextManifest,
  type TaskContextManifest,
  type TaskRepositoryPlacement,
} from "../platform/task-context-manifest.js";
import {
  createTaskExecutionGrant,
  type TaskExecutionGrant,
} from "../platform/execution-grant.js";
import type {
  JsonValue,
  NodeExecutionUsage,
  WorkspaceNodeRuntimeBinding,
} from "./types.js";
import type {
  TaskGraphControl,
  TaskGraphControlSnapshot,
  TaskGraphOutcomeDataReference,
} from "./task-graph-control.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const RESULT_SCHEMA_VALIDATOR = new Ajv({ allErrors: true, strict: false });
const TERMINAL_STATUSES = new Set<TaskGraphTaskStatus>([
  "accepted",
  "failed",
  "canceled",
  "skipped",
]);

export type TaskGraphTaskStatus =
  | "pending"
  | "ready"
  | "leased"
  | "running"
  | "waiting"
  | "accepted"
  | "failed"
  | "canceled"
  | "skipped";

export type TaskGraphTaskRecord = {
  readonly definition: DynamicTaskDefinition;
  readonly status: TaskGraphTaskStatus;
  readonly attempt: number;
  readonly leaseFence: number;
  readonly leaseOwner?: string;
  readonly contextManifest?: TaskContextManifest;
  readonly outcome?: AcceptedTaskOutcome;
  readonly error?: string;
  readonly continuationTaskId?: string;
  /** Earliest retry eligibility in epoch milliseconds; pending is not deadlocked before this wake. */
  readonly retryAt?: number;
};

export type TaskGraphExpansion = {
  readonly parentTaskId: string;
  readonly expansionKey: string;
  readonly expansionHash: string;
  readonly publishedFence: number;
  readonly childTaskIds: ReadonlyArray<string>;
  readonly continuationTaskId: string;
};

export type TaskGraphLease = {
  readonly taskId: string;
  readonly owner: string;
  readonly fence: number;
  readonly attempt: number;
  readonly definition: DynamicTaskDefinition;
};

export type TaskGraphExpansionInput = {
  readonly parentTaskId: string;
  readonly fence: number;
  readonly owner: string;
  readonly expansionKey: string;
  readonly definitions: ReadonlyArray<DynamicTaskDefinition>;
  readonly continuationTaskId: string;
};

export type TaskGraphQuiescence = {
  readonly quiescent: boolean;
  readonly deadlocked: boolean;
  readonly ready: number;
  readonly inflight: number;
  readonly waiting: number;
  readonly blocked: number;
  readonly terminal: number;
  readonly total: number;
};

export type TaskGraphSnapshot = {
  readonly policy: RunExecutionPolicy;
  readonly tasks: ReadonlyArray<TaskGraphTaskRecord>;
  readonly expansions: ReadonlyArray<TaskGraphExpansion>;
  readonly acceptedCostMicros: number;
  /** Tokens charged to the execution policy; provider-reported cached input is excluded. */
  readonly acceptedTokens: number;
};

/**
 * Returns the provider usage that consumes a run's token allowance. Cached
 * input remains part of the accepted outcome for evidence and cost reporting,
 * but does not consume the long-running execution token budget.
 */
export const budgetedExecutionTokens = (usage: NodeExecutionUsage | undefined): number => {
  if (!usage) return 0;
  const totalTokens = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  const cachedInputTokens = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens ?? totalTokens);
  return Math.max(0, totalTokens - cachedInputTokens);
};

type MutableTaskRecord = {
  definition: DynamicTaskDefinition;
  status: TaskGraphTaskStatus;
  attempt: number;
  leaseFence: number;
  leaseOwner?: string;
  contextManifest?: TaskContextManifest;
  outcome?: AcceptedTaskOutcome;
  error?: string;
  continuationTaskId?: string;
  retryAt?: number;
};

const assertText = (value: string, label: string, maximum = 20_000): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be blank`);
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return normalized;
};

const assertId = (value: string, label: string, maximum = 200): string => {
  const normalized = assertText(value, label, maximum);
  if (!ID_PATTERN.test(normalized)) throw new Error(`${label} contains unsafe characters`);
  return normalized;
};

const safeInteger = (
  value: number,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const canonicalDependencies = (
  dependencies: ReadonlyArray<TaskDependency>,
  taskId: string,
): ReadonlyArray<TaskDependency> => {
  const seen = new Set<string>();
  const normalized = dependencies.map((dependency) => {
    const dependencyTaskId = assertId(dependency.taskId, `Task ${taskId} dependency`);
    if (dependencyTaskId === taskId) throw new Error(`Task ${taskId} cannot depend on itself`);
    if (seen.has(dependencyTaskId)) throw new Error(`Task ${taskId} repeats dependency ${dependencyTaskId}`);
    seen.add(dependencyTaskId);
    if (dependency.condition !== "accepted" && dependency.condition !== "terminal") {
      throw new Error(`Task ${taskId} dependency ${dependencyTaskId} has an invalid condition`);
    }
    return { taskId: dependencyTaskId, condition: dependency.condition };
  });
  return normalized.sort((left, right) =>
    left.taskId.localeCompare(right.taskId) || left.condition.localeCompare(right.condition));
};

const definitionIdentity = (
  definition: Omit<DynamicTaskDefinition, "definitionHash">,
): Omit<DynamicTaskDefinition, "definitionHash"> => ({
  ...definition,
  dependencies: canonicalDependencies(definition.dependencies, definition.taskId),
  inputs: {
    ...definition.inputs,
    inputVersions: Object.fromEntries(Object.entries(definition.inputs.inputVersions).sort(([left], [right]) =>
      left.localeCompare(right))),
    dataReferences: [...definition.inputs.dataReferences].sort((left, right) =>
      left.referenceId.localeCompare(right.referenceId)),
  },
});

export const createDynamicTaskDefinition = (
  input: Omit<DynamicTaskDefinition, "definitionHash" | "schemaVersion"> & {
    readonly schemaVersion?: typeof ROSTER_TASK_DEFINITION_VERSION;
  },
): DynamicTaskDefinition => {
  const content = definitionIdentity({
    ...input,
    schemaVersion: ROSTER_TASK_DEFINITION_VERSION,
  });
  return {
    ...content,
    definitionHash: hashCanonical(content),
  };
};

export const defaultTaskResultContract = (
  outputKey = "result",
): TaskResultContract => ({
  mode: "text",
  outputKey: assertId(outputKey, "Task result output key"),
});

export const validateDynamicTaskDefinition = (
  input: DynamicTaskDefinition,
  policy?: RunExecutionPolicy,
): DynamicTaskDefinition => {
  if (input.schemaVersion !== ROSTER_TASK_DEFINITION_VERSION) {
    throw new Error(`Task ${input.taskId} has an unsupported definition schema`);
  }
  const taskId = assertId(input.taskId, "Task id");
  const semanticKey = assertId(input.semanticKey, `Task ${taskId} semantic key`);
  const nodeId = assertId(input.nodeId, `Task ${taskId} node id`);
  const capability = assertId(input.capability, `Task ${taskId} capability`);
  const objective = assertText(input.objective, `Task ${taskId} objective`);
  const handler = {
    kind: assertId(input.handler.kind, `Task ${taskId} handler kind`),
    version: assertText(input.handler.version, `Task ${taskId} handler version`, 120),
  };
  const acceptance = {
    policyId: assertId(input.acceptance.policyId, `Task ${taskId} acceptance policy`),
    policyVersion: assertText(input.acceptance.policyVersion, `Task ${taskId} acceptance policy version`, 120),
  };
  const dependencies = canonicalDependencies(input.dependencies, taskId);
  switch (input.join.kind) {
    case "all-success":
    case "all-terminal":
    case "any-success":
      break;
    case "quorum":
      safeInteger(input.join.count, `Task ${taskId} quorum`, 1, Math.max(1, dependencies.length));
      break;
    default:
      throw new Error(`Task ${taskId} has an invalid join policy`);
  }
  switch (input.result.mode) {
    case "text":
      assertId(input.result.outputKey, `Task ${taskId} result output key`);
      break;
    case "json":
      assertId(input.result.outputKey, `Task ${taskId} result output key`);
      break;
    case "artifact":
      assertId(input.result.outputKey, `Task ${taskId} result output key`);
      assertId(input.result.artifactKind, `Task ${taskId} result artifact kind`);
      if (input.result.mediaType !== undefined) {
        assertText(input.result.mediaType, `Task ${taskId} result media type`, 200);
      }
      break;
    case "none":
      break;
    default:
      throw new Error(`Task ${taskId} has an invalid result contract`);
  }
  const inputVersions = Object.fromEntries(Object.entries(input.inputs.inputVersions)
    .map(([key, value]) => [
      assertId(key, `Task ${taskId} input version key`),
      assertText(value, `Task ${taskId} input version ${key}`, 256),
    ] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
  const references = [...input.inputs.dataReferences].sort((left, right) =>
    left.referenceId.localeCompare(right.referenceId));
  if (new Set(references.map((reference) => reference.referenceId)).size !== references.length) {
    throw new Error(`Task ${taskId} repeats a data reference`);
  }
  for (const reference of references) {
    if (reference.schemaVersion !== ROSTER_DATA_REFERENCE_VERSION) {
      throw new Error(`Task ${taskId} data reference ${reference.referenceId} has an unsupported schema`);
    }
    assertId(reference.referenceId, `Task ${taskId} data reference`);
    assertText(reference.contentHash, `Task ${taskId} data reference hash`, 256);
    assertText(reference.mediaType, `Task ${taskId} data reference media type`, 200);
    safeInteger(reference.byteLength, `Task ${taskId} data reference bytes`, 0);
    if (!["ephemeral", "artifact", "object"].includes(reference.storage)) {
      throw new Error(`Task ${taskId} data reference ${reference.referenceId} has invalid storage`);
    }
    if (reference.storage === "artifact") {
      if (!reference.artifactId) {
        throw new Error(`Task ${taskId} artifact data reference ${reference.referenceId} has no artifact id`);
      }
      assertId(
        reference.artifactId,
        `Task ${taskId} artifact data reference ${reference.referenceId}`,
        240,
      );
    }
    if (reference.storage === "object" && !reference.uri) {
      throw new Error(`Task ${taskId} object data reference ${reference.referenceId} has no URI`);
    }
  }
  const runtimeBindingEpoch = safeInteger(input.runtimeBindingEpoch, `Task ${taskId} runtime binding epoch`, 0);
  const retry = {
    maxAttempts: safeInteger(input.retry.maxAttempts, `Task ${taskId} max attempts`, 1),
    initialBackoffMs: safeInteger(input.retry.initialBackoffMs, `Task ${taskId} initial backoff`, 0),
    maximumBackoffMs: safeInteger(input.retry.maximumBackoffMs, `Task ${taskId} maximum backoff`, 0),
  };
  if (retry.maximumBackoffMs < retry.initialBackoffMs) {
    throw new Error(`Task ${taskId} maximum backoff is below its initial backoff`);
  }
  const timeoutMs = safeInteger(input.timeoutMs, `Task ${taskId} timeout`, 0);
  const estimatedCostMicros = safeInteger(input.estimatedCostMicros, `Task ${taskId} estimated cost`, 0);
  const parentTaskId = input.parentTaskId
    ? assertId(input.parentTaskId, `Task ${taskId} parent`)
    : undefined;
  if (!["pure", "idempotent", "non-repeatable"].includes(input.sideEffect)) {
    throw new Error(`Task ${taskId} has an invalid side-effect mode`);
  }
  if (policy) {
    if (retry.maxAttempts > policy.maxAttempts) {
      throw new Error(`Task ${taskId} exceeds maxAttempts=${policy.maxAttempts}`);
    }
    if (references.reduce((sum, reference) => sum + reference.byteLength, 0) > policy.maxContextBytes) {
      throw new Error(`Task ${taskId} exceeds maxContextBytes=${policy.maxContextBytes}`);
    }
    if (estimatedCostMicros > policy.maxCostMicros) {
      throw new Error(`Task ${taskId} exceeds maxCostMicros=${policy.maxCostMicros}`);
    }
  }
  const normalized = createDynamicTaskDefinition({
    taskId,
    semanticKey,
    nodeId,
    capability,
    objective,
    handler,
    acceptance,
    result: input.result,
    dependencies,
    join: input.join,
    inputs: {
      inputVersions,
      dataReferences: references,
      frontierVersion: assertText(input.inputs.frontierVersion, `Task ${taskId} frontier version`, 200),
      topologyVersion: assertText(input.inputs.topologyVersion, `Task ${taskId} topology version`, 200),
      catalogVersion: assertText(input.inputs.catalogVersion, `Task ${taskId} catalog version`, 200),
    },
    runtimeBindingEpoch,
    retry,
    timeoutMs,
    sideEffect: input.sideEffect,
    estimatedCostMicros,
    ...(parentTaskId ? { parentTaskId } : {}),
  });
  if (normalized.definitionHash !== input.definitionHash) {
    throw new Error(`Task ${taskId} has an invalid definition hash`);
  }
  return normalized;
};

const outcomeIdentity = (
  input: Omit<AcceptedTaskOutcome, "outcomeId">,
): Omit<AcceptedTaskOutcome, "outcomeId"> => ({
  ...input,
  inputVersions: Object.fromEntries(Object.entries(input.inputVersions).sort(([left], [right]) =>
    left.localeCompare(right))),
  artifacts: [...input.artifacts].sort((left, right) =>
    left.outputKey.localeCompare(right.outputKey) || left.artifactId.localeCompare(right.artifactId)),
});

export const createAcceptedTaskOutcome = (
  input: Omit<AcceptedTaskOutcome, "outcomeId" | "schemaVersion"> & {
    readonly schemaVersion?: typeof ROSTER_TASK_OUTCOME_VERSION;
  },
): AcceptedTaskOutcome => {
  const content = outcomeIdentity({
    ...input,
    schemaVersion: ROSTER_TASK_OUTCOME_VERSION,
  });
  return {
    ...content,
    outcomeId: `task_outcome_${hashCanonical(content).slice(0, 28)}`,
  };
};

const normalizePolicy = (policy: RunExecutionPolicy): RunExecutionPolicy => {
  const normalized = { ...policy };
  for (const [name, value] of Object.entries(normalized)) {
    safeInteger(value, `Run execution policy ${name}`, name === "maxCostMicros" || name === "maxTokens" ? 0 : 1);
  }
  if (normalized.maxInflight > normalized.maxTasks) {
    throw new Error("Run execution policy maxInflight cannot exceed maxTasks");
  }
  if (normalized.maxReady > normalized.maxTasks || normalized.maxBlocked > normalized.maxTasks) {
    throw new Error("Run execution policy ready and blocked bounds cannot exceed maxTasks");
  }
  return normalized;
};

const isTerminal = (status: TaskGraphTaskStatus): boolean => TERMINAL_STATUSES.has(status);

const copyRecord = (record: MutableTaskRecord): MutableTaskRecord => ({
  ...record,
  definition: record.definition,
  ...(record.outcome ? { outcome: record.outcome } : {}),
});

const taskDepth = (
  taskId: string,
  records: ReadonlyMap<string, MutableTaskRecord>,
): number => {
  const visited = new Set([taskId]);
  let parentTaskId = records.get(taskId)?.definition.parentTaskId;
  let depth = 0;
  while (parentTaskId) {
    depth += 1;
    if (visited.has(parentTaskId)) throw new Error(`Task hierarchy contains a cycle at ${parentTaskId}`);
    visited.add(parentTaskId);
    const parent = records.get(parentTaskId);
    if (!parent) throw new Error(`Task ${taskId} references unknown parent ${parentTaskId}`);
    parentTaskId = parent.definition.parentTaskId;
  }
  return depth;
};

const assertAcyclicDependencies = (
  records: ReadonlyMap<string, MutableTaskRecord>,
): void => {
  const visitState = new Map<string, "visiting" | "visited">();
  const visit = (taskId: string): void => {
    if (visitState.get(taskId) === "visiting") throw new Error(`Task dependency graph contains a cycle at ${taskId}`);
    if (visitState.get(taskId) === "visited") return;
    visitState.set(taskId, "visiting");
    const record = records.get(taskId);
    if (!record) throw new Error(`Task dependency ${taskId} does not exist`);
    for (const dependency of record.definition.dependencies) {
      if (!records.has(dependency.taskId)) {
        throw new Error(`Task ${taskId} references unknown dependency ${dependency.taskId}`);
      }
      visit(dependency.taskId);
    }
    visitState.set(taskId, "visited");
  };
  for (const taskId of records.keys()) visit(taskId);
};

type JoinEvaluation = "ready" | "blocked" | "impossible";

export type TaskJoinRecord = Pick<TaskGraphTaskRecord, "status" | "continuationTaskId">;

/**
 * A delegated task keeps its durable identity, while its explicit continuation
 * becomes the effective prerequisite for already-authored downstream work.
 * Following the chain here lets a task pause for bounded peer work without
 * invalidating dependants that were admitted before the discussion emerged.
 */
export const effectiveTaskRecord = <Record extends TaskJoinRecord>(
  taskId: string,
  records: ReadonlyMap<string, Record>,
): Record | undefined => {
  const seen = new Set<string>();
  let currentTaskId = taskId;
  while (true) {
    if (seen.has(currentTaskId)) {
      throw new Error(`Task continuation chain contains a cycle at ${currentTaskId}`);
    }
    seen.add(currentTaskId);
    const record = records.get(currentTaskId);
    if (!record?.continuationTaskId) return record;
    currentTaskId = record.continuationTaskId;
  }
};

export const effectiveTaskStatus = (
  taskId: string,
  records: ReadonlyMap<string, TaskJoinRecord>,
): TaskGraphTaskStatus | undefined => effectiveTaskRecord(taskId, records)?.status;

export const evaluateTaskJoin = (
  definition: DynamicTaskDefinition,
  records: ReadonlyMap<string, TaskJoinRecord>,
): JoinEvaluation => {
  if (definition.dependencies.length === 0) return "ready";
  const dependencies = definition.dependencies.map((dependency) => ({
    dependency,
    status: effectiveTaskStatus(dependency.taskId, records),
  }));
  if (dependencies.some(({ status }) => !status)) {
    throw new Error(`Task ${definition.taskId} has an unknown dependency`);
  }
  const accepted = dependencies.filter(({ status }) => status === "accepted").length;
  const terminal = dependencies.filter(({ status }) => isTerminal(status!)).length;
  const nonacceptedTerminal = dependencies.filter(({ status }) => isTerminal(status!) && status !== "accepted");
  switch (definition.join.kind) {
    case "all-success":
      if (accepted === dependencies.length) return "ready";
      return nonacceptedTerminal.length > 0 ? "impossible" : "blocked";
    case "all-terminal":
      if (nonacceptedTerminal.some(({ dependency }) => dependency.condition !== "terminal")) return "impossible";
      return terminal === dependencies.length ? "ready" : "blocked";
    case "any-success":
      if (accepted > 0) return "ready";
      return terminal === dependencies.length ? "impossible" : "blocked";
    case "quorum": {
      if (accepted >= definition.join.count) return "ready";
      const possible = accepted + dependencies.length - terminal;
      return possible < definition.join.count ? "impossible" : "blocked";
    }
  }
};

const refreshRecords = (
  records: Map<string, MutableTaskRecord>,
  now = Date.now(),
): void => {
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of [...records.values()].sort((left, right) =>
      left.definition.taskId.localeCompare(right.definition.taskId))) {
      if (record.status === "waiting" && record.continuationTaskId) {
        const continuation = records.get(record.continuationTaskId);
        if (continuation && isTerminal(continuation.status)) {
          record.status = "skipped";
          record.error = `continued by ${continuation.definition.taskId} (${continuation.status})`;
          changed = true;
        }
        continue;
      }
      if (record.status !== "pending" && record.status !== "ready") continue;
      if (record.retryAt !== undefined && record.retryAt > now) continue;
      delete record.retryAt;
      const evaluation = evaluateTaskJoin(record.definition, records);
      const status = evaluation === "ready" ? "ready" : evaluation === "impossible" ? "skipped" : "pending";
      if (record.status !== status) {
        record.status = status;
        if (status === "skipped") record.error = "join policy became impossible";
        changed = true;
      }
    }
  }
};

const assertGraphBounds = (
  policy: RunExecutionPolicy,
  records: ReadonlyMap<string, MutableTaskRecord>,
): void => {
  if (records.size > policy.maxTasks) throw new Error(`Task graph exceeds maxTasks=${policy.maxTasks}`);
  let estimatedCost = 0;
  const children = new Map<string, number>();
  for (const record of records.values()) {
    const depth = taskDepth(record.definition.taskId, records);
    if (depth > policy.maxDepth) {
      throw new Error(`Task ${record.definition.taskId} exceeds maxDepth=${policy.maxDepth}`);
    }
    if (record.definition.parentTaskId) {
      const count = (children.get(record.definition.parentTaskId) ?? 0) + 1;
      if (count > policy.maxFanout) {
        throw new Error(`Task ${record.definition.parentTaskId} exceeds maxFanout=${policy.maxFanout}`);
      }
      children.set(record.definition.parentTaskId, count);
    }
    estimatedCost += record.definition.estimatedCostMicros;
  }
  if (estimatedCost > policy.maxCostMicros) {
    throw new Error(`Task graph estimated cost exceeds maxCostMicros=${policy.maxCostMicros}`);
  }
  const ready = [...records.values()].filter((record) => record.status === "ready").length;
  const blocked = [...records.values()].filter((record) =>
    record.status === "pending" || record.status === "waiting").length;
  if (ready > policy.maxReady) throw new Error(`Task graph exceeds maxReady=${policy.maxReady}`);
  if (blocked > policy.maxBlocked) throw new Error(`Task graph exceeds maxBlocked=${policy.maxBlocked}`);
};

export const taskGraphExpansionHash = (
  input: Pick<TaskGraphExpansionInput, "parentTaskId" | "expansionKey" | "definitions" | "continuationTaskId">,
): string => hashCanonical({
  parentTaskId: input.parentTaskId,
  expansionKey: input.expansionKey,
  continuationTaskId: input.continuationTaskId,
  definitions: input.definitions
    .map((definition) => ({ taskId: definition.taskId, definitionHash: definition.definitionHash }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId)),
});

const expansionId = (parentTaskId: string, expansionKey: string): string =>
  `expansion_${hashCanonical([parentTaskId, expansionKey])}`;

/**
 * Revalidates the durable proof that retired parent work was replaced by one
 * exact bounded child frontier and continuation. This is shared by snapshot
 * authorities and read models so no adapter can bless a weaker expansion.
 */
export const validateTaskGraphSnapshotExpansions = (
  snapshot: Pick<TaskGraphSnapshot, "policy" | "tasks" | "expansions">,
): void => {
  const taskById = new Map<string, TaskGraphTaskRecord>();
  const childIdsByParent = new Map<string, string[]>();
  for (const task of snapshot.tasks) {
    const definition = validateDynamicTaskDefinition(task.definition, snapshot.policy);
    if (taskById.has(definition.taskId)) {
      throw new Error(`Task graph snapshot repeats task ${definition.taskId}`);
    }
    taskById.set(definition.taskId, task);
    if (definition.parentTaskId) {
      const childIds = childIdsByParent.get(definition.parentTaskId) ?? [];
      childIds.push(definition.taskId);
      childIdsByParent.set(definition.parentTaskId, childIds);
    }
  }

  const expansionParents = new Set<string>();
  const expansionContinuations = new Set<string>();
  const expansionIds = new Set<string>();
  for (const expansion of snapshot.expansions) {
    const parentTaskId = assertId(expansion.parentTaskId, "Expansion parent task");
    const expansionKey = assertId(expansion.expansionKey, "Expansion key");
    const continuationTaskId = assertId(
      expansion.continuationTaskId,
      "Expansion continuation task",
    );
    const id = expansionId(parentTaskId, expansionKey);
    if (expansionIds.has(id)) throw new Error(`Task graph snapshot repeats expansion ${id}`);
    if (expansionParents.has(parentTaskId)) {
      throw new Error(`Task graph snapshot has multiple expansions for parent ${parentTaskId}`);
    }
    if (expansionContinuations.has(continuationTaskId)) {
      throw new Error(
        `Task graph snapshot has multiple expansions for continuation ${continuationTaskId}`,
      );
    }
    expansionIds.add(id);
    expansionParents.add(parentTaskId);
    expansionContinuations.add(continuationTaskId);

    const parent = taskById.get(parentTaskId);
    if (!parent) throw new Error(`Snapshot expansion ${id} has no parent task`);
    if (
      (parent.status !== "waiting" && parent.status !== "skipped" && parent.status !== "canceled")
      || parent.leaseOwner !== undefined
      || parent.continuationTaskId !== continuationTaskId
      || parent.attempt < 1
    ) {
      throw new Error(`Snapshot expansion ${id} has no retired parent admission`);
    }
    safeInteger(expansion.publishedFence, `Snapshot expansion ${id} published fence`, 1);
    if (expansion.publishedFence !== parent.leaseFence) {
      throw new Error(`Snapshot expansion ${id} changed its retired lease fence`);
    }

    if (expansion.childTaskIds.length < 1) {
      throw new Error(`Snapshot expansion ${id} requires at least one child`);
    }
    const childTaskIds = expansion.childTaskIds.map((taskId) =>
      assertId(taskId, `Snapshot expansion ${id} child task`));
    if (
      new Set(childTaskIds).size !== childTaskIds.length
      || childTaskIds.includes(continuationTaskId)
    ) {
      throw new Error(`Snapshot expansion ${id} has ambiguous child identities`);
    }
    const exactOwnedTaskIds = [...(childIdsByParent.get(parentTaskId) ?? [])].sort();
    const claimedOwnedTaskIds = [...childTaskIds, continuationTaskId].sort();
    if (hashCanonical(exactOwnedTaskIds) !== hashCanonical(claimedOwnedTaskIds)) {
      throw new Error(`Snapshot expansion ${id} changed child identity`);
    }

    const continuation = taskById.get(continuationTaskId);
    if (!continuation || continuation.definition.parentTaskId !== parentTaskId) {
      throw new Error(`Snapshot expansion ${id} has an invalid continuation identity`);
    }
    if (
      (parent.status === "waiting" && isTerminal(continuation.status))
      || (parent.status === "skipped" && !isTerminal(continuation.status))
    ) {
      throw new Error(`Snapshot expansion ${id} has an invalid parent/continuation status relation`);
    }
    const continuationDependencies = new Set(
      continuation.definition.dependencies.map((dependency) => dependency.taskId),
    );
    const definitions: DynamicTaskDefinition[] = [];
    for (const childTaskId of childTaskIds) {
      const child = taskById.get(childTaskId);
      if (!child || child.definition.parentTaskId !== parentTaskId) {
        throw new Error(`Snapshot expansion ${id} has invalid child ${childTaskId}`);
      }
      if (!continuationDependencies.has(childTaskId)) {
        throw new Error(`Snapshot expansion ${id} omits child dependency ${childTaskId}`);
      }
      definitions.push(validateDynamicTaskDefinition(child.definition, snapshot.policy));
    }
    definitions.push(validateDynamicTaskDefinition(continuation.definition, snapshot.policy));
    const expectedHash = taskGraphExpansionHash({
      parentTaskId,
      expansionKey,
      continuationTaskId,
      definitions,
    });
    if (expectedHash !== expansion.expansionHash) {
      throw new Error(`Snapshot expansion ${id} has an invalid hash`);
    }
  }
};

export class InMemoryTaskGraphStore {
  readonly policy: RunExecutionPolicy;
  private records = new Map<string, MutableTaskRecord>();
  private expansions = new Map<string, TaskGraphExpansion>();
  private semantics = new Map<string, string>();
  private acceptedCostMicros = 0;
  private acceptedTokens = 0;

  constructor(policy: RunExecutionPolicy, definitions: ReadonlyArray<DynamicTaskDefinition> = [], private readonly clock: Clock = systemClock) {
    this.policy = normalizePolicy(policy);
    if (definitions.length > 0) this.seed(definitions);
  }

  seed(definitions: ReadonlyArray<DynamicTaskDefinition>): void {
    if (this.records.size > 0) throw new Error("Task graph has already been seeded");
    const candidateRecords = new Map<string, MutableTaskRecord>();
    const candidateSemantics = new Map<string, string>();
    for (const raw of definitions) {
      const definition = validateDynamicTaskDefinition(raw, this.policy);
      if (candidateRecords.has(definition.taskId)) throw new Error(`Duplicate task id ${definition.taskId}`);
      const semanticOwner = candidateSemantics.get(definition.semanticKey);
      if (semanticOwner) {
        throw new Error(`Task ${definition.taskId} duplicates semantic work owned by ${semanticOwner}`);
      }
      candidateSemantics.set(definition.semanticKey, definition.taskId);
      candidateRecords.set(definition.taskId, {
        definition,
        status: "pending",
        attempt: 0,
        leaseFence: 0,
      });
    }
    assertAcyclicDependencies(candidateRecords);
    refreshRecords(candidateRecords, this.clock.now());
    assertGraphBounds(this.policy, candidateRecords);
    this.records = candidateRecords;
    this.semantics = candidateSemantics;
  }

  enqueue(raw: DynamicTaskDefinition): TaskGraphTaskRecord {
    const definition = validateDynamicTaskDefinition(raw, this.policy);
    if (definition.parentTaskId) {
      throw new Error(`Enqueued root task ${definition.taskId} must not name a parent task`);
    }
    const existing = this.records.get(definition.taskId);
    if (existing) {
      if (existing.definition.definitionHash !== definition.definitionHash) {
        throw new Error(`Enqueued task ${definition.taskId} changed after admission`);
      }
      return copyRecord(existing);
    }
    const semanticOwner = this.semantics.get(definition.semanticKey);
    if (semanticOwner) {
      throw new Error(`Task ${definition.taskId} duplicates semantic work owned by ${semanticOwner}`);
    }
    const candidateRecords = new Map(
      [...this.records].map(([taskId, record]) => [taskId, copyRecord(record)]),
    );
    const candidateSemantics = new Map(this.semantics);
    candidateRecords.set(definition.taskId, {
      definition,
      status: "pending",
      attempt: 0,
      leaseFence: 0,
    });
    candidateSemantics.set(definition.semanticKey, definition.taskId);
    assertAcyclicDependencies(candidateRecords);
    refreshRecords(candidateRecords, this.clock.now());
    assertGraphBounds(this.policy, candidateRecords);
    this.records = candidateRecords;
    this.semantics = candidateSemantics;
    return copyRecord(this.records.get(definition.taskId)!);
  }

  task(taskId: string): TaskGraphTaskRecord | undefined {
    const record = this.records.get(taskId);
    return record ? copyRecord(record) : undefined;
  }

  tasks(): ReadonlyArray<TaskGraphTaskRecord> {
    return [...this.records.values()]
      .map(copyRecord)
      .sort((left, right) => left.definition.taskId.localeCompare(right.definition.taskId));
  }

  ready(): ReadonlyArray<DynamicTaskDefinition> {
    refreshRecords(this.records, this.clock.now());
    return [...this.records.values()]
      .filter((record) => record.status === "ready")
      .map((record) => record.definition)
      .sort((left, right) => left.taskId.localeCompare(right.taskId));
  }

  lease(taskId: string, owner: string): TaskGraphLease {
    const record = this.records.get(taskId);
    if (!record) throw new Error(`Task ${taskId} does not exist`);
    if (record.status !== "ready") throw new Error(`Task ${taskId} is not ready`);
    const inflight = [...this.records.values()].filter((candidate) =>
      candidate.status === "leased" || candidate.status === "running").length;
    if (inflight >= this.policy.maxInflight) {
      throw new Error(`Task graph reached maxInflight=${this.policy.maxInflight}`);
    }
    if (record.attempt >= Math.min(record.definition.retry.maxAttempts, this.policy.maxAttempts)) {
      throw new Error(`Task ${taskId} exhausted its attempts`);
    }
    record.attempt += 1;
    record.leaseFence += 1;
    record.leaseOwner = assertId(owner, "Task lease owner");
    record.status = "leased";
    record.error = undefined;
    return {
      taskId,
      owner: record.leaseOwner,
      fence: record.leaseFence,
      attempt: record.attempt,
      definition: record.definition,
    };
  }

  leaseNext(owner: string): TaskGraphLease | undefined {
    const task = this.ready()[0];
    return task ? this.lease(task.taskId, owner) : undefined;
  }

  start(
    lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">,
    contextManifest?: TaskContextManifest,
  ): void {
    const record = this.requireLease(lease);
    const manifest = validateTaskContextManifest(contextManifest ?? createTaskContextManifest({
      runId: "process-local",
      definition: record.definition,
      attempt: record.attempt,
      fence: record.leaseFence,
      executionGrant: createTaskExecutionGrant({
        runId: "process-local",
        definition: record.definition,
        attempt: record.attempt,
        fence: record.leaseFence,
        policyVersion: "roster.process-local.default.v1",
        policy: this.policy,
        allowGraphExpansion: true,
      }),
    }));
    if (
      manifest.runId.trim().length === 0
      || manifest.taskId !== record.definition.taskId
      || manifest.nodeId !== record.definition.nodeId
      || manifest.attempt !== record.attempt
      || manifest.fence !== record.leaseFence
      || manifest.frontierVersion !== record.definition.inputs.frontierVersion
      || manifest.topologyVersion !== record.definition.inputs.topologyVersion
      || manifest.catalogVersion !== record.definition.inputs.catalogVersion
      || manifest.bindingVersion !== record.definition.runtimeBindingEpoch
    ) {
      throw new Error(`Task ${lease.taskId} context manifest does not match its exact execution fence`);
    }
    if (record.status === "running") {
      if (record.contextManifest?.manifestId !== manifest.manifestId) {
        throw new Error(`Task ${lease.taskId} context manifest changed after start`);
      }
      return;
    }
    if (record.status !== "leased") throw new Error(`Task ${lease.taskId} cannot start while ${record.status}`);
    record.contextManifest = manifest;
    record.status = "running";
  }

  expand(input: TaskGraphExpansionInput): TaskGraphExpansion {
    const parentTaskId = assertId(input.parentTaskId, "Expansion parent task");
    const expansionKey = assertId(input.expansionKey, "Expansion key");
    const continuationTaskId = assertId(input.continuationTaskId, "Expansion continuation task");
    const normalizedDefinitions = input.definitions.map((definition) =>
      validateDynamicTaskDefinition(definition, this.policy));
    const hash = taskGraphExpansionHash({
      parentTaskId,
      expansionKey,
      definitions: normalizedDefinitions,
      continuationTaskId,
    });
    const id = expansionId(parentTaskId, expansionKey);
    const existing = this.expansions.get(id);
    if (existing) {
      if (existing.expansionHash !== hash) {
        throw new Error(`Expansion ${expansionKey} changed after publication`);
      }
      return existing;
    }

    const parent = this.requireLease({
      taskId: parentTaskId,
      owner: input.owner,
      fence: input.fence,
    });
    if (parent.status !== "leased" && parent.status !== "running") {
      throw new Error(`Expansion parent ${parentTaskId} is not active`);
    }
    if (normalizedDefinitions.length < 2) {
      throw new Error("Expansion requires at least one child and one explicit continuation");
    }
    const childIds = new Set(normalizedDefinitions.map((definition) => definition.taskId));
    if (!childIds.has(continuationTaskId)) {
      throw new Error(`Expansion continuation ${continuationTaskId} is not part of the expansion`);
    }
    for (const definition of normalizedDefinitions) {
      if (definition.parentTaskId !== parentTaskId) {
        throw new Error(`Expanded task ${definition.taskId} must name parent ${parentTaskId}`);
      }
    }
    const continuation = normalizedDefinitions.find((definition) => definition.taskId === continuationTaskId)!;
    const workIds = normalizedDefinitions
      .map((definition) => definition.taskId)
      .filter((taskId) => taskId !== continuationTaskId)
      .sort();
    const continuationDependencies = new Set(continuation.dependencies.map((dependency) => dependency.taskId));
    for (const workId of workIds) {
      if (!continuationDependencies.has(workId)) {
        throw new Error(`Continuation ${continuationTaskId} must depend on expanded task ${workId}`);
      }
    }

    const candidateRecords = new Map([...this.records].map(([taskId, record]) => [taskId, copyRecord(record)]));
    const candidateSemantics = new Map(this.semantics);
    for (const definition of normalizedDefinitions) {
      if (candidateRecords.has(definition.taskId)) throw new Error(`Child task ${definition.taskId} already exists`);
      const semanticOwner = candidateSemantics.get(definition.semanticKey);
      if (semanticOwner) {
        throw new Error(`Task ${definition.taskId} duplicates semantic work owned by ${semanticOwner}`);
      }
      candidateSemantics.set(definition.semanticKey, definition.taskId);
      candidateRecords.set(definition.taskId, {
        definition,
        status: "pending",
        attempt: 0,
        leaseFence: 0,
      });
    }
    assertAcyclicDependencies(candidateRecords);
    const candidateParent = candidateRecords.get(parentTaskId)!;
    candidateParent.status = "waiting";
    candidateParent.leaseOwner = undefined;
    candidateParent.continuationTaskId = continuationTaskId;
    refreshRecords(candidateRecords, this.clock.now());
    assertGraphBounds(this.policy, candidateRecords);

    const expansion: TaskGraphExpansion = {
      parentTaskId,
      expansionKey,
      expansionHash: hash,
      publishedFence: input.fence,
      childTaskIds: workIds,
      continuationTaskId,
    };
    this.records = candidateRecords;
    this.semantics = candidateSemantics;
    this.expansions.set(id, expansion);
    return expansion;
  }

  accept(
    lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">,
    rawOutcome: AcceptedTaskOutcome,
  ): AcceptedTaskOutcome {
    const existing = this.records.get(lease.taskId);
    if (
      existing?.status === "accepted"
      && existing.outcome?.outcomeId === rawOutcome.outcomeId
    ) {
      return existing.outcome;
    }
    const record = this.requireLease(lease);
    if (record.status !== "leased" && record.status !== "running") {
      throw new Error(`Task ${lease.taskId} cannot accept an outcome while ${record.status}`);
    }
    const expected = createAcceptedTaskOutcome({
      runId: rawOutcome.runId,
      taskId: rawOutcome.taskId,
      nodeId: rawOutcome.nodeId,
      attempt: rawOutcome.attempt,
      definitionHash: rawOutcome.definitionHash,
      inputVersions: rawOutcome.inputVersions,
      frontierVersion: rawOutcome.frontierVersion,
      topologyVersion: rawOutcome.topologyVersion,
      catalogVersion: rawOutcome.catalogVersion,
      acceptancePolicyId: rawOutcome.acceptancePolicyId,
      acceptancePolicyVersion: rawOutcome.acceptancePolicyVersion,
      artifacts: rawOutcome.artifacts,
      ...(rawOutcome.usage ? { usage: rawOutcome.usage } : {}),
    });
    if (rawOutcome.schemaVersion !== ROSTER_TASK_OUTCOME_VERSION || rawOutcome.outcomeId !== expected.outcomeId) {
      throw new Error(`Task ${lease.taskId} has an invalid accepted outcome identity`);
    }
    const definition = record.definition;
    if (
      expected.taskId !== definition.taskId
      || expected.nodeId !== definition.nodeId
      || expected.attempt !== record.attempt
      || expected.definitionHash !== definition.definitionHash
      || hashCanonical(expected.inputVersions) !== hashCanonical(definition.inputs.inputVersions)
      || expected.frontierVersion !== definition.inputs.frontierVersion
      || expected.topologyVersion !== definition.inputs.topologyVersion
      || expected.catalogVersion !== definition.inputs.catalogVersion
      || expected.acceptancePolicyId !== definition.acceptance.policyId
      || expected.acceptancePolicyVersion !== definition.acceptance.policyVersion
    ) {
      throw new Error(`Task ${lease.taskId} accepted outcome does not match its definition`);
    }
    if (definition.result.mode === "none" && expected.artifacts.length !== 0) {
      throw new Error(`Task ${lease.taskId} must not publish an artifact`);
    }
    const result = definition.result;
    if (result.mode !== "none") {
      const matching = expected.artifacts.filter((artifact) => artifact.outputKey === result.outputKey);
      if (matching.length !== 1) {
        throw new Error(`Task ${lease.taskId} must publish exactly one ${result.outputKey} artifact`);
      }
    }
    const acceptedBytes = expected.artifacts.reduce((total, artifact) => total + artifact.byteLength, 0);
    if (acceptedBytes > this.policy.maxContextBytes) {
      throw new Error(`Task ${lease.taskId} accepted artifacts exceed maxContextBytes=${this.policy.maxContextBytes}`);
    }
    const nextCost = this.acceptedCostMicros + definition.estimatedCostMicros;
    const nextTokens = this.acceptedTokens + budgetedExecutionTokens(expected.usage);
    if (nextCost > this.policy.maxCostMicros) throw new Error("Accepted task cost exceeds the run budget");
    if (nextTokens > this.policy.maxTokens) throw new Error("Accepted task tokens exceed the run budget");
    record.status = "accepted";
    record.outcome = expected;
    record.leaseOwner = undefined;
    this.acceptedCostMicros = nextCost;
    this.acceptedTokens = nextTokens;
    refreshRecords(this.records, this.clock.now());
    return expected;
  }

  fail(
    lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">,
    error: string,
    retryable = true,
  ): void {
    const record = this.requireLease(lease);
    const retryLimit = Math.min(record.definition.retry.maxAttempts, this.policy.maxAttempts);
    if (record.definition.sideEffect === "non-repeatable" && record.attempt > 0) retryable = false;
    record.status = retryable && record.attempt < retryLimit ? "pending" : "failed";
    if (record.status === "pending") {
      const retry = record.definition.retry;
      const delay = Math.min(retry.maximumBackoffMs, retry.initialBackoffMs * 2 ** Math.min(30, record.attempt - 1));
      if (delay > 0) record.retryAt = this.clock.now() + delay;
    }
    record.error = assertText(error, `Task ${lease.taskId} error`, 4_000);
    record.leaseOwner = undefined;
    refreshRecords(this.records, this.clock.now());
  }

  cancel(
    taskId: string,
    reason: string,
    lease?: Pick<TaskGraphLease, "taskId" | "owner" | "fence">,
  ): void {
    const record = lease ? this.requireLease(lease) : this.records.get(taskId);
    if (!record) throw new Error(`Task ${taskId} does not exist`);
    if (isTerminal(record.status)) return;
    record.status = "canceled";
    delete record.retryAt;
    record.error = assertText(reason, `Task ${taskId} cancellation reason`, 2_000);
    record.leaseOwner = undefined;
    refreshRecords(this.records, this.clock.now());
  }

  recoverInterruptedLeases(reason = "dispatcher lease was interrupted before a durable outcome"): number {
    const error = assertText(reason, "Interrupted lease recovery reason", 2_000);
    let recovered = 0;
    for (const record of this.records.values()) {
      if (record.status !== "leased" && record.status !== "running") continue;
      const retryLimit = Math.min(record.definition.retry.maxAttempts, this.policy.maxAttempts);
      const retryable = record.definition.sideEffect !== "non-repeatable" && record.attempt < retryLimit;
      record.status = retryable ? "pending" : "failed";
      record.error = error;
      record.leaseOwner = undefined;
      recovered += 1;
    }
    refreshRecords(this.records, this.clock.now());
    return recovered;
  }

  quiescence(): TaskGraphQuiescence {
    refreshRecords(this.records, this.clock.now());
    const statuses = this.tasks().map((record) => record.status);
    const ready = statuses.filter((status) => status === "ready").length;
    const inflight = statuses.filter((status) => status === "leased" || status === "running").length;
    const waiting = statuses.filter((status) => status === "waiting").length;
    const blocked = statuses.filter((status) => status === "pending").length;
    const terminal = statuses.filter(isTerminal).length;
    const scheduled = this.tasks().filter((record) => record.status === "pending" && record.retryAt !== undefined).length;
    const actionable = ready + inflight + scheduled;
    return {
      quiescent: actionable === 0,
      deadlocked: actionable === 0 && terminal < statuses.length,
      ready,
      inflight,
      waiting,
      blocked,
      terminal,
      total: statuses.length,
    };
  }

  snapshot(): TaskGraphSnapshot {
    refreshRecords(this.records, this.clock.now());
    return {
      policy: { ...this.policy },
      tasks: this.tasks(),
      expansions: [...this.expansions.values()].sort((left, right) =>
        left.parentTaskId.localeCompare(right.parentTaskId)
        || left.expansionKey.localeCompare(right.expansionKey)),
      acceptedCostMicros: this.acceptedCostMicros,
      acceptedTokens: this.acceptedTokens,
    };
  }

  static restore(snapshot: TaskGraphSnapshot, clock: Clock = systemClock): InMemoryTaskGraphStore {
    validateTaskGraphSnapshotExpansions(snapshot);
    const store = new InMemoryTaskGraphStore(snapshot.policy, [], clock);
    const records = new Map<string, MutableTaskRecord>();
    const semantics = new Map<string, string>();
    for (const raw of snapshot.tasks) {
      const definition = validateDynamicTaskDefinition(raw.definition, store.policy);
      if (records.has(definition.taskId)) throw new Error(`Snapshot repeats task ${definition.taskId}`);
      if (semantics.has(definition.semanticKey)) throw new Error(`Snapshot repeats semantic key ${definition.semanticKey}`);
      if (raw.attempt < 0 || raw.leaseFence < raw.attempt) {
        throw new Error(`Snapshot task ${definition.taskId} has invalid lease counters`);
      }
      if (raw.retryAt !== undefined) {
        safeInteger(raw.retryAt, `Snapshot task ${definition.taskId} retryAt`, 0);
        if (raw.status !== "pending" || raw.attempt === 0) {
          throw new Error(`Snapshot task ${definition.taskId} has invalid retry state`);
        }
      }
      records.set(definition.taskId, {
        ...raw,
        definition,
      });
      semantics.set(definition.semanticKey, definition.taskId);
    }
    assertAcyclicDependencies(records);
    refreshRecords(records, clock.now());
    assertGraphBounds(store.policy, records);
    store.records = records;
    store.semantics = semantics;
    for (const expansion of snapshot.expansions) {
      const id = expansionId(expansion.parentTaskId, expansion.expansionKey);
      if (store.expansions.has(id)) throw new Error(`Snapshot repeats expansion ${id}`);
      store.expansions.set(id, { ...expansion });
    }
    safeInteger(snapshot.acceptedCostMicros, "Snapshot accepted cost", 0);
    safeInteger(snapshot.acceptedTokens, "Snapshot accepted tokens", 0);
    store.acceptedCostMicros = snapshot.acceptedCostMicros;
    store.acceptedTokens = snapshot.acceptedTokens;
    return store;
  }

  private requireLease(lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">): MutableTaskRecord {
    const record = this.records.get(lease.taskId);
    if (!record) throw new Error(`Task ${lease.taskId} does not exist`);
    if (record.leaseFence !== lease.fence || record.leaseOwner !== lease.owner) {
      throw new Error(`Task ${lease.taskId} has a stale lease fence`);
    }
    return record;
  }
}

export type DynamicTaskHandlerContext = {
  readonly definition: DynamicTaskDefinition;
  readonly lease: TaskGraphLease;
  readonly attempt: number;
  /** Exact durable authority admitted atomically before this task started. */
  readonly executionGrant: TaskExecutionGrant;
  readonly signal: AbortSignal;
  /**
   * Records trusted runtime usage for the accepted attempt. Model-visible
   * execution options never receive this authority.
   */
  readonly reportUsage: (usage: NodeExecutionUsage) => void;
  readonly dependencyOutcomes: Readonly<Record<string, AcceptedTaskOutcome | undefined>>;
  readonly dependencyDataReferences: Readonly<
    Record<string, ReadonlyArray<TaskGraphOutcomeDataReference>>
  >;
  readonly readDataReference: DataReferenceStore["read"];
  readonly task: (taskId: string) => Promise<TaskGraphTaskRecord | undefined>;
  readonly expand: (
    input: Omit<TaskGraphExpansionInput, "parentTaskId" | "fence" | "owner">,
  ) => Promise<TaskGraphExpansion>;
};

export type DynamicTaskHandler = (
  context: DynamicTaskHandlerContext,
) => Promise<unknown>;

export class DynamicTaskHandlerRegistry {
  private readonly handlers = new Map<string, DynamicTaskHandler>();

  register(reference: DynamicTaskDefinition["handler"], handler: DynamicTaskHandler): void {
    const key = `${assertId(reference.kind, "Task handler kind")}@${assertText(reference.version, "Task handler version", 120)}`;
    if (this.handlers.has(key)) throw new Error(`Task handler ${key} is already registered`);
    this.handlers.set(key, handler);
  }

  resolve(reference: DynamicTaskDefinition["handler"]): DynamicTaskHandler {
    const key = `${reference.kind}@${reference.version}`;
    const handler = this.handlers.get(key);
    if (!handler) throw new Error(`No dynamic task handler is registered for ${key}`);
    return handler;
  }
}

export type DynamicTaskAcceptance = (input: {
  readonly runId: string;
  readonly definition: DynamicTaskDefinition;
  readonly attempt: number;
  readonly draft: unknown;
}) => Promise<AcceptedTaskOutcome>;

export class DynamicTaskAcceptanceRegistry {
  private readonly policies = new Map<string, DynamicTaskAcceptance>();

  register(reference: DynamicTaskDefinition["acceptance"], accept: DynamicTaskAcceptance): void {
    const key = `${assertId(reference.policyId, "Acceptance policy id")}@${assertText(reference.policyVersion, "Acceptance policy version", 120)}`;
    if (this.policies.has(key)) throw new Error(`Acceptance policy ${key} is already registered`);
    this.policies.set(key, accept);
  }

  resolve(reference: DynamicTaskDefinition["acceptance"]): DynamicTaskAcceptance {
    const key = `${reference.policyId}@${reference.policyVersion}`;
    const accept = this.policies.get(key);
    if (!accept) throw new Error(`No dynamic task acceptance policy is registered for ${key}`);
    return accept;
  }
}

const acceptedPresentationText = (
  definition: DynamicTaskDefinition,
  draft: unknown,
): string | undefined => {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return undefined;
  if (definition.result.mode === "none") return undefined;
  const record = draft as Readonly<Record<string, unknown>>;
  const declaredOutput = record[definition.result.outputKey];
  const result = declaredOutput && typeof declaredOutput === "object" && !Array.isArray(declaredOutput)
    ? declaredOutput as Readonly<Record<string, unknown>>
    : record;
  const summary = result.summary;
  return typeof summary === "string" && summary.trim()
    ? summary.trim().slice(0, 1_600)
    : undefined;
};

const acceptedInlineArtifact = (
  definition: DynamicTaskDefinition,
  draft: unknown,
): AcceptedArtifactReference => {
  if (definition.result.mode === "none") throw new Error(`Task ${definition.taskId} has no result artifact`);
  let value: JsonValue;
  let encoded: string;
  let mediaType: string;
  let kind: string;
  if (definition.result.mode === "text") {
    if (typeof draft !== "string") throw new Error(`Task ${definition.taskId} must return natural text`);
    value = draft;
    encoded = draft;
    mediaType = "text/plain";
    kind = "text";
  } else if (definition.result.mode === "json") {
    if (draft === undefined) throw new Error(`Task ${definition.taskId} returned no JSON result`);
    if (
      typeof definition.result.schema !== "boolean"
      && (
        !definition.result.schema
        || typeof definition.result.schema !== "object"
        || Array.isArray(definition.result.schema)
      )
    ) {
      throw new Error(`Task ${definition.taskId} has an invalid JSON result schema`);
    }
    let validate: ReturnType<typeof RESULT_SCHEMA_VALIDATOR.compile>;
    try {
      validate = RESULT_SCHEMA_VALIDATOR.compile(definition.result.schema);
    } catch (error) {
      throw new Error(
        `Task ${definition.taskId} has an invalid JSON result schema: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!validate(draft)) {
      const detail = validate.errors?.map((error) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ?? "is invalid";
      throw new Error(`Task ${definition.taskId} JSON result violates its schema: ${detail}`);
    }
    encoded = JSON.stringify(draft);
    if (encoded === undefined) throw new Error(`Task ${definition.taskId} returned non-serializable JSON`);
    value = JSON.parse(encoded) as JsonValue;
    mediaType = "application/json";
    kind = "json";
  } else {
    throw new Error(`Task ${definition.taskId} artifact results require a domain acceptance policy`);
  }
  const contentHash = hashCanonical(value);
  const presentationText = acceptedPresentationText(definition, value);
  return {
    artifactId: `artifact_${contentHash.slice(0, 28)}`,
    outputKey: definition.result.outputKey,
    kind,
    contentHash,
    mediaType,
    byteLength: Buffer.byteLength(encoded),
    storage: "inline",
    ...(presentationText ? { presentationText } : {}),
  };
};

const acceptedDataReferenceValue = (
  definition: DynamicTaskDefinition,
  draft: unknown,
): JsonValue | undefined => {
  if (definition.result.mode === "text") {
    if (typeof draft !== "string") throw new Error(`Task ${definition.taskId} must return natural text`);
    return draft;
  }
  if (definition.result.mode !== "json") return undefined;
  const encoded = JSON.stringify(draft);
  if (encoded === undefined) throw new Error(`Task ${definition.taskId} returned non-serializable JSON`);
  return JSON.parse(encoded) as JsonValue;
};

export const DEFAULT_DYNAMIC_ACCEPTANCE = {
  policyId: "roster.accept.default",
  policyVersion: "1",
} as const;

export const createDefaultDynamicTaskAcceptanceRegistry = (): DynamicTaskAcceptanceRegistry => {
  const registry = new DynamicTaskAcceptanceRegistry();
  registry.register(DEFAULT_DYNAMIC_ACCEPTANCE, async ({ runId, definition, attempt, draft }) =>
    createAcceptedTaskOutcome({
      runId,
      taskId: definition.taskId,
      nodeId: definition.nodeId,
      attempt,
      definitionHash: definition.definitionHash,
      inputVersions: definition.inputs.inputVersions,
      frontierVersion: definition.inputs.frontierVersion,
      topologyVersion: definition.inputs.topologyVersion,
      catalogVersion: definition.inputs.catalogVersion,
      acceptancePolicyId: definition.acceptance.policyId,
      acceptancePolicyVersion: definition.acceptance.policyVersion,
      artifacts: definition.result.mode === "none" ? [] : [acceptedInlineArtifact(definition, draft)],
    }));
  return registry;
};

export type DynamicTaskDispatcherOptions = {
  readonly runId: string;
  readonly control: TaskGraphControl;
  readonly handlers: DynamicTaskHandlerRegistry;
  readonly acceptance?: DynamicTaskAcceptanceRegistry;
  readonly dataReferences: DataReferenceStore;
  readonly owner?: string;
  readonly heartbeatMs?: number;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
  /** Exact repository placement supplied to a task, captured before start. */
  readonly contextRepository?: (
    definition: DynamicTaskDefinition,
  ) => TaskRepositoryPlacement | undefined;
  /** Roster-owned deterministic admission policy evaluated before task start. */
  readonly createExecutionGrant?: (input: {
    readonly runId: string;
    readonly definition: DynamicTaskDefinition;
    readonly lease: TaskGraphLease;
    readonly policy: RunExecutionPolicy;
  }) => Promise<TaskExecutionGrant> | TaskExecutionGrant;
  readonly resolveRuntimeBinding?: (
    definition: DynamicTaskDefinition,
  ) => WorkspaceNodeRuntimeBinding | undefined;
  readonly onSnapshot?: (snapshot: TaskGraphControlSnapshot) => Promise<void> | void;
  /**
   * Simulator-only cooperative interleaving for a ready batch. The dispatcher
   * remains the sole graph authority: every supplied entry must run exactly
   * once, and only TaskGraphControl may claim or transition work.
   */
  readonly readyBatchRunner?: DynamicTaskReadyBatchRunner;
};

export type DynamicTaskTransitionPhase =
  | "before-claim"
  | "after-claim"
  | "after-start"
  | "before-handler"
  | "after-handler"
  | "before-expand"
  | "after-expand"
  | "after-data-reference"
  | "before-accept"
  | "after-accept"
  | "before-fail"
  | "after-fail";

export type DynamicTaskTransitionCheckpoint = (
  phase: DynamicTaskTransitionPhase,
) => Promise<void>;

export type DynamicTaskReadyBatchEntry = {
  readonly taskId: string;
  readonly run: (checkpoint: DynamicTaskTransitionCheckpoint) => Promise<void>;
};

export type DynamicTaskReadyBatchRunner = (
  entries: ReadonlyArray<DynamicTaskReadyBatchEntry>,
) => Promise<void>;

export class DynamicTaskSchedulingError extends Error {
  override readonly name = "DynamicTaskSchedulingError";
}

const runReadyBatchConcurrently: DynamicTaskReadyBatchRunner = async (entries) => {
  await Promise.all(entries.map((entry) => entry.run(async () => {})));
};

export class DynamicTaskDispatcher {
  private readonly acceptance: DynamicTaskAcceptanceRegistry;
  private readonly owner: string;
  private readonly heartbeatMs: number;
  private readonly clock: Clock;

  constructor(private readonly options: DynamicTaskDispatcherOptions) {
    this.acceptance = options.acceptance ?? createDefaultDynamicTaskAcceptanceRegistry();
    this.owner = options.owner ?? "in-memory-dispatcher";
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
    this.clock = options.clock ?? systemClock;
    if (!Number.isSafeInteger(this.heartbeatMs) || this.heartbeatMs < 1 || this.heartbeatMs > 60_000) {
      throw new Error("Dynamic task dispatcher heartbeatMs must be between 1 and 60000");
    }
  }

  async dispatchUntilQuiescent(): Promise<TaskGraphQuiescence> {
    const startedAt = this.clock.now();
    while (true) {
      if (this.options.signal?.aborted) {
        throw this.options.signal.reason instanceof Error
          ? this.options.signal.reason
          : new Error("Dynamic task dispatcher was aborted");
      }
      const snapshot = await this.options.control.snapshot();
      await this.options.onSnapshot?.(snapshot);
      if (this.clock.now() - startedAt > snapshot.policy.maxWallTimeMs) {
        throw new Error(`Dynamic task graph exceeded maxWallTimeMs=${snapshot.policy.maxWallTimeMs}`);
      }
      const statuses = snapshot.tasks.map((record) => record.status);
      const inflight = statuses.filter((status) => status === "leased" || status === "running").length;
      const available = snapshot.policy.maxInflight - inflight;
      const ready = snapshot.tasks
        .filter((record) => record.status === "ready")
        .map((record) => record.definition)
        .sort((left, right) => left.taskId.localeCompare(right.taskId))
        .slice(0, Math.max(0, available));
      if (ready.length === 0) {
        const retries = snapshot.tasks.filter((record) => record.status === "pending" && record.retryAt !== undefined);
        if (retries.length > 0) {
          // The durable scheduler owns promotion. Poll its bounded projection;
          // do not turn a due timestamp into permission to claim locally.
          const nextRetry = Math.min(...retries.map((record) => record.retryAt!));
          const retryDelay = nextRetry > this.clock.now() ? nextRetry - this.clock.now() : 50;
          await new Promise<void>((resolve, reject) => {
            const signal = this.options.signal;
            const abort = () => { this.clock.clearTimeout(timer); reject(signal?.reason ?? new Error("Dispatcher aborted")); };
            const timer = this.clock.setTimeout(() => {
              signal?.removeEventListener("abort", abort);
              resolve();
            }, Math.max(1, Math.min(250, retryDelay, snapshot.policy.maxWallTimeMs - (this.clock.now() - startedAt))));
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
          continue;
        }
        const readyCount = statuses.filter((status) => status === "ready").length;
        const waiting = statuses.filter((status) => status === "waiting").length;
        const blocked = statuses.filter((status) => status === "pending").length;
        const terminal = statuses.filter((status) => isTerminal(status)).length;
        const actionable = readyCount + inflight;
        return {
          quiescent: actionable === 0,
          deadlocked: actionable === 0 && terminal < statuses.length,
          ready: readyCount,
          inflight,
          waiting,
          blocked,
          terminal,
          total: statuses.length,
        };
      }
      const invoked = new Set<string>();
      const completed = new Set<string>();
      const entries = ready.map((definition): DynamicTaskReadyBatchEntry => ({
        taskId: definition.taskId,
        run: async (checkpoint) => {
        if (invoked.has(definition.taskId)) {
          throw new Error(`Ready-batch runner invoked ${definition.taskId} more than once`);
        }
        invoked.add(definition.taskId);
        try {
        await checkpoint("before-claim");
        const lease = await this.options.control.claim({
          taskId: definition.taskId,
          owner: this.owner,
        });
        if (!lease) return;
        await checkpoint("after-claim");
        const beforeStart = await this.options.control.snapshot();
        const beforeStartRecords = new Map(beforeStart.tasks.map((record) => [
          record.definition.taskId,
          record,
        ]));
        const dependencyRecords = definition.dependencies.map(({ taskId }) => ({
          declaredTaskId: taskId,
          record: effectiveTaskRecord(taskId, beforeStartRecords),
        }));
        const acceptedDependencies = dependencyRecords.filter(({ record }) =>
          record?.status === "accepted");
        const dependencyReferences = beforeStart.outcomeDataReferences.filter((entry) =>
          acceptedDependencies.some(({ record }) => record?.definition.taskId === entry.taskId));
        const executionGrant = await (this.options.createExecutionGrant?.({
          runId: this.options.runId,
          definition,
          lease,
          policy: beforeStart.policy,
        }) ?? createTaskExecutionGrant({
          runId: this.options.runId,
          definition,
          attempt: lease.attempt,
          fence: lease.fence,
          policyVersion: "roster.dispatch.default.v1",
          policy: beforeStart.policy,
          allowGraphExpansion: true,
        }));
        const contextManifest = createTaskContextManifest({
          runId: this.options.runId,
          definition,
          attempt: lease.attempt,
          fence: lease.fence,
          executionGrant,
          ...(this.options.contextRepository
            ? { repository: this.options.contextRepository(definition) }
            : {}),
          includedInputIds: [
            ...Object.keys(definition.inputs.inputVersions),
            ...acceptedDependencies.map(({ record }) => record!.definition.taskId),
          ],
          includedArtifactIds: [...new Set([
            ...definition.inputs.dataReferences.flatMap((reference) =>
              reference.artifactId ? [reference.artifactId] : []),
            ...acceptedDependencies.flatMap(({ record }) =>
              record?.outcome?.artifacts.map((artifact) => artifact.artifactId) ?? []),
          ])],
          includedReferenceIds: [...new Set([
            ...definition.inputs.dataReferences.map((reference) => reference.referenceId),
            ...dependencyReferences.map((entry) => entry.reference.referenceId),
          ])],
          excludedUnfinishedInputIds: dependencyRecords.flatMap(({ declaredTaskId, record }) =>
            record?.status === "accepted" ? [] : [declaredTaskId]),
        });
        await this.options.control.start(lease, contextManifest);
        await checkpoint("after-start");
        const controller = new AbortController();
        const abort = () => controller.abort(this.options.signal?.reason);
        this.options.signal?.addEventListener("abort", abort, { once: true });
        if (this.options.signal?.aborted) abort();
        const interrupted = new Promise<never>((_resolve, reject) => {
          const rejectAbort = () => reject(controller.signal.reason ?? new Error("Task interrupted"));
          controller.signal.addEventListener("abort", rejectAbort, { once: true });
          if (controller.signal.aborted) rejectAbort();
        });
        // Install rejection observation before any awaited preparation step.
        void interrupted.catch(() => {});
        let timeout: ClockTimer | undefined;
        let rejectTimeout: ((error: Error) => void) | undefined;
        const timedOut = new Promise<never>((_resolve, reject) => {
          rejectTimeout = reject;
          if (definition.timeoutMs > 0) {
            timeout = this.clock.setTimeout(() => {
              const error = new Error(`Task ${definition.taskId} timed out after ${definition.timeoutMs}ms`);
              controller.abort(error);
              rejectTimeout?.(error);
            }, definition.timeoutMs);
          }
        });
        let expanded = false;
        let heartbeatTimer: ClockTimer | undefined;
        let rejectHeartbeat: ((error: Error) => void) | undefined;
        let heartbeatsActive = true;
        const heartbeatFailed = new Promise<never>((_resolve, reject) => {
          rejectHeartbeat = reject;
        });
        const heartbeat = async (): Promise<void> => {
          try {
            await this.options.control.heartbeat(lease);
            if (heartbeatsActive) {
              heartbeatTimer = this.clock.setTimeout(() => void heartbeat(), this.heartbeatMs);
            }
          } catch (error) {
            if (!heartbeatsActive) return;
            const retiredByContinuation = await this.options.control.snapshot()
              .then((snapshot) => snapshot.tasks.find((record) =>
                record.definition.taskId === definition.taskId))
              .then((record) => Boolean(
                record?.continuationTaskId
                && record.status !== "leased"
                && record.status !== "running"
              ))
              .catch(() => false);
            if (retiredByContinuation) {
              heartbeatsActive = false;
              return;
            }
            const failure = error instanceof Error ? error : new Error(String(error));
            controller.abort(failure);
            rejectHeartbeat?.(failure);
          }
        };
        heartbeatTimer = this.clock.setTimeout(() => void heartbeat(), this.heartbeatMs);
        try {
          const handler = this.options.handlers.resolve(definition.handler);
          const taskSnapshot = await this.options.control.snapshot();
          let reportedUsage: NodeExecutionUsage | undefined;
          const taskRecords = new Map(taskSnapshot.tasks.map((record) => [
            record.definition.taskId,
            record,
          ]));
          const taskRecord = (taskId: string): TaskGraphTaskRecord | undefined =>
            effectiveTaskRecord(taskId, taskRecords);
          controller.signal.throwIfAborted();
          const execution = handler({
            definition,
            lease,
            attempt: lease.attempt,
            executionGrant: contextManifest.executionGrant,
            signal: controller.signal,
            reportUsage: (usage) => {
              if (reportedUsage) {
                throw new Error(`Task ${definition.taskId} reported runtime usage more than once`);
              }
              reportedUsage = Object.freeze({ ...usage });
            },
            dependencyOutcomes: Object.fromEntries(definition.dependencies.map(({ taskId }) => [
              taskId,
              taskRecord(taskId)?.outcome,
            ])),
            dependencyDataReferences: Object.fromEntries(definition.dependencies.map(({ taskId }) => [
              taskId,
              taskSnapshot.outcomeDataReferences.filter((entry) =>
                entry.taskId === taskRecord(taskId)?.definition.taskId),
            ])),
            readDataReference: (reference, control) =>
              this.options.dataReferences.read(reference, control),
            task: async (taskId) => {
              const current = await this.options.control.snapshot();
              return current.tasks.find((record) => record.definition.taskId === taskId);
            },
            expand: async (input) => {
              controller.signal.throwIfAborted();
              if (!contextManifest.executionGrant.allowGraphExpansion) {
                throw new Error(
                  `Task execution grant ${contextManifest.executionGrant.grantId} does not authorize graph expansion`,
                );
              }
              await checkpoint("before-expand");
              if (this.options.control.bindRuntime && this.options.resolveRuntimeBinding) {
                const bindings = new Map<string, WorkspaceNodeRuntimeBinding>();
                for (const child of input.definitions) {
                  const binding = this.options.resolveRuntimeBinding(child);
                  if (binding) bindings.set(binding.bindingId, binding);
                }
                for (const binding of [...bindings.values()].sort((left, right) =>
                  left.nodeId.localeCompare(right.nodeId) || left.epoch - right.epoch)) {
                  controller.signal.throwIfAborted();
                  await this.options.control.bindRuntime(binding);
                }
              }
              controller.signal.throwIfAborted();
              const expansion = await this.options.control.expand({
                ...input,
                parentTaskId: definition.taskId,
                fence: lease.fence,
                owner: lease.owner,
              });
              expanded = true;
              await checkpoint("after-expand");
              return expansion;
            },
          });
          await checkpoint("before-handler");
          const draft = definition.timeoutMs > 0
            ? await Promise.race([execution, timedOut, heartbeatFailed, interrupted])
            : await Promise.race([execution, heartbeatFailed, interrupted]);
          await checkpoint("after-handler");
          // A coordinating runtime may expand through the built-in
          // roster::expand function instead of calling context.expand
          // directly. In both cases the atomic expansion retires the active
          // parent lease, so there is no draft left to accept.
          const afterExecution = await this.options.control.snapshot();
          const activeTask = afterExecution.tasks.find((record) =>
            record.definition.taskId === definition.taskId);
          if (expanded || activeTask?.status !== "running") return;
          const accept = this.acceptance.resolve(definition.acceptance);
          controller.signal.throwIfAborted();
          const acceptedDraft = await Promise.race([accept({
            runId: this.options.runId,
            definition,
            attempt: lease.attempt,
            draft,
          }), interrupted, timedOut, heartbeatFailed]);
          controller.signal.throwIfAborted();
          const outcome = reportedUsage
            ? createAcceptedTaskOutcome({
                runId: acceptedDraft.runId,
                taskId: acceptedDraft.taskId,
                nodeId: acceptedDraft.nodeId,
                attempt: acceptedDraft.attempt,
                definitionHash: acceptedDraft.definitionHash,
                inputVersions: acceptedDraft.inputVersions,
                frontierVersion: acceptedDraft.frontierVersion,
                topologyVersion: acceptedDraft.topologyVersion,
                catalogVersion: acceptedDraft.catalogVersion,
                acceptancePolicyId: acceptedDraft.acceptancePolicyId,
                acceptancePolicyVersion: acceptedDraft.acceptancePolicyVersion,
                artifacts: acceptedDraft.artifacts,
                usage: reportedUsage,
              })
            : acceptedDraft;
          const artifact = outcome.artifacts[0];
          const dataReferenceValue = acceptedDataReferenceValue(definition, draft);
          const presentationText = acceptedPresentationText(definition, draft);
          const dataReferences = artifact && dataReferenceValue !== undefined
            ? [{
                artifactId: artifact.artifactId,
                ...(presentationText ? { presentationText } : {}),
                reference: await this.options.dataReferences.put({
                  value: dataReferenceValue,
                  mediaType: artifact.mediaType,
                  storage: "artifact",
                  artifactId: artifact.artifactId,
                  metadata: {
                    taskId: definition.taskId,
                    outcomeId: outcome.outcomeId,
                    outputKey: artifact.outputKey,
                  },
                }, { signal: controller.signal }),
              }]
            : [];
          if (dataReferences.length > 0) {
            await checkpoint("after-data-reference");
          }
          await checkpoint("before-accept");
          controller.signal.throwIfAborted();
          await this.options.control.accept({ lease, outcome, dataReferences });
          await checkpoint("after-accept");
        } catch (error) {
          if (error instanceof DynamicTaskSchedulingError) throw error;
          const failedSnapshot = await this.options.control.snapshot();
          const current = failedSnapshot.tasks.find((record) =>
            record.definition.taskId === definition.taskId);
          if (current?.status === "leased" || current?.status === "running") {
            await checkpoint("before-fail");
            await this.options.control.fail({
              lease,
              error: error instanceof Error ? error.message : String(error),
              retryable: !controller.signal.aborted,
            });
            await checkpoint("after-fail");
          } else if (!expanded) {
            throw error;
          }
        } finally {
          if (timeout) this.clock.clearTimeout(timeout);
          heartbeatsActive = false;
          if (heartbeatTimer) this.clock.clearTimeout(heartbeatTimer);
          this.options.signal?.removeEventListener("abort", abort);
        }
        } finally {
          completed.add(definition.taskId);
        }
        },
      }));
      await (this.options.readyBatchRunner ?? runReadyBatchConcurrently)(entries);
      if (invoked.size !== entries.length || completed.size !== entries.length) {
        const missing = entries
          .map((entry) => entry.taskId)
          .filter((taskId) => !completed.has(taskId));
        throw new Error(
          `Ready-batch runner must complete every task exactly once; missing ${missing.join(", ")}`,
        );
      }
    }
  }
}
