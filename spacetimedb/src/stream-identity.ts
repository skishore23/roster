/**
 * Physical stream keys are workspace-scoped because `event_stream.id` is a
 * module-wide primary key while callers address streams by a workspace-local
 * logical name. The length prefix keeps the encoding unambiguous.
 */
export const scopedStreamKey = (workspaceId: string, streamId: string): string =>
  `${workspaceId.length}:${workspaceId}${streamId}`;

/** Project a v2 physical key back to its workspace-local logical API name. */
export const logicalStreamId = (workspaceId: string, storedId: string): string => {
  const prefix = `${workspaceId.length}:${workspaceId}`;
  if (!storedId.startsWith(prefix)) {
    throw new Error("Roster v2 stream key does not belong to its workspace");
  }
  return storedId.slice(prefix.length);
};
