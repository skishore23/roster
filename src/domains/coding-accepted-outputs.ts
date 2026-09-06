import { canonicalize, hashCanonical } from "../core/canonical.js";
import type { DataReferenceStore } from "../engine/dataflow/data-reference-store.js";
import type { JsonValue } from "../engine/orchestration/types.js";
import type { TaskGraphControlSnapshot } from "../engine/orchestration/task-graph-control.js";
import { validateTaskGraphSnapshotExpansions } from "../engine/orchestration/task-graph.js";

export const CODING_ACCEPTED_OUTPUT_PROJECTION_LIMITS = Object.freeze({
  maxOutputs: 64,
  maxValueBytes: 512 * 1024,
  maxReadBytes: 8 * 1024 * 1024,
});

export type CodingAcceptedOutput = {
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly outcomeId: string;
  readonly artifactId: string;
  /** Stable read-model key; artifact outputKey remains durable provenance. */
  readonly projectionKey: string;
  readonly outputKey: string;
  readonly kind: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly value: string;
};

export type CodingAcceptedOutputProjection = {
  readonly outputs: ReadonlyArray<CodingAcceptedOutput>;
  readonly omittedCount: number;
};

const OUTPUT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export const codingAcceptedOutputProjectionKey = (
  outputKey: string,
  taskId: string,
): string => `accepted-output/${taskId.length}:${taskId}/${outputKey.length}:${outputKey}`;

export const codingAcceptedOutputSharedArtifactId = (
  output: Pick<CodingAcceptedOutput, "runId" | "projectionKey">,
): string => `${output.runId}:${output.projectionKey}`;

/**
 * Revalidates the caller-scoped read model before it crosses into a room view.
 * The normal projector already guarantees these properties; this second seam
 * keeps a cross-run, duplicated, or unbounded adapter result from overwriting
 * an unrelated accepted artifact in presentation state.
 */
export const validateCodingAcceptedOutputProjection = (
  projection: CodingAcceptedOutputProjection,
  expectedRunId: string,
): CodingAcceptedOutputProjection => {
  if (!expectedRunId.trim()) throw new Error("Coding accepted output projection requires a run id");
  if (!Number.isSafeInteger(projection.omittedCount) || projection.omittedCount < 0) {
    throw new Error("Coding accepted output projection has an invalid omitted count");
  }
  if (projection.outputs.length > CODING_ACCEPTED_OUTPUT_PROJECTION_LIMITS.maxOutputs) {
    throw new Error("Coding accepted output projection exceeds its output bound");
  }
  const projectionKeys = new Set<string>();
  const artifactIds = new Set<string>();
  let valueBytes = 0;
  for (const output of projection.outputs) {
    if (output.runId !== expectedRunId) {
      throw new Error(`Coding accepted output ${output.outputKey} belongs to another run`);
    }
    for (const [field, value] of [
      ["taskId", output.taskId],
      ["nodeId", output.nodeId],
      ["outcomeId", output.outcomeId],
      ["artifactId", output.artifactId],
      ["projectionKey", output.projectionKey],
      ["outputKey", output.outputKey],
      ["kind", output.kind],
      ["contentHash", output.contentHash],
      ["mediaType", output.mediaType],
    ] as const) {
      if (!value.trim()) throw new Error(`Coding accepted output has a blank ${field}`);
    }
    if (!Number.isSafeInteger(output.byteLength) || output.byteLength < 0) {
      throw new Error(`Coding accepted output ${output.outputKey} has an invalid byte length`);
    }
    if (!OUTPUT_KEY_PATTERN.test(output.outputKey)) {
      throw new Error(`Coding accepted output ${output.outputKey} has an invalid semantic key`);
    }
    const expectedProjectionKey = codingAcceptedOutputProjectionKey(output.outputKey, output.taskId);
    if (output.projectionKey !== expectedProjectionKey) {
      throw new Error(`Coding accepted output ${output.outputKey} has an invalid projection identity`);
    }
    if (projectionKeys.has(output.projectionKey)) {
      throw new Error(`Coding accepted output ${output.projectionKey} is ambiguous`);
    }
    if (artifactIds.has(output.artifactId)) {
      throw new Error(`Coding accepted artifact ${output.artifactId} is ambiguous`);
    }
    projectionKeys.add(output.projectionKey);
    artifactIds.add(output.artifactId);
    valueBytes += Buffer.byteLength(output.value, "utf8");
  }
  if (!Number.isSafeInteger(valueBytes)
    || valueBytes > CODING_ACCEPTED_OUTPUT_PROJECTION_LIMITS.maxValueBytes) {
    throw new Error("Coding accepted output projection exceeds its value bound");
  }
  return projection;
};

const outputValue = (value: JsonValue, outputKey: string): string => {
  const selected = value && typeof value === "object" && !Array.isArray(value)
    && outputKey in value
    ? (value as Readonly<Record<string, JsonValue>>)[outputKey]!
    : value;
  return typeof selected === "string" ? selected : JSON.stringify(selected);
};

const compareReferences = (
  left: TaskGraphControlSnapshot["outcomeDataReferences"][number],
  right: TaskGraphControlSnapshot["outcomeDataReferences"][number],
): number =>
  left.taskId.localeCompare(right.taskId)
  || left.outputKey.localeCompare(right.outputKey)
  || left.artifactId.localeCompare(right.artifactId)
  || left.outcomeId.localeCompare(right.outcomeId);

const resultOutputKey = (
  task: TaskGraphControlSnapshot["tasks"][number],
): string | undefined => task.definition.result.mode === "none"
  ? undefined
  : task.definition.result.outputKey;

const currentFrontierTaskIds = (snapshot: TaskGraphControlSnapshot): ReadonlySet<string> => {
  const acceptedFinalizers = snapshot.tasks.filter((task) =>
    task.status === "accepted"
    && task.definition.capability === "coordinate"
    && resultOutputKey(task) === "coding_result");
  if (acceptedFinalizers.length > 1) {
    throw new Error("Coding accepted output projection has multiple accepted final frontiers");
  }
  const finalizer = acceptedFinalizers[0];
  if (!finalizer) {
    return acceptedFrontierTaskIds(
      snapshot,
      snapshot.tasks
        .filter((task) => task.status === "accepted")
        .map((task) => task.definition.taskId),
    );
  }
  return acceptedFrontierTaskIds(snapshot, [finalizer.definition.taskId]);
};

/**
 * Resolve the accepted causal frontier through exact durable expansions.
 *
 * A task that expanded remains as skipped provenance after its continuation
 * finishes. Downstream definitions still name that original task, while graph
 * joins and dependency delivery use the explicit continuation. The accepted
 * output read model must do the same, but only when the snapshot contains the
 * complete expansion relationship that proves the supersession.
 */
const acceptedFrontierTaskIds = (
  snapshot: TaskGraphControlSnapshot,
  roots: ReadonlyArray<string>,
): ReadonlySet<string> => {
  validateTaskGraphSnapshotExpansions(snapshot);
  const taskById = new Map(snapshot.tasks.map((task) => [task.definition.taskId, task]));
  const expansionsByParent = new Map<string, typeof snapshot.expansions[number][]>();
  const expansionsByContinuation = new Map<string, typeof snapshot.expansions[number][]>();
  for (const expansion of snapshot.expansions) {
    const parentExpansions = expansionsByParent.get(expansion.parentTaskId) ?? [];
    parentExpansions.push(expansion);
    expansionsByParent.set(expansion.parentTaskId, parentExpansions);
    const continuationExpansions = expansionsByContinuation.get(expansion.continuationTaskId) ?? [];
    continuationExpansions.push(expansion);
    expansionsByContinuation.set(expansion.continuationTaskId, continuationExpansions);
  }

  const validateExpansion = (
    expansion: TaskGraphControlSnapshot["expansions"][number],
  ): {
    readonly parent: TaskGraphControlSnapshot["tasks"][number];
    readonly continuation: TaskGraphControlSnapshot["tasks"][number];
  } => {
    const parent = taskById.get(expansion.parentTaskId);
    if (!parent) {
      throw new Error(`Coding final frontier continuation has missing parent ${expansion.parentTaskId}`);
    }
    if (
      parent.status !== "skipped"
      || parent.continuationTaskId !== expansion.continuationTaskId
    ) {
      throw new Error(`Coding final frontier has invalid continuation for ${expansion.parentTaskId}`);
    }
    const continuation = taskById.get(expansion.continuationTaskId);
    if (!continuation) {
      throw new Error(
        `Coding final frontier continuation ${expansion.continuationTaskId} is missing`,
      );
    }
    if (continuation.definition.parentTaskId !== parent.definition.taskId) {
      throw new Error(
        `Coding final frontier continuation ${expansion.continuationTaskId} changed its parent`,
      );
    }
    return { parent, continuation };
  };

  const resolveAcceptedTask = (
    taskId: string,
    lineage = new Set<string>(),
  ): TaskGraphControlSnapshot["tasks"][number] => {
    if (lineage.has(taskId)) {
      throw new Error(`Coding final frontier continuation contains a cycle at ${taskId}`);
    }
    const task = taskById.get(taskId);
    if (!task) throw new Error(`Coding final frontier depends on missing task ${taskId}`);
    if (task.status === "accepted") return task;
    if (task.status !== "skipped" || !task.continuationTaskId) {
      throw new Error(`Coding final frontier depends on non-accepted task ${taskId}`);
    }
    const expansions = expansionsByParent.get(taskId) ?? [];
    if (expansions.length !== 1) {
      throw new Error(
        `Coding final frontier has ${expansions.length === 0 ? "no durable" : "ambiguous"} continuation for ${taskId}`,
      );
    }
    const expansion = expansions[0]!;
    if (expansion.continuationTaskId !== task.continuationTaskId) {
      throw new Error(`Coding final frontier continuation for ${taskId} changed identity`);
    }
    validateExpansion(expansion);
    const nextLineage = new Set(lineage);
    nextLineage.add(taskId);
    return resolveAcceptedTask(expansion.continuationTaskId, nextLineage);
  };

  const selected = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const validatedContinuationLineages = new Set<string>();
  const visit = (declaredTaskId: string): void => {
    const task = resolveAcceptedTask(declaredTaskId);
    const taskId = task.definition.taskId;
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      throw new Error(`Coding final frontier contains an accepted dependency cycle at ${taskId}`);
    }
    visiting.add(taskId);
    if (!validatedContinuationLineages.has(taskId)) {
      let continuationTaskId = taskId;
      const lineage = new Set<string>();
      while (true) {
        if (lineage.has(continuationTaskId)) {
          throw new Error(
            `Coding final frontier continuation contains a cycle at ${continuationTaskId}`,
          );
        }
        lineage.add(continuationTaskId);
        const expansions = expansionsByContinuation.get(continuationTaskId) ?? [];
        if (expansions.length === 0) break;
        if (expansions.length !== 1) {
          throw new Error(
            `Coding final frontier continuation ${continuationTaskId} is ambiguous`,
          );
        }
        const { parent } = validateExpansion(expansions[0]!);
        if (resolveAcceptedTask(parent.definition.taskId).definition.taskId !== taskId) {
          throw new Error(
            `Coding final frontier continuation ${continuationTaskId} changed its effective task`,
          );
        }
        for (const dependency of parent.definition.dependencies) visit(dependency.taskId);
        continuationTaskId = parent.definition.taskId;
      }
      validatedContinuationLineages.add(taskId);
    }
    for (const dependency of task.definition.dependencies) visit(dependency.taskId);
    visiting.delete(taskId);
    visited.add(taskId);
    selected.add(taskId);
  };
  for (const root of roots) visit(root);
  return selected;
};

/** Resolve one declared dependency through its validated durable continuation. */
export const codingAcceptedTaskIdForRoot = (
  snapshot: TaskGraphControlSnapshot,
  rootTaskId: string,
): string => {
  const frontier = acceptedFrontierTaskIds(snapshot, [rootTaskId]);
  const taskById = new Map(snapshot.tasks.map((task) => [task.definition.taskId, task]));
  const visited = new Set<string>();
  let taskId = rootTaskId;
  while (true) {
    if (visited.has(taskId)) {
      throw new Error(`Coding final frontier continuation contains a cycle at ${taskId}`);
    }
    visited.add(taskId);
    const task = taskById.get(taskId);
    if (!task) throw new Error(`Coding final frontier depends on missing task ${taskId}`);
    if (task.status === "accepted") {
      if (!frontier.has(taskId)) {
        throw new Error(`Coding final frontier rejected effective task ${taskId}`);
      }
      return taskId;
    }
    if (task.status !== "skipped" || !task.continuationTaskId) {
      throw new Error(`Coding final frontier depends on non-accepted task ${taskId}`);
    }
    taskId = task.continuationTaskId;
  }
};

/**
 * Rehydrates only outputs connected to the complete durable acceptance chain:
 * accepted task -> accepted outcome -> accepted artifact -> immutable body.
 *
 * The selected values are bounded for API/view use, but every reference is
 * validated before bounding so corruption cannot hide behind an omitted row.
 */
type CodingAcceptedOutputProjectionLimits = {
  readonly maxOutputs?: number;
  readonly maxValueBytes?: number;
  readonly maxReadBytes?: number;
};

const projectCodingAcceptedOutputsInternal = async (
  snapshot: TaskGraphControlSnapshot,
  store: DataReferenceStore,
  limits: CodingAcceptedOutputProjectionLimits = {},
  roots?: ReadonlyArray<string>,
): Promise<CodingAcceptedOutputProjection> => {
  const maxOutputs = limits.maxOutputs ?? CODING_ACCEPTED_OUTPUT_PROJECTION_LIMITS.maxOutputs;
  const maxValueBytes = limits.maxValueBytes ?? CODING_ACCEPTED_OUTPUT_PROJECTION_LIMITS.maxValueBytes;
  const maxReadBytes = limits.maxReadBytes ?? CODING_ACCEPTED_OUTPUT_PROJECTION_LIMITS.maxReadBytes;
  if (!Number.isSafeInteger(maxOutputs) || maxOutputs < 1 || maxOutputs > 4_096) {
    throw new Error("Coding accepted output maxOutputs must be between 1 and 4096");
  }
  if (!Number.isSafeInteger(maxValueBytes) || maxValueBytes < 1 || maxValueBytes > 16 * 1_048_576) {
    throw new Error("Coding accepted output maxValueBytes must be between 1 and 16777216");
  }
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > 64 * 1_048_576) {
    throw new Error("Coding accepted output maxReadBytes must be between 1 and 67108864");
  }

  const taskById = new Map(snapshot.tasks.map((task) => [task.definition.taskId, task]));
  const referenceByArtifact = new Map<string, typeof snapshot.outcomeDataReferences[number]>();
  for (const entry of snapshot.outcomeDataReferences) {
    const key = `${entry.outcomeId}\u0000${entry.artifactId}\u0000${entry.outputKey}`;
    if (referenceByArtifact.has(key)) {
      throw new Error(`Coding accepted output ${entry.outputKey} repeats its durable reference`);
    }
    referenceByArtifact.set(key, entry);
  }
  for (const task of snapshot.tasks) {
    if (task.status !== "accepted" || !task.outcome) continue;
    const outputKey = resultOutputKey(task);
    if (!outputKey || task.definition.result.mode === "artifact") continue;
    const artifacts = task.outcome.artifacts.filter((artifact) => artifact.outputKey === outputKey);
    if (artifacts.length !== 1) {
      throw new Error(`Coding accepted task ${task.definition.taskId} has no unique accepted output artifact`);
    }
    const artifact = artifacts[0]!;
    const key = `${task.outcome.outcomeId}\u0000${artifact.artifactId}\u0000${artifact.outputKey}`;
    if (!referenceByArtifact.has(key)) {
      throw new Error(`Coding accepted output ${artifact.outputKey} has no durable reference`);
    }
  }
  const frontierTaskIds = roots
    ? acceptedFrontierTaskIds(snapshot, roots)
    : currentFrontierTaskIds(snapshot);
  const currentReferences = [...snapshot.outcomeDataReferences]
    .filter((entry) => frontierTaskIds.has(entry.taskId))
    .sort(compareReferences);
  if (currentReferences.length > maxOutputs) {
    throw new Error(`Coding accepted output projection exceeds maxOutputs=${maxOutputs}`);
  }
  const declaredReadBytes = currentReferences.reduce(
    (total, entry) => total + entry.reference.byteLength,
    0,
  );
  if (!Number.isSafeInteger(declaredReadBytes) || declaredReadBytes > maxReadBytes) {
    throw new Error(`Coding accepted output projection exceeds maxReadBytes=${maxReadBytes}`);
  }

  const validated: CodingAcceptedOutput[] = [];
  const selectedProjectionKeys = new Set<string>();
  for (const entry of currentReferences) {
    const task = taskById.get(entry.taskId);
    if (!task || task.status !== "accepted" || !task.outcome) {
      throw new Error(`Coding accepted output ${entry.outputKey} has no accepted task outcome`);
    }
    const outcome = task.outcome;
    if (
      outcome.runId !== snapshot.runId
      || outcome.taskId !== entry.taskId
      || outcome.taskId !== task.definition.taskId
      || outcome.nodeId !== task.definition.nodeId
      || outcome.outcomeId !== entry.outcomeId
      || outcome.definitionHash !== task.definition.definitionHash
    ) {
      throw new Error(`Coding accepted output ${entry.outputKey} changed acceptance identity`);
    }
    const artifact = outcome.artifacts.find((candidate) =>
      candidate.artifactId === entry.artifactId && candidate.outputKey === entry.outputKey);
    if (!artifact) {
      throw new Error(`Coding accepted output ${entry.outputKey} has no matching accepted artifact`);
    }
    if (
      artifact.contentHash !== entry.reference.contentHash
      || artifact.mediaType !== entry.reference.mediaType
      || artifact.byteLength !== entry.reference.byteLength
    ) {
      throw new Error(`Coding accepted output ${entry.outputKey} changed artifact metadata`);
    }
    if (entry.reference.storage === "ephemeral") {
      throw new Error(`Coding accepted output ${entry.outputKey} is not durably addressable`);
    }
    const projectionKey = codingAcceptedOutputProjectionKey(entry.outputKey, entry.taskId);
    if (selectedProjectionKeys.has(projectionKey)) {
      throw new Error(`Coding accepted output ${projectionKey} is ambiguous on the current frontier`);
    }
    selectedProjectionKeys.add(projectionKey);
    const value = await store.read(entry.reference);
    if (hashCanonical(value) !== artifact.contentHash) {
      throw new Error(`Coding accepted output ${entry.outputKey} changed accepted content`);
    }
    validated.push({
      runId: snapshot.runId,
      taskId: entry.taskId,
      nodeId: outcome.nodeId,
      outcomeId: entry.outcomeId,
      artifactId: entry.artifactId,
      projectionKey,
      outputKey: entry.outputKey,
      kind: artifact.kind,
      contentHash: artifact.contentHash,
      mediaType: artifact.mediaType,
      byteLength: artifact.byteLength,
      value: outputValue(value, entry.outputKey),
    });
  }

  const valueBytes = validated.reduce(
    (total, output) => total + Buffer.byteLength(output.value, "utf8"),
    0,
  );
  if (!Number.isSafeInteger(valueBytes) || valueBytes > maxValueBytes) {
    throw new Error(`Coding accepted output projection exceeds maxValueBytes=${maxValueBytes}`);
  }
  return { outputs: validated, omittedCount: 0 };
};

export const projectCodingAcceptedOutputs = (
  snapshot: TaskGraphControlSnapshot,
  store: DataReferenceStore,
  limits: CodingAcceptedOutputProjectionLimits = {},
): Promise<CodingAcceptedOutputProjection> =>
  projectCodingAcceptedOutputsInternal(snapshot, store, limits);

/**
 * Projects the exact effective accepted dependency frontier declared by a
 * native continuation. The durable expansion graph, rather than task-id
 * sorting or reference delivery order, decides which cycle is current.
 */
export const projectCodingAcceptedOutputsForRoots = (
  snapshot: TaskGraphControlSnapshot,
  store: DataReferenceStore,
  roots: ReadonlyArray<string>,
  limits: CodingAcceptedOutputProjectionLimits = {},
): Promise<CodingAcceptedOutputProjection> => {
  if (roots.length < 1 || roots.length > CODING_ACCEPTED_OUTPUT_PROJECTION_LIMITS.maxOutputs) {
    throw new Error("Coding accepted output roots must contain between 1 and 64 tasks");
  }
  const uniqueRoots = new Set(roots);
  if (uniqueRoots.size !== roots.length || roots.some((root) => !root.trim())) {
    throw new Error("Coding accepted output roots must have unique non-blank task identities");
  }
  return projectCodingAcceptedOutputsInternal(snapshot, store, limits, roots);
};

/** Select one accepted value by its permanent task-scoped identity. */
export const codingAcceptedOutputForTask = (
  projection: Pick<CodingAcceptedOutputProjection, "outputs">,
  taskId: string,
  outputKey: string,
): string => {
  const matches = projection.outputs.filter((output) =>
    output.taskId === taskId && output.outputKey === outputKey);
  if (matches.length === 0) {
    throw new Error(`Coding final frontier is missing exact accepted output ${taskId}/${outputKey}`);
  }
  if (matches.length !== 1) {
    throw new Error(`Coding final frontier has ambiguous exact accepted output ${taskId}/${outputKey}`);
  }
  const output = matches[0]!;
  if (output.projectionKey !== codingAcceptedOutputProjectionKey(outputKey, taskId)) {
    throw new Error(`Coding final frontier has ambiguous exact accepted output ${taskId}/${outputKey}`);
  }
  return output.value;
};

export const codingAcceptedOutputValues = (
  projection: Pick<CodingAcceptedOutputProjection, "outputs">,
): Readonly<Record<string, string>> => {
  const values: Record<string, string> = {};
  const groups = new Map<string, CodingAcceptedOutput[]>();
  for (const output of projection.outputs) {
    if (output.projectionKey !== codingAcceptedOutputProjectionKey(output.outputKey, output.taskId)) {
      throw new Error(`Coding accepted output ${output.outputKey} is ambiguous`);
    }
    if (Object.prototype.hasOwnProperty.call(values, output.projectionKey)) {
      throw new Error(`Coding accepted output ${output.projectionKey} is ambiguous`);
    }
    values[output.projectionKey] = output.value;
    const group = groups.get(output.outputKey) ?? [];
    group.push(output);
    groups.set(output.outputKey, group);
  }
  for (const [outputKey, unsortedGroup] of [...groups].sort(([left], [right]) =>
    left.localeCompare(right))) {
    const group = [...unsortedGroup].sort((left, right) =>
      left.taskId.localeCompare(right.taskId)
      || left.outcomeId.localeCompare(right.outcomeId)
      || left.artifactId.localeCompare(right.artifactId));
    if (group.length === 1) {
      const output = group[0]!;
      if (!Object.prototype.hasOwnProperty.call(values, outputKey)) {
        values[outputKey] = output.value;
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(values, outputKey)) {
      throw new Error(`Coding accepted output ${outputKey} is ambiguous`);
    }
    values[outputKey] = canonicalize(group.map((output) => ({
      projectionKey: output.projectionKey,
      taskId: output.taskId,
      nodeId: output.nodeId,
      outcomeId: output.outcomeId,
      artifactId: output.artifactId,
      value: output.value,
    })));
  }
  return values;
};
