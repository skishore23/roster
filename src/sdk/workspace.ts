/** Stable logical-node, continuity, room, and shared-workspace contracts. */
export {
  createRosterTaskContext,
  createWorkspaceEntry,
  DEFAULT_SHARED_WORKSPACE_LIMITS,
  SharedWorkspaceLedger,
} from "../engine/workspace/shared-workspace.js";
export type {
  RosterTaskContext,
  SharedWorkspaceLimits,
  SharedWorkspaceValue,
  TaskWorkspaceAuthority,
  TaskWorkspaceFence,
  WorkspaceEntry,
  WorkspaceEntryInput,
  WorkspaceEntryKind,
  WorkspaceReadSelector,
} from "../engine/workspace/shared-workspace.js";

export {
  createNodeContinuityManifest,
  createNodeInboxDelivery,
  DEFAULT_NODE_CONTINUITY_POLICY,
  InMemoryNodeContinuityControl,
  NODE_CONTINUITY_MANIFEST_VERSION,
  NODE_CONTINUITY_SCHEMA_VERSION,
  normalizeWorkspaceNodeContinuityPolicy,
  reduceNodeContinuity,
  requestNodeWake,
} from "../engine/workspace/node-continuity.js";
export type {
  NodeCommitment,
  NodeCommitmentStatus,
  NodeContinuityControl,
  NodeContinuityEvent,
  NodeContinuityManifest,
  NodeContinuityState,
  NodeContinuityStatus,
  NodeInboxCause,
  NodeInboxItem,
  NodeMemoryFrontier,
  NodeWake,
  NodeWakeDecision,
  NormalizedWorkspaceNodeContinuityPolicy,
} from "../engine/workspace/node-continuity.js";

export {
  createWorkspaceNodeRuntimeBinding,
  MAX_WORKSPACE_NODE_NAME_LENGTH,
  normalizeWorkspaceNode,
  normalizeWorkspaceNodeName,
  normalizeWorkspaceNodeRuntime,
  projectWorkspaceNodes,
  resolveWorkspaceNodeName,
  rosterNativeRuntime,
  workspaceNodeSocialParticipant,
} from "../engine/workspace/node.js";
export type {
  WorkspaceNodeNameSource,
  WorkspaceNodeSocialParticipant,
} from "../engine/workspace/node.js";

export { projectRoomRoster, roomParticipant } from "../engine/workspace/room.js";
export type {
  RoomContributionKind,
  RoomCurrentContribution,
  RoomPresence,
  RoomPresenceState,
  RoomRosterMember,
  RoomRosterProjection,
} from "../engine/workspace/room.js";

export type {
  BuiltInWorkspaceNodeRuntimeKind,
  DomainCapability,
  DomainPack,
  DomainRegistry,
  OrchestrationLimits,
  WorkspaceNode,
  WorkspaceNodeContinuityPolicy,
  WorkspaceNodeRuntime,
  WorkspaceNodeRuntimeBinding,
  WorkspaceNodeRuntimeKind,
  WorkspaceNodeRuntimePlacement,
} from "../engine/orchestration/types.js";
