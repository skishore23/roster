import type { CanonicalRecord } from "@letta-ai/trajectory";

import { hashCanonical } from "../../core/canonical.js";
import type { DataReferenceStore } from "../dataflow/data-reference-store.js";
import type { JsonValue } from "../orchestration/types.js";
import type {
  RosterMemoryDocument,
  RosterMemoryRepository,
  RosterMemoryRepositoryControl,
} from "./node-memory-plane.js";
import type {
  NodeExecutionTrajectory,
  NodeExecutionTrajectoryObserver,
} from "./node-trajectory.js";
import {
  buildTrajectoryRollupIndex,
  createTrajectoryRollupMemoryRepository,
  type TrajectoryRollupSummarizer,
} from "./trajectory-rollup-memory.js";

const DEFAULT_MAX_EXECUTIONS = 64;
const MAX_EXECUTIONS = 128;
const EXCERPT_CHARACTERS = 384;

export const EXTRACTIVE_TRAJECTORY_ROLLUP_SUMMARIZER_ID =
  "roster.trajectory-rollup.extractive" as const;
export const EXTRACTIVE_TRAJECTORY_ROLLUP_SUMMARIZER_VERSION = "1" as const;

export type NodeTrajectoryRollupCollector = {
  /** Observes a completed immutable node execution. Exact replays are idempotent. */
  readonly observe: NodeExecutionTrajectoryObserver;
  /** Live, read-only memory scopes visible only to their owning logical node. */
  readonly repository: RosterMemoryRepository;
};

export type CreateNodeTrajectoryRollupCollectorInput = {
  readonly dataReferences: DataReferenceStore;
  readonly fanout?: number;
  readonly maxExecutions?: number;
  readonly limits?: {
    readonly maxRecords?: number;
    readonly maxBlocks?: number;
  };
  readonly summarizer?: TrajectoryRollupSummarizer;
};

type CollectedExecution = {
  readonly ownerNodeId: string;
  readonly trajectoryContentHash: string;
  readonly repository: RosterMemoryRepository;
};

type PendingExecution = {
  readonly trajectoryContentHash: string;
  readonly promise: Promise<void>;
};

const boundedMaxExecutions = (value: number | undefined): number => {
  const resolved = value ?? DEFAULT_MAX_EXECUTIONS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_EXECUTIONS) {
    throw new Error(`Node trajectory rollup maxExecutions must be between 1 and ${MAX_EXECUTIONS}`);
  }
  return resolved;
};

const assertActive = (control: RosterMemoryRepositoryControl): void => {
  if (!control.signal.aborted) return;
  throw control.signal.reason instanceof Error
    ? control.signal.reason
    : new Error("Node trajectory memory request was aborted");
};

const scopeIdFor = (trajectory: NodeExecutionTrajectory): string =>
  `trajectory:${trajectory.nodeId}:${hashCanonical({
    runId: trajectory.runId,
    nodeId: trajectory.nodeId,
    executionId: trajectory.executionId,
  }).slice(0, 32)}`;

const assertTrajectoryContentHash = (trajectory: NodeExecutionTrajectory): void => {
  const { contentHash, ...content } = trajectory;
  if (hashCanonical(content) !== contentHash) {
    throw new Error(`Node trajectory ${trajectory.executionId} content hash does not match its content`);
  }
};

const recordText = (record: CanonicalRecord): string =>
  record.content?.trim()
  || record.tool_result_json?.trim()
  || record.tool_arguments_json?.trim()
  || record.record_json.trim();

const recordTimestamp = (record: CanonicalRecord): number | undefined => {
  const source = record.record_timestamp ?? record.source_timestamp;
  if (!source) return undefined;
  const timestamp = Date.parse(source);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined;
};

const recordMetadata = (
  trajectory: NodeExecutionTrajectory,
  record: CanonicalRecord,
): Readonly<Record<string, JsonValue>> => Object.freeze({
  executionId: trajectory.executionId,
  runId: trajectory.runId,
  nodeId: trajectory.nodeId,
  taskId: trajectory.taskId,
  runtime: trajectory.runtime,
  source: trajectory.source,
  sourceGroupId: trajectory.sourceGroupId,
  recordType: record.record_type,
  sourceOrderId: record.source_order_id,
  componentIndex: record.component_index,
  sourceIdentityKind: record.source_identity_kind,
  ...(record.tool_name ? { toolName: record.tool_name } : {}),
  ...(record.tool_call_id ? { toolCallId: record.tool_call_id } : {}),
});

const memoryRecords = (
  trajectory: NodeExecutionTrajectory,
  scopeId: string,
): ReadonlyArray<RosterMemoryDocument> => Object.freeze(trajectory.records.map((record) => {
  const timestamp = recordTimestamp(record);
  return Object.freeze({
    documentId: `trajectory_record_${hashCanonical({
      executionId: trajectory.executionId,
      recordId: record.record_id,
    }).slice(0, 32)}`,
    scopeId,
    kind: `trajectory-${record.record_type}`,
    text: recordText(record),
    contentHash: record.record_hash,
    sourceVersion: trajectory.contentHash,
    ...(timestamp !== undefined ? { timestamp } : {}),
    metadata: recordMetadata(trajectory, record),
    references: Object.freeze([
      trajectory.contentHash,
      record.record_id,
      record.record_hash,
      record.content_hash,
    ]),
  });
}));

/**
 * A deterministic first-stage summarizer. It reduces retrieval volume without
 * spending an untracked model budget and retains exact child document anchors.
 */
export const createExtractiveTrajectoryRollupSummarizer = (): TrajectoryRollupSummarizer => ({
  id: EXTRACTIVE_TRAJECTORY_ROLLUP_SUMMARIZER_ID,
  version: EXTRACTIVE_TRAJECTORY_ROLLUP_SUMMARIZER_VERSION,
  summarize: async (input) => {
    const summary = input.children.map((child) => {
      const compact = child.text.replace(/\s+/gu, " ").trim();
      const excerpt = compact.length > EXCERPT_CHARACTERS
        ? `${compact.slice(0, EXCERPT_CHARACTERS - 1)}…`
        : compact;
      return `[${child.documentId}] ${excerpt}`;
    }).join("\n");
    const first = input.descendantDocumentIds[0];
    const last = input.descendantDocumentIds.at(-1);
    return {
      summary,
      notableDocumentIds: Object.freeze([
        ...(first ? [first] : []),
        ...(last && last !== first ? [last] : []),
      ]),
    };
  },
});

/**
 * Collects completed normalized trajectories as separate immutable scopes.
 * Keeping one scope per execution avoids arrival-order merges between
 * concurrently authored task histories. The in-memory manifest is live for
 * the current run; rollup blocks use the supplied DataReferenceStore.
 */
export const createNodeTrajectoryRollupCollector = (
  input: CreateNodeTrajectoryRollupCollectorInput,
): NodeTrajectoryRollupCollector => {
  const maxExecutions = boundedMaxExecutions(input.maxExecutions);
  const summarizer = input.summarizer ?? createExtractiveTrajectoryRollupSummarizer();
  const collected = new Map<string, CollectedExecution>();
  const pending = new Map<string, PendingExecution>();

  const select = (
    scopeId: string,
    control: RosterMemoryRepositoryControl,
  ): CollectedExecution => {
    assertActive(control);
    const execution = collected.get(scopeId);
    if (!execution || execution.ownerNodeId !== control.nodeId) {
      throw new Error(`Memory scope ${scopeId} is not authorized for node ${control.nodeId}`);
    }
    return execution;
  };

  const repository: RosterMemoryRepository = {
    scopes: async (control) => {
      assertActive(control);
      const values = await Promise.all([...collected.entries()]
        .filter(([, execution]) => execution.ownerNodeId === control.nodeId)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(async ([, execution]) => execution.repository.scopes(control)));
      return Object.freeze(values.flat());
    },
    search: async (value, control) =>
      select(value.scopeId, control).repository.search(value, control),
    open: async (value, control) =>
      select(value.scopeId, control).repository.open(value, control),
    diff: async (value, control) =>
      select(value.scopeId, control).repository.diff(value, control),
  };

  const observe: NodeExecutionTrajectoryObserver = async (trajectory) => {
    assertTrajectoryContentHash(trajectory);
    const scopeId = scopeIdFor(trajectory);
    const existing = collected.get(scopeId);
    if (existing) {
      if (existing.trajectoryContentHash !== trajectory.contentHash) {
        throw new Error(`Node trajectory scope ${scopeId} cannot be replaced with changed content`);
      }
      return;
    }
    const inFlight = pending.get(scopeId);
    if (inFlight) {
      if (inFlight.trajectoryContentHash !== trajectory.contentHash) {
        throw new Error(`Node trajectory scope ${scopeId} is already collecting different content`);
      }
      return inFlight.promise;
    }
    if (collected.size + pending.size >= maxExecutions) {
      throw new Error(`Node trajectory rollup collector exceeded maxExecutions=${maxExecutions}`);
    }

    const promise = (async () => {
      const records = memoryRecords(trajectory, scopeId);
      const index = await buildTrajectoryRollupIndex({
        scopeId,
        sourceVersion: trajectory.contentHash,
        records,
        dataReferences: input.dataReferences,
        summarizer,
        ...(input.fanout !== undefined ? { fanout: input.fanout } : {}),
        ...(input.limits ? { limits: input.limits } : {}),
      });
      collected.set(scopeId, Object.freeze({
        ownerNodeId: trajectory.nodeId,
        trajectoryContentHash: trajectory.contentHash,
        repository: createTrajectoryRollupMemoryRepository({
          index,
          records,
          dataReferences: input.dataReferences,
          label: `Trajectory for ${trajectory.nodeId} execution ${trajectory.executionId}`,
          description: `Read-only normalized history for task ${trajectory.taskId}.`,
        }),
      }));
    })();
    pending.set(scopeId, { trajectoryContentHash: trajectory.contentHash, promise });
    try {
      await promise;
    } finally {
      if (pending.get(scopeId)?.promise === promise) pending.delete(scopeId);
    }
  };

  return Object.freeze({ observe, repository });
};
