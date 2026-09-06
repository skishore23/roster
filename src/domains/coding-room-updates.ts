import type { NodeRoomUpdateStore } from "../engine/runtime/node-room-updates.js";

export const CODING_ROOM_POST_UPDATE_FUNCTION_ID = "coding::room.post-update" as const;
export const CODING_ROOM_UPDATE_SCOPE = "room:update" as const;

export interface CodingRoomUpdateProviderOptions {
  roomUpdates: NodeRoomUpdateStore;
  recipientPolicyForTask: (
    taskId: string,
    nodeId: string,
  ) => CodingRoomUpdateRecipientPolicy | Promise<CodingRoomUpdateRecipientPolicy>;
}

export interface CodingRoomUpdateRecipientPolicy {
  upstreamNodeIds: readonly string[];
  downstreamNodeIds: readonly string[];
  humanNodeId: string;
}

export interface CodingRoomUpdateTask {
  readonly id: string;
  readonly nodeId: string;
  readonly needs: readonly string[];
  readonly provides: readonly string[];
}

const requiredIdentity = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Coding room update ${label} is missing`);
  return normalized;
};

const sortedNodeIds = (nodeIds: Iterable<string>, currentNodeId: string): readonly string[] =>
  Object.freeze([...new Set(nodeIds)]
    .filter((nodeId) => nodeId !== currentNodeId)
    .sort());

/** Derives direct room recipients from the durable Coding task artifact graph. */
export const codingRoomUpdateRecipientPolicy = (
  tasks: readonly CodingRoomUpdateTask[],
  taskId: string,
  humanNodeId: string,
  expectedNodeId?: string,
): CodingRoomUpdateRecipientPolicy => {
  const tasksById = new Map<string, CodingRoomUpdateTask>();
  const producerByOutput = new Map<string, CodingRoomUpdateTask>();
  for (const task of tasks) {
    const id = requiredIdentity(task.id, "task id");
    requiredIdentity(task.nodeId, `task ${id} assignment`);
    if (tasksById.has(id)) throw new Error(`Coding room update task id ${id} is duplicated`);
    tasksById.set(id, task);
    for (const output of task.provides) {
      const outputKey = requiredIdentity(output, `task ${id} output`);
      if (producerByOutput.has(outputKey)) {
        throw new Error(`Coding room update output ${outputKey} has multiple producers`);
      }
      producerByOutput.set(outputKey, task);
    }
  }

  const currentTaskId = requiredIdentity(taskId, "task binding");
  const current = tasksById.get(currentTaskId);
  if (!current) throw new Error(`Coding room update task ${currentTaskId} is missing`);
  const currentNodeId = requiredIdentity(current.nodeId, `task ${currentTaskId} assignment`);
  if (expectedNodeId !== undefined) {
    const callerNodeId = requiredIdentity(expectedNodeId, "caller node assignment");
    if (callerNodeId !== currentNodeId) {
      throw new Error(
        `Coding room update task ${currentTaskId} is assigned to ${currentNodeId}, not ${callerNodeId}`,
      );
    }
  }
  const human = requiredIdentity(humanNodeId, "human node assignment");
  const upstreamNodeIds = sortedNodeIds(current.needs.flatMap((inputKey) => {
    const producer = producerByOutput.get(inputKey);
    return producer
      ? [requiredIdentity(producer.nodeId, `task ${producer.id} assignment`)]
      : [];
  }), currentNodeId);
  const downstreamNodeIds = sortedNodeIds(tasks.flatMap((candidate) =>
    candidate.needs.some((inputKey) => current.provides.includes(inputKey))
      ? [requiredIdentity(candidate.nodeId, `task ${candidate.id} assignment`)]
      : []), currentNodeId);

  return Object.freeze({
    upstreamNodeIds,
    downstreamNodeIds,
    humanNodeId: human,
  });
};
