import { hashCanonical } from "../core/canonical.js";

export const ROOM_TIMELINE_ENTRY_VERSION = "roster.room-timeline-entry.v1" as const;

export type RoomTimelineEntryKind =
  | "message"
  | "claim"
  | "artifact"
  | "decision"
  | "handoff"
  | "review"
  | "checkpoint"
  | "attention";

type RoomTimelineEntryBase<Kind extends RoomTimelineEntryKind> = {
  readonly schemaVersion: typeof ROOM_TIMELINE_ENTRY_VERSION;
  readonly entryId: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly sequence: number;
  readonly recordedAtMs: number;
  readonly kind: Kind;
  readonly runId?: string;
  readonly taskId?: string;
  readonly nodeId?: string;
};

export type RoomMessageTimelineEntry = RoomTimelineEntryBase<"message"> & {
  readonly messageId: string;
  readonly authorNodeId: string;
  readonly body: string;
  readonly replyToEntryId?: string;
};

export type RoomClaimTimelineEntry = RoomTimelineEntryBase<"claim"> & {
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly fence: number;
};

export type RoomArtifactTimelineEntry = RoomTimelineEntryBase<"artifact"> & {
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly artifactId: string;
  readonly outputKey: string;
  readonly artifactKind: string;
  readonly contentHash: string;
  readonly referenceId?: string;
};

export type RoomDecisionTimelineEntry = RoomTimelineEntryBase<"decision"> & {
  readonly subjectId: string;
  readonly decision: string;
  readonly evidenceIds: ReadonlyArray<string>;
};

export type RoomHandoffTimelineEntry = RoomTimelineEntryBase<"handoff"> & {
  readonly runId: string;
  readonly taskId: string;
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly artifactIds: ReadonlyArray<string>;
  readonly referenceIds: ReadonlyArray<string>;
};

export type RoomReviewVerdict = "approve" | "changes_requested" | "blocked";

export type RoomReviewTimelineEntry = RoomTimelineEntryBase<"review"> & {
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly reviewedTaskId: string;
  readonly verdict: RoomReviewVerdict;
  readonly summary: string;
  readonly findingIds: ReadonlyArray<string>;
  readonly frontierVersion: string;
};

export type RoomCheckpointTimelineEntry = RoomTimelineEntryBase<"checkpoint"> & {
  readonly runId: string;
  readonly frontierVersion: string;
  readonly repository: string;
  readonly branch: string;
  readonly commit: string;
  readonly artifactIds: ReadonlyArray<string>;
};

export type RoomAttentionTimelineEntry = RoomTimelineEntryBase<"attention"> & {
  readonly attentionId: string;
  readonly reason: string;
  readonly severity: "info" | "warning" | "blocking";
  readonly authority: "worker" | "coordinator" | "owner";
  readonly relatedEntryIds: ReadonlyArray<string>;
};

export type RoomTimelineEntry =
  | RoomMessageTimelineEntry
  | RoomClaimTimelineEntry
  | RoomArtifactTimelineEntry
  | RoomDecisionTimelineEntry
  | RoomHandoffTimelineEntry
  | RoomReviewTimelineEntry
  | RoomCheckpointTimelineEntry
  | RoomAttentionTimelineEntry;

export type CreateRoomTimelineEntryInput = RoomTimelineEntry extends infer Entry
  ? Entry extends RoomTimelineEntry
    ? Omit<Entry, "schemaVersion" | "entryId">
    : never
  : never;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const boundedId = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized) || normalized.length > 240) {
    throw new Error(`${label} is not a valid bounded identifier`);
  }
  return normalized;
};

const boundedScopeId = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized) || normalized.length > 512) {
    throw new Error(`${label} is not a valid bounded scope identifier`);
  }
  return normalized;
};

const boundedText = (value: string, label: string, maximum = 16_384): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} characters`);
  }
  return normalized;
};

const ids = (values: ReadonlyArray<string>, label: string): ReadonlyArray<string> => {
  if (values.length > 512) throw new Error(`${label} exceeds 512 entries`);
  const normalized = [...new Set(values.map((value) => boundedId(value, label)))].sort();
  if (normalized.length !== values.length) throw new Error(`${label} contains duplicate entries`);
  return normalized;
};

const safeOrdinal = (value: number, label: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
};

const normalizeCommon = <Entry extends CreateRoomTimelineEntryInput>(
  input: Entry,
): Entry => ({
  ...input,
  workspaceId: boundedScopeId(input.workspaceId, "Room timeline workspace id"),
  roomId: boundedScopeId(input.roomId, "Room timeline room id"),
  sequence: safeOrdinal(input.sequence, "Room timeline sequence", 1),
  recordedAtMs: safeOrdinal(input.recordedAtMs, "Room timeline recorded time"),
  ...(input.runId ? { runId: boundedScopeId(input.runId, "Room timeline run id") } : {}),
  ...(input.taskId ? { taskId: boundedId(input.taskId, "Room timeline task id") } : {}),
  ...(input.nodeId ? { nodeId: boundedId(input.nodeId, "Room timeline node id") } : {}),
});

const normalizeEntry = (input: CreateRoomTimelineEntryInput): CreateRoomTimelineEntryInput => {
  const common = normalizeCommon(input);
  switch (common.kind) {
    case "message":
      return {
        ...common,
        messageId: boundedId(common.messageId, "Room message id"),
        authorNodeId: boundedId(common.authorNodeId, "Room message author node id"),
        body: boundedText(common.body, "Room message body"),
        ...(common.replyToEntryId
          ? { replyToEntryId: boundedId(common.replyToEntryId, "Room reply entry id") }
          : {}),
      };
    case "claim":
      return {
        ...common,
        runId: boundedScopeId(common.runId, "Room claim run id"),
        taskId: boundedId(common.taskId, "Room claim task id"),
        nodeId: boundedId(common.nodeId, "Room claim node id"),
        attempt: safeOrdinal(common.attempt, "Room claim attempt", 1),
        fence: safeOrdinal(common.fence, "Room claim fence", 1),
      };
    case "artifact":
      return {
        ...common,
        runId: boundedScopeId(common.runId, "Room artifact run id"),
        taskId: boundedId(common.taskId, "Room artifact task id"),
        nodeId: boundedId(common.nodeId, "Room artifact node id"),
        artifactId: boundedId(common.artifactId, "Room artifact id"),
        outputKey: boundedId(common.outputKey, "Room artifact output key"),
        artifactKind: boundedId(common.artifactKind, "Room artifact kind"),
        contentHash: boundedText(common.contentHash, "Room artifact content hash", 256),
        ...(common.referenceId
          ? { referenceId: boundedId(common.referenceId, "Room artifact reference id") }
          : {}),
      };
    case "decision":
      return {
        ...common,
        subjectId: boundedId(common.subjectId, "Room decision subject id"),
        decision: boundedText(common.decision, "Room decision"),
        evidenceIds: ids(common.evidenceIds, "Room decision evidence id"),
      };
    case "handoff":
      return {
        ...common,
        runId: boundedScopeId(common.runId, "Room handoff run id"),
        taskId: boundedId(common.taskId, "Room handoff task id"),
        fromTaskId: boundedId(common.fromTaskId, "Room handoff source task id"),
        toTaskId: boundedId(common.toTaskId, "Room handoff target task id"),
        artifactIds: ids(common.artifactIds, "Room handoff artifact id"),
        referenceIds: ids(common.referenceIds, "Room handoff reference id"),
      };
    case "review":
      if (!["approve", "changes_requested", "blocked"].includes(common.verdict)) {
        throw new Error("Room review verdict is invalid");
      }
      return {
        ...common,
        runId: boundedScopeId(common.runId, "Room review run id"),
        taskId: boundedId(common.taskId, "Room review task id"),
        nodeId: boundedId(common.nodeId, "Room review node id"),
        reviewedTaskId: boundedId(common.reviewedTaskId, "Room reviewed task id"),
        summary: boundedText(common.summary, "Room review summary"),
        findingIds: ids(common.findingIds, "Room review finding id"),
        frontierVersion: boundedId(common.frontierVersion, "Room review frontier version"),
      };
    case "checkpoint":
      return {
        ...common,
        runId: boundedScopeId(common.runId, "Room checkpoint run id"),
        frontierVersion: boundedId(common.frontierVersion, "Room checkpoint frontier version"),
        repository: boundedText(common.repository, "Room checkpoint repository", 4_096),
        branch: boundedText(common.branch, "Room checkpoint branch", 1_024),
        commit: boundedText(common.commit, "Room checkpoint commit", 256),
        artifactIds: ids(common.artifactIds, "Room checkpoint artifact id"),
      };
    case "attention":
      if (!["info", "warning", "blocking"].includes(common.severity)) {
        throw new Error("Room attention severity is invalid");
      }
      if (!["worker", "coordinator", "owner"].includes(common.authority)) {
        throw new Error("Room attention authority is invalid");
      }
      return {
        ...common,
        attentionId: boundedId(common.attentionId, "Room attention id"),
        reason: boundedText(common.reason, "Room attention reason"),
        relatedEntryIds: ids(common.relatedEntryIds, "Room attention related entry id"),
      };
  }
};

export const createRoomTimelineEntry = (
  input: CreateRoomTimelineEntryInput,
): RoomTimelineEntry => {
  const {
    schemaVersion: _schemaVersion,
    entryId: _entryId,
    ...content
  } = input as CreateRoomTimelineEntryInput & Partial<Pick<RoomTimelineEntry, "schemaVersion" | "entryId">>;
  const normalized = normalizeEntry(content as CreateRoomTimelineEntryInput);
  const identity = {
    schemaVersion: ROOM_TIMELINE_ENTRY_VERSION,
    ...normalized,
  };
  return {
    ...identity,
    entryId: `room_entry_${hashCanonical(identity).slice(0, 28)}`,
  } as RoomTimelineEntry;
};

export const validateRoomTimelineEntry = (entry: RoomTimelineEntry): RoomTimelineEntry => {
  if (entry.schemaVersion !== ROOM_TIMELINE_ENTRY_VERSION) {
    throw new Error("Room timeline entry has an unsupported schema version");
  }
  const reconstructed = createRoomTimelineEntry(entry);
  if (reconstructed.entryId !== entry.entryId) {
    throw new Error("Room timeline entry identity does not match its exact contents");
  }
  return reconstructed;
};
