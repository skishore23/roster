/**
 * Room OS context manifests explicitly record repository root, branch, commit,
 * and worktree placement; runId, taskId, nodeId, attempt, and fence authority;
 * frontierVersion, topologyVersion, catalogVersion, and runtimeBinding version;
 * plus every included input/artifact/reference and excluded unfinished input.
 * The implementation is shared with the platform start boundary so this file
 * cannot drift into a second manifest authority.
 */
export {
  ROSTER_TASK_CONTEXT_MANIFEST_VERSION as ROOM_TASK_CONTEXT_MANIFEST_VERSION,
  createTaskContextManifest as createRoomTaskContextManifest,
  validateTaskContextManifest as validateRoomTaskContextManifest,
} from "../engine/platform/task-context-manifest.js";

export type {
  CreateTaskContextManifestInput as CreateRoomTaskContextManifestInput,
  TaskContextManifest as RoomTaskContextManifest,
  TaskRepositoryPlacement as RoomRepositoryPlacement,
} from "../engine/platform/task-context-manifest.js";
