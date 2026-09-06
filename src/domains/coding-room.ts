import { hashCanonical } from "../core/canonical.js";
import type { WorkspaceNode } from "../engine/orchestration/types.js";
import {
  workspaceNodeSocialParticipant,
  type WorkspaceNodeSocialParticipant,
} from "../engine/workspace/node.js";
import {
  inlineArtifactPublishedEvent,
  type OrchestrationEvent,
} from "../modules/orchestration.js";
import { codingDeliveryState } from "./coding-terminal.js";

export const CODING_ROOM_PROJECTION_SCHEMA = "roster.coding-room-projection.v1" as const;
export const CODING_ROOM_REACTION_SCHEMA = "roster.coding-room-reaction.v1" as const;
export const CODING_ROOM_REACTION_KIND = "coding.room-reaction" as const;
export const CODING_DELIVERY_DISPOSITION_SCHEMA = "roster.coding-delivery-disposition.v1" as const;
export const CODING_DELIVERY_DISPOSITION_KIND = "coding.delivery.disposition" as const;
export const CODING_ROOM_GIT_FRONTIER_SCHEMA = "roster.coding-room-git-frontier.v1" as const;
export const CODING_ROOM_GIT_FRONTIER_KIND = "coding.room-git-frontier" as const;
export const CODING_ROOM_REACTION_EMOJIS = ["👍", "❤️", "🎉", "👀", "✅"] as const;

export type CodingRoomReactionEmoji = typeof CODING_ROOM_REACTION_EMOJIS[number];

export type CodingRoomReaction = {
  readonly schema: typeof CODING_ROOM_REACTION_SCHEMA;
  readonly reactionId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly authorId: string;
  readonly emoji: CodingRoomReactionEmoji;
  readonly createdAt: number;
};

export type CodingDeliveryDisposition = {
  readonly schema: typeof CODING_DELIVERY_DISPOSITION_SCHEMA;
  readonly dispositionId: string;
  readonly action: "keep-branch";
  readonly conversationId: string;
  readonly executionRunId: string;
  readonly jobId: string;
  readonly branch: string;
  readonly commit: string;
};

export type CodingRoomGitFrontier = {
  readonly schema: typeof CODING_ROOM_GIT_FRONTIER_SCHEMA;
  readonly frontierId: string;
  readonly conversationId: string;
  readonly roomId: string;
  readonly branch: string;
  readonly commit: string;
  readonly epoch: number;
  readonly previousCommit?: string;
  readonly targetBranch?: string;
  readonly targetCommit?: string;
  readonly executionRunId?: string;
};

export type CodingRoomState = "open" | "waiting" | "archived";
export type CodingRoomPresence = "present" | "facilitating" | "working" | "joined";

export type CodingDurableRoom = {
  readonly roomId: string;
  readonly conversationId: string;
  readonly codingWorkspaceId: string;
  readonly streamId: string;
  readonly title: string;
  readonly state: CodingRoomState;
  readonly firstMessageId: string;
  readonly messageCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type CodingRoomDirectory = {
  readonly list: (codingWorkspaceId: string) => Promise<ReadonlyArray<CodingDurableRoom>>;
};

export type CodingRoomParticipant = WorkspaceNodeSocialParticipant & {
  readonly presence: CodingRoomPresence;
};

export type CodingRoomProjection = {
  readonly schema: typeof CODING_ROOM_PROJECTION_SCHEMA;
  readonly roomId: string;
  readonly conversationId: string;
  readonly kind: "repository" | "branch";
  readonly title: string;
  readonly state: CodingRoomState;
  readonly stateLabel: string;
  readonly topic?: string;
  readonly branch?: string;
  readonly jobId?: string;
  readonly parentRoomId?: string;
  readonly participants: ReadonlyArray<CodingRoomParticipant>;
};

export const createCodingRoomReaction = (input: {
  readonly conversationId: string;
  readonly messageId: string;
  readonly authorId: string;
  readonly emoji: CodingRoomReactionEmoji;
  readonly createdAt?: number;
}): CodingRoomReaction => {
  const conversationId = input.conversationId.trim();
  const messageId = input.messageId.trim();
  const authorId = input.authorId.trim();
  if (!conversationId || !messageId || !authorId) throw new Error("A room reaction requires a conversation, message, and author");
  if (!CODING_ROOM_REACTION_EMOJIS.includes(input.emoji)) throw new Error("Unsupported room reaction");
  const identity = { conversationId, messageId, authorId, emoji: input.emoji };
  return {
    schema: CODING_ROOM_REACTION_SCHEMA,
    reactionId: `coding_reaction_${hashCanonical(identity).slice(0, 28)}`,
    ...identity,
    createdAt: input.createdAt ?? Date.now(),
  };
};

export const codingRoomReactionEvent = (
  reaction: CodingRoomReaction,
): Extract<OrchestrationEvent, { readonly type: "artifact.published" }> => inlineArtifactPublishedEvent({
  runId: reaction.conversationId,
  artifactId: reaction.reactionId,
  origin: "input",
  outputKey: `room_reaction_${reaction.reactionId}`,
  nodeId: reaction.authorId,
  kind: CODING_ROOM_REACTION_KIND,
  inputVersions: { message: reaction.messageId },
}, JSON.stringify(reaction));

export const createCodingDeliveryDisposition = (input: {
  readonly conversationId: string;
  readonly executionRunId: string;
  readonly jobId: string;
  readonly branch: string;
  readonly commit: string;
}): CodingDeliveryDisposition => {
  const value = {
    action: "keep-branch" as const,
    conversationId: input.conversationId.trim(),
    executionRunId: input.executionRunId.trim(),
    jobId: input.jobId.trim(),
    branch: input.branch.trim(),
    commit: input.commit.trim(),
  };
  if (Object.values(value).some((field) => !field)) {
    throw new Error("A Coding delivery disposition requires exact conversation, execution, job, branch, and commit identities");
  }
  return {
    schema: CODING_DELIVERY_DISPOSITION_SCHEMA,
    dispositionId: `coding_delivery_${hashCanonical(value).slice(0, 28)}`,
    ...value,
  };
};

export const codingDeliveryDispositionEvent = (
  disposition: CodingDeliveryDisposition,
  nodeId = "coordinator",
): Extract<OrchestrationEvent, { readonly type: "artifact.published" }> => inlineArtifactPublishedEvent({
  runId: disposition.executionRunId,
  artifactId: disposition.dispositionId,
  origin: "input",
  outputKey: "delivery_disposition",
  nodeId,
  kind: CODING_DELIVERY_DISPOSITION_KIND,
  inputVersions: { certified_commit: disposition.commit },
}, JSON.stringify(disposition));

export const createCodingRoomGitFrontier = (input: Omit<
  CodingRoomGitFrontier,
  "schema" | "frontierId"
>): CodingRoomGitFrontier => {
  const value = {
    conversationId: input.conversationId.trim(),
    roomId: input.roomId.trim(),
    branch: input.branch.trim(),
    commit: input.commit.trim(),
    epoch: input.epoch,
    ...(input.previousCommit ? { previousCommit: input.previousCommit.trim() } : {}),
    ...(input.targetBranch ? { targetBranch: input.targetBranch.trim() } : {}),
    ...(input.targetCommit ? { targetCommit: input.targetCommit.trim() } : {}),
    ...(input.executionRunId ? { executionRunId: input.executionRunId.trim() } : {}),
  };
  if (!value.conversationId || !value.roomId || !value.branch || !/^[a-f0-9]{40,64}$/.test(value.commit)) {
    throw new Error("A Coding room Git frontier requires exact room, branch, and commit identities");
  }
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 0) {
    throw new Error("A Coding room Git frontier epoch must be a non-negative safe integer");
  }
  if ((value.epoch === 0) !== !value.previousCommit
    || (value.previousCommit && !/^[a-f0-9]{40,64}$/.test(value.previousCommit))) {
    throw new Error("A Coding room Git frontier requires an exact previous commit after epoch zero");
  }
  if (Boolean(value.targetBranch) !== Boolean(value.targetCommit)
    || (value.targetCommit && !/^[a-f0-9]{40,64}$/.test(value.targetCommit))) {
    throw new Error("A Coding room Git frontier delivery target must contain both branch and commit");
  }
  const identity = { ...value };
  return {
    schema: CODING_ROOM_GIT_FRONTIER_SCHEMA,
    frontierId: `coding_room_frontier_${hashCanonical(identity).slice(0, 28)}`,
    ...identity,
  };
};

export const codingRoomGitFrontierEvent = (
  frontier: CodingRoomGitFrontier,
  nodeId = "coordinator",
): Extract<OrchestrationEvent, { readonly type: "artifact.published" }> => inlineArtifactPublishedEvent({
  runId: frontier.conversationId,
  artifactId: frontier.frontierId,
  origin: "input",
  outputKey: `room_git_frontier_${frontier.epoch}`,
  nodeId,
  kind: CODING_ROOM_GIT_FRONTIER_KIND,
  inputVersions: {
    room: frontier.roomId,
    ...(frontier.previousCommit ? { previous_frontier: frontier.previousCommit } : {}),
  },
}, JSON.stringify(frontier));

/** Replays the room frontier chain and rejects gaps or competing Git history. */
export const codingRoomGitFrontierFromEvents = (
  events: ReadonlyArray<OrchestrationEvent>,
): CodingRoomGitFrontier | undefined => {
  let current: CodingRoomGitFrontier | undefined;
  for (const event of events) {
    if (event.type !== "artifact.published"
      || event.kind !== CODING_ROOM_GIT_FRONTIER_KIND
      || event.payload.storage !== "inline") continue;
    let candidate: CodingRoomGitFrontier;
    try {
      const parsed = JSON.parse(event.payload.value) as CodingRoomGitFrontier;
      candidate = createCodingRoomGitFrontier(parsed);
      if (parsed.schema !== candidate.schema || parsed.frontierId !== candidate.frontierId) {
        throw new Error("content identity changed");
      }
    } catch (error) {
      throw new Error(`Coding room Git frontier is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!current) {
      if (candidate.epoch !== 0) throw new Error("Coding room Git frontier does not start at epoch zero");
    } else if (
      candidate.conversationId !== current.conversationId
      || candidate.roomId !== current.roomId
      || candidate.branch !== current.branch
      || candidate.epoch !== current.epoch + 1
      || candidate.previousCommit !== current.commit
      || candidate.targetBranch !== current.targetBranch
      || candidate.targetCommit !== current.targetCommit
    ) {
      throw new Error("Coding room Git frontier chain diverged");
    }
    current = candidate;
  }
  return current;
};

export const codingDeliveryDispositionFromEvents = (
  events: ReadonlyArray<OrchestrationEvent>,
): CodingDeliveryDisposition | undefined => events.flatMap((event): ReadonlyArray<CodingDeliveryDisposition> => {
  if (event.type !== "artifact.published"
    || event.kind !== CODING_DELIVERY_DISPOSITION_KIND
    || event.outputKey !== "delivery_disposition"
    || event.origin !== "input"
    || event.payload.storage !== "inline") return [];
  try {
    const value = JSON.parse(event.payload.value) as Partial<CodingDeliveryDisposition>;
    if (value.schema !== CODING_DELIVERY_DISPOSITION_SCHEMA
      || value.action !== "keep-branch"
      || typeof value.dispositionId !== "string"
      || typeof value.conversationId !== "string"
      || typeof value.executionRunId !== "string"
      || typeof value.jobId !== "string"
      || typeof value.branch !== "string"
      || typeof value.commit !== "string") return [];
    const parsed = createCodingDeliveryDisposition(value as Omit<CodingDeliveryDisposition, "schema" | "dispositionId">);
    return parsed.dispositionId === value.dispositionId ? [parsed] : [];
  } catch {
    return [];
  }
}).at(-1);

const parsedCodingRoomReaction = (value: string): CodingRoomReaction | undefined => {
  try {
    const parsed = JSON.parse(value) as Partial<CodingRoomReaction>;
    if (parsed.schema !== CODING_ROOM_REACTION_SCHEMA
      || typeof parsed.reactionId !== "string"
      || typeof parsed.conversationId !== "string"
      || typeof parsed.messageId !== "string"
      || typeof parsed.authorId !== "string"
      || typeof parsed.createdAt !== "number"
      || !CODING_ROOM_REACTION_EMOJIS.includes(parsed.emoji as CodingRoomReactionEmoji)) return undefined;
    return parsed as CodingRoomReaction;
  } catch {
    return undefined;
  }
};

export const codingRoomReactionsFromEvents = (
  events: ReadonlyArray<OrchestrationEvent>,
): ReadonlyArray<CodingRoomReaction> => events.flatMap((event) => {
  if (event.type !== "artifact.published"
    || event.kind !== CODING_ROOM_REACTION_KIND
    || event.payload.storage !== "inline") return [];
  const reaction = parsedCodingRoomReaction(event.payload.value);
  return reaction ? [reaction] : [];
}).sort((left, right) => left.createdAt - right.createdAt || left.reactionId.localeCompare(right.reactionId));

type CodingRoomTask = {
  readonly nodeId: string;
  readonly status: "waiting" | "delegated" | "running" | "completed" | "failed" | "blocked" | "canceled";
};

const roomSlug = (value: string): string => value
  .toLowerCase()
  .replace(/^refs\/heads\//, "")
  .replace(/^roster\/rooms\//, "")
  .replace(/^roster\//, "")
  .replace(/^room_repository_/, "")
  .replace(/[^a-z0-9._-]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 64) || "repository-room";

export const codingRepositoryRoomId = (conversationId: string): string =>
  `room_repository_${conversationId.trim() || "repository"}`;

const roomPresence = (
  participant: WorkspaceNodeSocialParticipant,
  tasks: ReadonlyArray<CodingRoomTask>,
): CodingRoomPresence => {
  if (participant.kind === "human") return "present";
  if (participant.kind === "system") return "facilitating";
  const statuses = tasks.filter((task) => task.nodeId === participant.nodeId).map((task) => task.status);
  return statuses.includes("running") ? "working" : "joined";
};

/**
 * Builds the social room read model from authoritative conversation, Git, node,
 * and task facts. The projection never schedules work or accepts a frontier.
 */
export const codingRoomProjection = (input: {
  readonly conversationId: string;
  readonly repositoryName?: string;
  readonly job?: {
    readonly id: string;
    readonly status: "queued" | "leased" | "running" | "completed" | "failed" | "canceled";
    readonly branch?: string;
    readonly commit?: string;
    readonly noChanges?: boolean;
    readonly integration?: {
      readonly integrated: boolean;
      readonly canIntegrate: boolean;
      readonly reason?: string;
    };
    readonly deliveryDisposition?: CodingDeliveryDisposition;
    readonly objective?: string;
  };
  readonly nodes: ReadonlyArray<WorkspaceNode>;
  readonly tasks?: ReadonlyArray<CodingRoomTask>;
  readonly waitingForHuman?: boolean;
}): CodingRoomProjection => {
  const conversationId = input.conversationId.trim() || "repository";
  const branch = input.job?.branch?.trim();
  const branchRoom = Boolean(branch);
  const parentRoomId = codingRepositoryRoomId(conversationId);
  const terminal = Boolean(input.job && ["completed", "failed", "canceled"].includes(input.job.status));
  const delivery = codingDeliveryState(input.job);
  const explicitlyArchived = delivery === "kept-branch";
  const readyToMerge = delivery === "ready";
  const deliveryBlocked = terminal && (delivery === "blocked" || delivery === "unavailable");
  const deliveryFinalizing = Boolean(
    terminal
    && branchRoom
    && !explicitlyArchived
    && !readyToMerge
    && !deliveryBlocked,
  );
  const state: CodingRoomState = input.waitingForHuman || deliveryBlocked
    ? "waiting"
    : explicitlyArchived
      ? "archived"
      : "open";
  const tasks = input.tasks ?? [];
  const participants = input.nodes
    .map(workspaceNodeSocialParticipant)
    .filter((participant) => participant.nodeId !== "coordinator" && participant.kind !== "system")
    .map((participant): CodingRoomParticipant => ({
      ...participant,
      presence: roomPresence(participant, tasks),
    }))
    .sort((left, right) => {
      const rank = (participant: CodingRoomParticipant): number => participant.kind === "human" ? 0 : 1;
      return rank(left) - rank(right) || left.displayName.localeCompare(right.displayName);
    });
  return {
    schema: CODING_ROOM_PROJECTION_SCHEMA,
    roomId: parentRoomId,
    conversationId,
    kind: branchRoom ? "branch" : "repository",
    title: `#${roomSlug(branch ?? input.repositoryName ?? "repository-room")}`,
    state,
    stateLabel: input.waitingForHuman
      ? "Waiting for you"
      : deliveryBlocked
        ? "Needs attention"
        : input.job?.deliveryDisposition?.action === "keep-branch"
          ? "Closed · branch kept"
          : readyToMerge
            ? "Ready to merge"
          : delivery === "integrated" || delivery === "no-changes"
            ? "Open room"
          : deliveryFinalizing
            ? "Finalizing delivery"
            : state === "archived"
              ? "Archived room"
              : "Open room",
    ...(input.job?.objective?.trim() ? { topic: input.job.objective.trim() } : {}),
    ...(branch ? { branch } : {}),
    ...(input.job ? { jobId: input.job.id } : {}),
    participants,
  };
};
