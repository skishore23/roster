import { hashCanonical } from "../../core/canonical.js";
import type { DynamicTaskDefinition } from "./protocol.js";
import {
  assertTaskExecutionGrant,
  type TaskExecutionGrant,
} from "./execution-grant.js";

export const ROSTER_TASK_CONTEXT_MANIFEST_VERSION = "roster.task-context-manifest.v2" as const;

export type TaskRepositoryPlacement = {
  /** Absolute or workspace-relative repository root. Null records a non-repository task. */
  readonly root: string | null;
  /** Exact branch supplied to the worker, or null when the execution has no Git branch. */
  readonly branch: string | null;
  /** Exact commit supplied to the worker, or null when the execution has no Git commit. */
  readonly commit: string | null;
  /** Exact worktree placement supplied to the worker, or null for non-worktree execution. */
  readonly worktree: string | null;
};

/**
 * Durable evidence of the context admitted before a task starts. In particular,
 * excludedUnfinishedInputIds makes all-terminal joins replayable without
 * guessing which unfinished dependency outputs were absent.
 */
export type TaskContextManifest = {
  readonly schemaVersion: typeof ROSTER_TASK_CONTEXT_MANIFEST_VERSION;
  readonly manifestId: string;
  readonly repository: TaskRepositoryPlacement;
  readonly contextVersion: string;
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly fence: number;
  readonly frontierVersion: string;
  readonly topologyVersion: string;
  readonly catalogVersion: string;
  readonly bindingVersion: number;
  readonly executionGrant: TaskExecutionGrant;
  readonly includedInputIds: ReadonlyArray<string>;
  readonly includedArtifactIds: ReadonlyArray<string>;
  readonly includedReferenceIds: ReadonlyArray<string>;
  readonly excludedUnfinishedInputIds: ReadonlyArray<string>;
};

export type CreateTaskContextManifestInput = {
  readonly runId: string;
  readonly definition: DynamicTaskDefinition;
  readonly attempt: number;
  readonly fence: number;
  readonly executionGrant: TaskExecutionGrant;
  readonly repository?: TaskRepositoryPlacement;
  readonly includedInputIds?: ReadonlyArray<string>;
  readonly includedArtifactIds?: ReadonlyArray<string>;
  readonly includedReferenceIds?: ReadonlyArray<string>;
  readonly excludedUnfinishedInputIds?: ReadonlyArray<string>;
};

const ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._:/-]*$/;
const MAX_MANIFEST_IDS = 2_048;

const exactId = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized) || normalized.length > 240) {
    throw new Error(`${label} is not a valid bounded identifier`);
  }
  return normalized;
};

const exactVersion = (value: string, label: string): string => {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > 240
    || /[\u0000-\u001F\u007F]/.test(normalized)
  ) {
    throw new Error(`${label} is not a valid bounded version`);
  }
  return normalized;
};

const scopeId = (value: string, label: string): string => {
  const normalized = value.trim();
  if (
    !ID_PATTERN.test(normalized)
    || normalized.length > 512
  ) {
    throw new Error(`${label} is not a valid bounded scope identifier`);
  }
  return normalized;
};

const optionalPlacement = (value: string | null, label: string): string | null => {
  if (value === null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 4_096) {
    throw new Error(`${label} must be null or a non-empty bounded path/revision`);
  }
  return normalized;
};

const exactIds = (values: ReadonlyArray<string>, label: string): ReadonlyArray<string> => {
  if (values.length > MAX_MANIFEST_IDS) {
    throw new Error(`${label} exceeds ${MAX_MANIFEST_IDS} entries`);
  }
  const normalized = [...new Set(values.map((value) => exactId(value, label)))].sort();
  return normalized;
};

const repositoryPlacement = (
  value: TaskRepositoryPlacement | undefined,
): TaskRepositoryPlacement => ({
  root: optionalPlacement(value?.root ?? null, "Task context repository root"),
  branch: optionalPlacement(value?.branch ?? null, "Task context branch"),
  commit: optionalPlacement(value?.commit ?? null, "Task context commit"),
  worktree: optionalPlacement(value?.worktree ?? null, "Task context worktree"),
});

const contextIdentity = (
  input: Omit<TaskContextManifest, "schemaVersion" | "manifestId" | "contextVersion">,
) => ({
  schemaVersion: ROSTER_TASK_CONTEXT_MANIFEST_VERSION,
  ...input,
});

export const createTaskContextManifest = (
  input: CreateTaskContextManifestInput,
): TaskContextManifest => {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("Task context attempt must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.fence) || input.fence < 1) {
    throw new Error("Task context fence must be a positive safe integer");
  }
  const definition = input.definition;
  const executionGrant = assertTaskExecutionGrant({
    grant: input.executionGrant,
    runId: input.runId,
    definition,
    attempt: input.attempt,
    fence: input.fence,
  });
  const includedInputIds = exactIds(
    input.includedInputIds ?? Object.keys(definition.inputs.inputVersions),
    "Task context included input id",
  );
  const includedArtifactIds = exactIds(
    input.includedArtifactIds ?? definition.inputs.dataReferences.flatMap((reference) =>
      reference.artifactId ? [reference.artifactId] : []),
    "Task context included artifact id",
  );
  const includedReferenceIds = exactIds(
    input.includedReferenceIds ?? definition.inputs.dataReferences.map((reference) =>
      reference.referenceId),
    "Task context included reference id",
  );
  const excludedUnfinishedInputIds = exactIds(
    input.excludedUnfinishedInputIds ?? [],
    "Task context excluded unfinished input id",
  );
  const overlap = excludedUnfinishedInputIds.find((id) => includedInputIds.includes(id));
  if (overlap) throw new Error(`Task context input ${overlap} cannot be included and excluded`);
  const identity = contextIdentity({
    repository: repositoryPlacement(input.repository),
    runId: scopeId(input.runId, "Task context run id"),
    taskId: exactId(definition.taskId, "Task context task id"),
    nodeId: exactId(definition.nodeId, "Task context node id"),
    attempt: input.attempt,
    fence: input.fence,
    frontierVersion: exactVersion(definition.inputs.frontierVersion, "Task context frontier version"),
    topologyVersion: exactVersion(definition.inputs.topologyVersion, "Task context topology version"),
    catalogVersion: exactVersion(definition.inputs.catalogVersion, "Task context catalog version"),
    bindingVersion: definition.runtimeBindingEpoch,
    executionGrant,
    includedInputIds,
    includedArtifactIds,
    includedReferenceIds,
    excludedUnfinishedInputIds,
  });
  const contextVersion = `context_${hashCanonical(identity).slice(0, 28)}`;
  return {
    ...identity,
    contextVersion,
    manifestId: `context_manifest_${hashCanonical({ ...identity, contextVersion }).slice(0, 28)}`,
  };
};

export const validateTaskContextManifest = (
  manifest: TaskContextManifest,
): TaskContextManifest => {
  if (manifest.schemaVersion !== ROSTER_TASK_CONTEXT_MANIFEST_VERSION) {
    throw new Error("Task context manifest has an unsupported schema version");
  }
  const reconstructed = createTaskContextManifest({
    runId: manifest.runId,
    definition: {
      schemaVersion: "roster.task-definition.v1",
      taskId: manifest.taskId,
      semanticKey: "context-validation",
      definitionHash: manifest.executionGrant.taskDefinitionHash,
      nodeId: manifest.nodeId,
      capability: "context-validation",
      objective: "Validate a durable task context manifest.",
      handler: { kind: "context-validation", version: "1" },
      acceptance: { policyId: "context-validation", policyVersion: "1" },
      result: { mode: "none" },
      dependencies: [],
      join: { kind: "all-success" },
      inputs: {
        inputVersions: Object.fromEntries(manifest.includedInputIds.map((id) => [id, "included"])),
        dataReferences: [],
        frontierVersion: manifest.frontierVersion,
        topologyVersion: manifest.topologyVersion,
        catalogVersion: manifest.catalogVersion,
      },
      runtimeBindingEpoch: manifest.bindingVersion,
      retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
      timeoutMs: 0,
      sideEffect: "pure",
      estimatedCostMicros: 0,
    },
    attempt: manifest.attempt,
    fence: manifest.fence,
    executionGrant: manifest.executionGrant,
    repository: manifest.repository,
    includedInputIds: manifest.includedInputIds,
    includedArtifactIds: manifest.includedArtifactIds,
    includedReferenceIds: manifest.includedReferenceIds,
    excludedUnfinishedInputIds: manifest.excludedUnfinishedInputIds,
  });
  if (
    reconstructed.contextVersion !== manifest.contextVersion
    || reconstructed.manifestId !== manifest.manifestId
  ) {
    throw new Error("Task context manifest identity does not match its exact contents");
  }
  return reconstructed;
};
