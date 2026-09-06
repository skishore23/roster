import {
  normalizeToCanonical,
  type CanonicalRecord,
  type Diagnostic,
  type NormalizationBounds,
  type NormalizationFilters,
  type TranscriptTrajectorySource,
} from "@letta-ai/trajectory";

import { hashCanonical } from "../../core/canonical.js";
import type { WorkspaceNodeRuntimeKind } from "../orchestration/types.js";
import type { NodeExecutionEnvelope } from "./node-runtime.js";

export const NODE_EXECUTION_TRAJECTORY_SCHEMA_VERSION = "roster.node-trajectory.v1" as const;

export const DEFAULT_NODE_TRAJECTORY_LIMITS = Object.freeze({
  maxTranscriptBytes: 16 * 1_048_576,
  maxRecords: 4_096,
});

export type NodeExecutionTrajectoryLimits = {
  readonly maxTranscriptBytes?: number;
  readonly maxRecords?: number;
};

export type NodeExecutionTrajectory = {
  readonly schemaVersion: typeof NODE_EXECUTION_TRAJECTORY_SCHEMA_VERSION;
  readonly contentHash: string;
  readonly executionId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly runtime: WorkspaceNodeRuntimeKind;
  readonly source: TranscriptTrajectorySource;
  readonly sourceGroupId: string;
  readonly bindingId?: string;
  readonly bindingEpoch?: number;
  readonly normalizerVersion: string;
  readonly canonicalSchemaVersion: number;
  readonly records: ReadonlyArray<CanonicalRecord>;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly config: {
    readonly bounds: {
      readonly toolArguments: { readonly maxCharacters: number | null };
      readonly toolResults: {
        readonly maxCharacters: number | null;
        readonly strategy: "head" | "head-tail";
      };
    };
    readonly filters: { readonly toolResults: "include" | "omit" };
  };
};

export type NodeExecutionTrajectoryObserver = (
  trajectory: NodeExecutionTrajectory,
) => void | Promise<void>;

export type NormalizeNodeExecutionTrajectoryInput = {
  readonly envelope: NodeExecutionEnvelope;
  readonly source: TranscriptTrajectorySource;
  readonly transcript: string;
  readonly sourceGroupId?: string;
  readonly bounds?: NormalizationBounds;
  readonly filters?: NormalizationFilters;
  readonly limits?: NodeExecutionTrajectoryLimits;
};

const positiveLimit = (value: number | undefined, fallback: number, field: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`Node trajectory ${field} must be a positive safe integer`);
  }
  return resolved;
};

/**
 * Converts one provider-native session into a bounded, content-addressed
 * observational artifact. It does not emit receipts or participate in output
 * validation, acceptance, conflict resolution, or certification.
 */
export const normalizeNodeExecutionTrajectory = (
  input: NormalizeNodeExecutionTrajectoryInput,
): NodeExecutionTrajectory => {
  const maxTranscriptBytes = positiveLimit(
    input.limits?.maxTranscriptBytes,
    DEFAULT_NODE_TRAJECTORY_LIMITS.maxTranscriptBytes,
    "maxTranscriptBytes",
  );
  const transcriptBytes = Buffer.byteLength(input.transcript);
  if (transcriptBytes > maxTranscriptBytes) {
    throw new Error(`Node trajectory transcript exceeded maxTranscriptBytes=${maxTranscriptBytes}`);
  }
  const maxRecords = positiveLimit(
    input.limits?.maxRecords,
    DEFAULT_NODE_TRAJECTORY_LIMITS.maxRecords,
    "maxRecords",
  );
  const canonical = normalizeToCanonical({
    source: input.source,
    transcript: input.transcript,
    ...(input.bounds ? { bounds: input.bounds } : {}),
    ...(input.filters ? { filters: input.filters } : {}),
    ...(input.sourceGroupId ? { sourceContext: { groupId: input.sourceGroupId } } : {}),
  });
  if (canonical.records.length > maxRecords) {
    throw new Error(`Node trajectory exceeded maxRecords=${maxRecords}`);
  }
  const sourceGroupIds = [...new Set(canonical.records.map((record) => record.source_group_id))];
  if (sourceGroupIds.length !== 1 || !sourceGroupIds[0]) {
    throw new Error("Node trajectory must resolve exactly one source group");
  }
  const content = {
    schemaVersion: NODE_EXECUTION_TRAJECTORY_SCHEMA_VERSION,
    executionId: input.envelope.executionId,
    runId: input.envelope.runId,
    nodeId: input.envelope.node.id,
    taskId: input.envelope.task.taskId,
    runtime: input.envelope.runtime.kind,
    source: input.source,
    sourceGroupId: sourceGroupIds[0],
    ...(input.envelope.binding?.bindingId ? { bindingId: input.envelope.binding.bindingId } : {}),
    ...(input.envelope.binding?.epoch !== undefined
      ? { bindingEpoch: input.envelope.binding.epoch }
      : {}),
    normalizerVersion: canonical.normalizer_version,
    canonicalSchemaVersion: canonical.canonical_schema_version,
    records: canonical.records,
    diagnostics: canonical.diagnostics,
    config: canonical.config,
  };
  return {
    ...content,
    contentHash: hashCanonical(content),
  };
};
