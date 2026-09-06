import type { WorkspaceNodeSocialParticipant } from "./node.js";

export type RoomPresenceState =
  | "present"
  | "facilitating"
  | "working"
  | "waiting"
  | "joined"
  | "away";

export type RoomPresence = {
  readonly state: RoomPresenceState;
  readonly label: string;
  readonly updatedAt?: number;
};

export type RoomContributionKind =
  | "message"
  | "handoff"
  | "proposal"
  | "evidence"
  | "review"
  | "artifact"
  | "decision";

export type RoomCurrentContribution = {
  readonly summary: string;
  readonly kind?: RoomContributionKind;
  readonly updatedAt?: number;
};

export type RoomRosterMember = {
  readonly participant: WorkspaceNodeSocialParticipant;
  readonly presence: RoomPresence;
  readonly contribution?: RoomCurrentContribution;
};

export type RoomRosterProjection = {
  readonly roomId: string;
  readonly label: string;
  readonly summary: string;
  readonly context?: string;
  readonly members: ReadonlyArray<RoomRosterMember>;
};

const kindRank: Readonly<Record<WorkspaceNodeSocialParticipant["kind"], number>> = {
  human: 0,
  system: 1,
  agent: 2,
};

const presenceRank: Readonly<Record<RoomPresenceState, number>> = {
  facilitating: 0,
  working: 1,
  present: 2,
  waiting: 3,
  joined: 4,
  away: 5,
};

const normalized = (value: string, label: string): string => {
  const result = value.trim();
  if (!result) throw new Error(`${label} must not be blank`);
  return result;
};

/**
 * Creates a deterministic, display-only room projection. It never carries
 * runtime placement, leases, sessions, task authority, or acceptance state.
 */
export const projectRoomRoster = (input: RoomRosterProjection): RoomRosterProjection => {
  const nodeIds = new Set<string>();
  const members = input.members.map((member) => {
    const nodeId = normalized(member.participant.nodeId, "Room member node id");
    if (nodeIds.has(nodeId)) throw new Error(`Duplicate room member ${nodeId}`);
    nodeIds.add(nodeId);
    return {
      participant: {
        ...member.participant,
        nodeId,
        displayName: normalized(member.participant.displayName, `Room member ${nodeId} display name`),
        fullName: normalized(member.participant.fullName, `Room member ${nodeId} full name`),
        handle: normalized(member.participant.handle, `Room member ${nodeId} handle`),
        role: normalized(member.participant.role, `Room member ${nodeId} role`),
      },
      presence: {
        ...member.presence,
        label: normalized(member.presence.label, `Room member ${nodeId} presence label`),
      },
      ...(member.contribution ? {
        contribution: {
          ...member.contribution,
          summary: normalized(member.contribution.summary, `Room member ${nodeId} contribution`),
        },
      } : {}),
    };
  }).sort((left, right) =>
    kindRank[left.participant.kind] - kindRank[right.participant.kind]
    || presenceRank[left.presence.state] - presenceRank[right.presence.state]
    || left.participant.displayName.localeCompare(right.participant.displayName)
    || left.participant.nodeId.localeCompare(right.participant.nodeId));
  return {
    roomId: normalized(input.roomId, "Room id"),
    label: normalized(input.label, "Room label"),
    summary: normalized(input.summary, "Room summary"),
    ...(input.context?.trim() ? { context: input.context.trim() } : {}),
    members,
  };
};

export const roomParticipant = (input: {
  readonly nodeId: string;
  readonly displayName: string;
  readonly role: string;
  readonly kind: WorkspaceNodeSocialParticipant["kind"];
  readonly presence: RoomPresenceState;
  readonly presenceLabel?: string;
  readonly handle?: string;
  readonly summary?: string;
  readonly persistent?: boolean;
  readonly contribution?: RoomCurrentContribution;
}): RoomRosterMember => ({
  participant: {
    nodeId: input.nodeId,
    displayName: input.displayName,
    fullName: input.displayName,
    handle: input.handle ?? `@${input.displayName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}`,
    role: input.role,
    kind: input.kind,
    ...(input.summary ? { summary: input.summary } : {}),
    persistent: input.persistent ?? true,
  },
  presence: {
    state: input.presence,
    label: input.presenceLabel ?? input.presence.replace(/^\w/, (character) => character.toUpperCase()),
  },
  ...(input.contribution ? { contribution: input.contribution } : {}),
});
