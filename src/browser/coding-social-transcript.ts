import { hashCanonical } from "../core/canonical.js";
import type { NodeRoomUpdate } from "../engine/runtime/node-room-updates.js";

export interface CodingSocialProjectionInput {
  participants: readonly CodingSocialParticipant[];
  messages: readonly CodingSocialMessageInput[];
  acceptedSummaries: readonly CodingSocialAcceptedSummaryInput[];
  tasks: readonly CodingSocialTaskInput[];
  edges: readonly CodingSocialTaskEdgeInput[];
  systemActivities: readonly CodingSocialSystemActivityInput[];
  roomUpdates: readonly NodeRoomUpdate[];
}

export interface CodingSocialMessageInput {
  sourceId: string;
  sourceSequence: string;
  at: string;
  authorNodeId: string;
  recipientNodeIds: readonly string[];
  body: string;
}

export interface CodingSocialAcceptedSummaryInput {
  artifactId: string;
  outputReference: string;
  sourceSequence: string;
  at: string;
  taskId: string;
  authorNodeId: string;
  body?: string;
}

export interface CodingSocialTaskInput {
  taskId: string;
  nodeId: string;
  state: "pending" | "running" | "accepted" | "failed";
}

export interface CodingSocialTaskEdgeInput {
  taskId: string;
  prerequisiteTaskId: string;
}

export interface CodingSocialSystemActivityInput {
  sourceId: string;
  sourceSequence: string;
  at: string;
  taskId: string;
  recipientNodeIds: readonly string[];
  kind: "claim" | "handoff" | "attention";
}

export type CodingSocialSourceKind =
  | "message"
  | "live-update"
  | "accepted-summary"
  | "system-activity";

export interface CodingSocialParticipant {
  nodeId: string;
  displayName: string;
  role: string;
  avatarLabel: string;
  human: boolean;
}

export interface CodingSocialRow {
  rowId: string;
  sourceId: string;
  sourceKind: CodingSocialSourceKind;
  author: CodingSocialParticipant;
  recipients: CodingSocialParticipant[];
  body: string;
  at: string;
  state: "sent" | "live" | "accepted" | "attention";
  durability: "durable" | "ephemeral";
  cluster: "start" | "continuation";
  clusterBoundary?: boolean;
  taskId?: string;
  updateId?: string;
  sequence?: number;
  intent?: NodeRoomUpdate["intent"];
  settled?: boolean;
}

export type CodingSocialUpsertRow = CodingSocialRow;

export interface CodingSocialDurableTimelineInput {
  sourceId: string;
  sourceSequence: string;
  at: string;
  authorNodeId: string;
  recipientNodeIds: readonly string[];
  body: string;
  sourceKind: "message" | "accepted-summary";
  taskId?: string;
  artifactId?: string;
  outputReference?: string;
}

const compareCanonicalText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const socialRowSequence = (row: CodingSocialUpsertRow): number =>
  Number.isSafeInteger(row.sequence) && (row.sequence ?? -1) >= 0 ? row.sequence! : -1;

const socialRowFingerprint = (row: CodingSocialUpsertRow): string => {
  const { cluster: _cluster, ...semantic } = row;
  return hashCanonical(semantic);
};

const compareSocialRowVersion = (
  left: CodingSocialUpsertRow,
  right: CodingSocialUpsertRow,
): number => socialRowSequence(left) - socialRowSequence(right)
  || Number(Boolean(left.settled)) - Number(Boolean(right.settled));

const compareCanonicalSocialRow = (
  left: CodingSocialUpsertRow,
  right: CodingSocialUpsertRow,
): number => compareSocialRowVersion(left, right)
  || compareCanonicalText(socialRowFingerprint(left), socialRowFingerprint(right));

const compareSocialRowOrder = (
  left: CodingSocialUpsertRow,
  right: CodingSocialUpsertRow,
): number => compareCanonicalText(left.at, right.at)
  || socialRowSequence(left) - socialRowSequence(right)
  || compareCanonicalText(left.rowId, right.rowId)
  || compareCanonicalText(socialRowFingerprint(left), socialRowFingerprint(right));

/**
 * Reconciles projected rows delivered in separate snapshots or stream events.
 * Stable row identity wins first, then live working rows collapse by logical
 * node/task while questions retain their independently authored identity.
 */
export const upsertCodingSocialRows = <Row extends CodingSocialRow>(
  existingRows: readonly Row[],
  incomingRows: readonly Row[],
): Row[] => {
  const candidatesByRowId = new Map<string, Row[]>();
  for (const row of [...existingRows, ...incomingRows]) {
    candidatesByRowId.set(row.rowId, [...(candidatesByRowId.get(row.rowId) ?? []), row]);
  }
  const rows = [...candidatesByRowId.values()].flatMap((candidates) => {
    const newest = [...candidates].sort((left, right) => compareSocialRowVersion(
      right as CodingSocialUpsertRow,
      left as CodingSocialUpsertRow,
    ))[0];
    if (!newest) return [];
    const newestVersion = candidates.filter((candidate) => compareSocialRowVersion(
      candidate as CodingSocialUpsertRow,
      newest as CodingSocialUpsertRow,
    ) === 0);
    const canonical = new Map(newestVersion.map((candidate) => [
      socialRowFingerprint(candidate as CodingSocialUpsertRow),
      candidate,
    ]));
    return canonical.size === 1 ? [canonical.values().next().value!] : [];
  });
  const latestWorkingByNodeTask = new Map<string, Row>();
  for (const row of rows) {
    const candidate = row as CodingSocialUpsertRow;
    if (candidate.sourceKind !== "live-update" || candidate.intent === "question" || !candidate.taskId) continue;
    const key = `${candidate.author.nodeId}\u0000${candidate.taskId}`;
    const current = latestWorkingByNodeTask.get(key);
    if (!current || compareCanonicalSocialRow(
      current as CodingSocialUpsertRow,
      candidate,
    ) < 0) latestWorkingByNodeTask.set(key, row);
  }

  const acceptedTaskIds = new Set(rows.flatMap((row) =>
    row.durability === "durable" && row.state === "accepted" && row.taskId ? [row.taskId] : []));
  return rows.filter((row) => {
    const candidate = row as CodingSocialUpsertRow;
    if (candidate.sourceKind !== "live-update" || candidate.intent === "question" || !candidate.taskId) return true;
    const key = `${candidate.author.nodeId}\u0000${candidate.taskId}`;
    if (latestWorkingByNodeTask.get(key)?.rowId !== candidate.rowId) return false;
    return !(candidate.settled && acceptedTaskIds.has(candidate.taskId));
  }).sort((left, right) => compareSocialRowOrder(
    left as CodingSocialUpsertRow,
    right as CodingSocialUpsertRow,
  ));
};

type Candidate = Omit<CodingSocialRow, "cluster"> & {
  readonly orderSequence: bigint;
  readonly orderPhase: 0 | 1;
  readonly handoffBoundary: boolean;
  readonly liveAnchor: boolean;
};

const ROSTER_PARTICIPANT: CodingSocialParticipant = {
  nodeId: "roster",
  displayName: "Roster",
  role: "System",
  avatarLabel: "RO",
  human: false,
};

const decimalSequence = (value: string): bigint | undefined => {
  const normalized = value.trim();
  return /^(?:0|[1-9][0-9]*)$/u.test(normalized) ? BigInt(normalized) : undefined;
};

const compareCandidate = (left: Candidate, right: Candidate): number =>
  left.orderSequence < right.orderSequence
    ? -1
    : left.orderSequence > right.orderSequence
      ? 1
      : left.orderPhase - right.orderPhase
        || left.at.localeCompare(right.at)
        || left.rowId.localeCompare(right.rowId);

const compareUpdateSequence = (left: NodeRoomUpdate, right: NodeRoomUpdate): number =>
  left.sequence - right.sequence
    || Number(left.settled) - Number(right.settled)
    || compareCanonicalText(hashCanonical({
      nodeId: left.nodeId,
      taskId: left.taskId,
      text: left.text,
      intent: left.intent,
      recipientNodeIds: [...left.recipientNodeIds].sort(),
      settled: left.settled,
    }), hashCanonical({
      nodeId: right.nodeId,
      taskId: right.taskId,
      text: right.text,
      intent: right.intent,
      recipientNodeIds: [...right.recipientNodeIds].sort(),
      settled: right.settled,
    }));

const sameRecipients = (
  left: readonly CodingSocialParticipant[],
  right: readonly CodingSocialParticipant[],
): boolean => left.length === right.length
  && left.every((participant, index) => participant.nodeId === right[index]?.nodeId);

export const clusterCodingSocialRows = <Row extends CodingSocialRow>(
  rows: readonly Row[],
): Row[] => rows.map((row, index) => {
  const previous = rows[index - 1];
  const cluster = previous
    && !previous.clusterBoundary
    && !row.clusterBoundary
    && previous.author.nodeId === row.author.nodeId
    && sameRecipients(previous.recipients, row.recipients)
    ? "continuation" as const
    : "start" as const;
  return { ...row, cluster };
});

export const reconcileCodingLiveSocialRows = <Row extends CodingSocialRow>(input: {
  readonly existingLiveRows: readonly Row[];
  readonly projectedLiveRows: readonly Row[];
  readonly durableRows: readonly Row[];
}): Row[] => {
  const projectedIds = new Set(input.projectedLiveRows.map((row) => row.rowId));
  return clusterCodingSocialRows(upsertCodingSocialRows(
    input.existingLiveRows,
    [...input.projectedLiveRows, ...input.durableRows],
  )).filter((row) => row.sourceKind === "live-update" && projectedIds.has(row.rowId));
};

const stableId = (kind: string, value: unknown): string => `${kind}_${hashCanonical(value)}`;

const validIdentity = (value: string): boolean => Boolean(value && value === value.trim());

const uniqueIdentityMap = <T>(
  values: readonly T[],
  identity: (value: T) => string,
): Map<string, T> => {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const id = identity(value);
    if (!validIdentity(id)) continue;
    const matches = grouped.get(id) ?? [];
    matches.push(value);
    grouped.set(id, matches);
  }
  return new Map([...grouped].flatMap(([id, matches]) => {
    const canonical = new Map<string, T>();
    for (const match of matches) canonical.set(hashCanonical(match), match);
    return canonical.size === 1 ? [[id, canonical.values().next().value!]] : [];
  }));
};

const candidateFingerprint = (candidate: Candidate): string => hashCanonical({
  ...candidate,
  orderSequence: candidate.orderSequence.toString(),
});

/**
 * Projects bounded public Coding conversation inputs into deterministic social
 * rows. It is presentation-only: accepted artifacts and task state remain the
 * durable authority, while room updates remain ephemeral authored text.
 */
export const projectCodingSocialRows = (
  input: CodingSocialProjectionInput,
): CodingSocialRow[] => {
  const participants = uniqueIdentityMap(input.participants, (participant) => participant.nodeId);
  const roster = participants.get("roster") ?? ROSTER_PARTICIPANT;
  const tasks = uniqueIdentityMap(input.tasks, (task) => task.taskId);
  for (const [taskId, task] of tasks) {
    if (!validIdentity(task.nodeId)) tasks.delete(taskId);
  }
  const edges = input.edges.filter((edge) => tasks.has(edge.taskId)
    && tasks.has(edge.prerequisiteTaskId)
    && edge.taskId !== edge.prerequisiteTaskId)
    .filter((edge, index, all) => all.findIndex((candidate) => candidate.taskId === edge.taskId
      && candidate.prerequisiteTaskId === edge.prerequisiteTaskId) === index);

  const participantList = (
    nodeIds: readonly string[],
    authorNodeId?: string,
  ): CodingSocialParticipant[] | undefined => {
    if (nodeIds.some((nodeId) => !validIdentity(nodeId))) return undefined;
    const unique = [...new Set(nodeIds)].sort();
    if (unique.length > 6) return undefined;
    const addressed = unique.filter((nodeId) => nodeId !== authorNodeId);
    const resolved = addressed.flatMap((nodeId) => {
      const participant = participants.get(nodeId);
      return participant ? [participant] : [];
    });
    return resolved.length === addressed.length ? resolved : undefined;
  };

  const humanNodeIds = [...participants.values()]
    .filter((participant) => participant.human)
    .map((participant) => participant.nodeId)
    .sort();

  const directRecipientNodeIds = (taskId: string): string[] => {
    if (taskId.startsWith("announce-")) {
      const sourceNodeId = tasks.get(taskId)?.nodeId;
      return [...new Set(humanNodeIds)]
        .filter((nodeId) => nodeId !== sourceNodeId)
        .sort();
    }
    const downstream = edges
      .filter((edge) => edge.prerequisiteTaskId === taskId)
      .flatMap((edge) => tasks.get(edge.taskId)?.nodeId ?? []);
    const upstream = edges
      .filter((edge) => edge.taskId === taskId)
      .flatMap((edge) => tasks.get(edge.prerequisiteTaskId)?.nodeId ?? []);
    const sourceNodeId = tasks.get(taskId)?.nodeId;
    return [...new Set(downstream.length > 0 ? downstream : upstream)]
      .filter((nodeId) => nodeId !== sourceNodeId)
      .sort();
  };

  const allDirectRecipientNodeIds = (taskId: string): Set<string> => new Set(edges
    .filter((edge) => edge.taskId === taskId || edge.prerequisiteTaskId === taskId)
    .flatMap((edge) => {
      const adjacentTaskId = edge.taskId === taskId ? edge.prerequisiteTaskId : edge.taskId;
      const nodeId = tasks.get(adjacentTaskId)?.nodeId;
      return nodeId ? [nodeId] : [];
    }));

  const durableCandidates: Candidate[] = [];
  for (const message of input.messages) {
    const sequence = decimalSequence(message.sourceSequence);
    const author = participants.get(message.authorNodeId);
    const body = message.body.trim();
    if (sequence === undefined || !author || !validIdentity(message.sourceId) || !body) continue;
    const recipients = participantList(message.recipientNodeIds, author.nodeId);
    if (!recipients) continue;
    const rowId = stableId("coding_social_message", {
      sourceId: message.sourceId,
      authorNodeId: author.nodeId,
      recipientNodeIds: recipients.map((recipient) => recipient.nodeId),
      body,
    });
    durableCandidates.push({
      rowId,
      sourceId: message.sourceId,
      sourceKind: "message",
      author,
      recipients,
      body,
      at: message.at,
      state: "sent",
      durability: "durable",
      orderSequence: sequence,
      orderPhase: 0,
      handoffBoundary: false,
      liveAnchor: false,
    });
  }

  const structurallyValidSummaries = input.acceptedSummaries.filter((summary) => {
    if (!validIdentity(summary.artifactId)
      || !validIdentity(summary.outputReference)
      || !validIdentity(summary.taskId)
      || !validIdentity(summary.authorNodeId)
      || !summary.at
      || decimalSequence(summary.sourceSequence) === undefined
      || (summary.body !== undefined && typeof summary.body !== "string")) return false;
    const task = tasks.get(summary.taskId);
    return task?.state === "accepted"
      && task.nodeId === summary.authorNodeId
      && participants.has(summary.authorNodeId)
      && participantList(directRecipientNodeIds(summary.taskId), summary.authorNodeId) !== undefined;
  });
  const artifactReferences = new Map<string, Set<string>>();
  for (const summary of structurallyValidSummaries) {
    const references = artifactReferences.get(summary.artifactId) ?? new Set<string>();
    references.add(summary.outputReference);
    artifactReferences.set(summary.artifactId, references);
  }
  const conflictedArtifactIds = new Set([...artifactReferences]
    .filter(([, references]) => references.size > 1)
    .map(([artifactId]) => artifactId));
  const summariesByOutput = new Map<string, CodingSocialAcceptedSummaryInput[]>();
  for (const summary of structurallyValidSummaries) {
    if (conflictedArtifactIds.has(summary.artifactId)) continue;
    const summaries = summariesByOutput.get(summary.outputReference) ?? [];
    summaries.push(summary);
    summariesByOutput.set(summary.outputReference, summaries);
  }
  const selectedSummaries: CodingSocialAcceptedSummaryInput[] = [];
  for (const summaries of summariesByOutput.values()) {
    summaries.sort((left, right) => {
      const validity = Number(Boolean(right.body?.trim())) - Number(Boolean(left.body?.trim()));
      if (validity !== 0) return validity;
      const leftSequence = decimalSequence(left.sourceSequence);
      const rightSequence = decimalSequence(right.sourceSequence);
      if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
        return leftSequence < rightSequence ? -1 : 1;
      }
      return left.at.localeCompare(right.at)
        || left.artifactId.localeCompare(right.artifactId)
        || hashCanonical(left).localeCompare(hashCanonical(right));
    });
    if (summaries[0]) selectedSummaries.push(summaries[0]);
  }

  type AcceptedFrontier = {
    readonly task: CodingSocialTaskInput;
    readonly participant: CodingSocialParticipant;
    readonly sequence: bigint;
    readonly at: string;
    readonly artifactId: string;
  };
  const acceptedFrontierByTask = new Map<string, AcceptedFrontier>();
  const durablyReplacedTaskIds = new Set<string>();
  for (const summary of selectedSummaries) {
    const sequence = decimalSequence(summary.sourceSequence);
    if (sequence === undefined) continue;
    const task = tasks.get(summary.taskId);
    const recipients = participantList(directRecipientNodeIds(summary.taskId), summary.authorNodeId);
    if (!task || !recipients) continue;
    const body = typeof summary.body === "string" ? summary.body.trim() : "";
    const author = participants.get(summary.authorNodeId);
    if (!author) continue;
    const authored = Boolean(body);
    const sourceId = summary.artifactId;
    if (authored) {
      const rowId = stableId("coding_social_summary", {
        artifactId: summary.artifactId,
        outputReference: summary.outputReference,
        authorNodeId: author.nodeId,
        recipientNodeIds: recipients.map((recipient) => recipient.nodeId),
        body,
      });
      durableCandidates.push({
        rowId,
        sourceId,
        sourceKind: "accepted-summary",
        author,
        recipients,
        body,
        at: summary.at,
        state: "accepted",
        durability: "durable",
        taskId: summary.taskId,
        orderSequence: sequence,
        orderPhase: 0,
        handoffBoundary: recipients.length > 0,
        liveAnchor: false,
      });
    } else {
      const authorName = author?.displayName ?? "the assigned node";
      const recipientNames = recipients.map((recipient) => recipient.displayName).join(", ");
      const delivery = recipientNames
        ? `Accepted work from ${authorName} was delivered to ${recipientNames}.`
        : `Accepted work for task ${summary.taskId} was recorded.`;
      durableCandidates.push({
        rowId: stableId("coding_social_system", {
          sourceId,
          taskId: summary.taskId,
          recipientNodeIds: recipients.map((recipient) => recipient.nodeId),
          body: delivery,
        }),
        sourceId,
        sourceKind: "system-activity",
        author: roster,
        recipients,
        body: delivery,
        at: summary.at,
        state: "accepted",
        durability: "durable",
        taskId: summary.taskId,
        orderSequence: sequence,
        orderPhase: 0,
        handoffBoundary: recipients.length > 0,
        liveAnchor: false,
      });
    }
    durablyReplacedTaskIds.add(summary.taskId);
    const frontier = { task, participant: author, sequence, at: summary.at, artifactId: summary.artifactId };
    const previousFrontier = acceptedFrontierByTask.get(summary.taskId);
    if (!previousFrontier
      || previousFrontier.sequence < frontier.sequence
      || (previousFrontier.sequence === frontier.sequence
        && (previousFrontier.at < frontier.at
          || (previousFrontier.at === frontier.at
            && previousFrontier.artifactId.localeCompare(frontier.artifactId) < 0)))) {
      acceptedFrontierByTask.set(summary.taskId, frontier);
    }
  }

  const updatesById = new Map<string, NodeRoomUpdate[]>();
  for (const roomUpdate of input.roomUpdates) {
    if (!Number.isSafeInteger(roomUpdate.sequence) || roomUpdate.sequence < 0) continue;
    if (!validIdentity(roomUpdate.updateId)) continue;
    const matches = updatesById.get(roomUpdate.updateId) ?? [];
    matches.push(roomUpdate);
    updatesById.set(roomUpdate.updateId, matches);
  }
  const selectedUpdates = [...updatesById.values()].map((matches) => [...matches].sort(compareUpdateSequence).at(-1)!);
  const latestWorkingByNodeTask = new Map<string, NodeRoomUpdate>();
  const questions: NodeRoomUpdate[] = [];
  for (const roomUpdate of selectedUpdates) {
    if (roomUpdate.intent === "question") {
      questions.push(roomUpdate);
      continue;
    }
    const key = `${roomUpdate.nodeId}\u0000${roomUpdate.taskId}`;
    const existing = latestWorkingByNodeTask.get(key);
    if (!existing || compareUpdateSequence(existing, roomUpdate) < 0) {
      latestWorkingByNodeTask.set(key, roomUpdate);
    }
  }
  const retainedUpdates = [...questions, ...latestWorkingByNodeTask.values()];
  const liveInputs: Array<{
    readonly update: NodeRoomUpdate;
    readonly author: CodingSocialParticipant;
    readonly recipients: CodingSocialParticipant[];
    readonly body: string;
  }> = [];
  for (const activity of input.systemActivities) {
    const sequence = decimalSequence(activity.sourceSequence);
    const task = tasks.get(activity.taskId);
    if (sequence === undefined || !task || !validIdentity(activity.sourceId) || !activity.at) continue;
    if (activity.kind === "handoff" && durablyReplacedTaskIds.has(activity.taskId)) continue;
    if (activity.kind === "attention" && task.state === "failed") continue;
    const recipients = participantList(activity.recipientNodeIds, roster.nodeId);
    const assigneeParticipant = participants.get(task.nodeId);
    if (!recipients || !assigneeParticipant) continue;
    const assignee = assigneeParticipant.displayName;
    const body = activity.kind === "claim"
      ? `${assignee} claimed the task delivery.`
      : activity.kind === "handoff"
        ? `Accepted work was delivered to ${recipients.map((recipient) => recipient.displayName).join(", ") || assignee}.`
        : `Task delivery for ${assignee} needs attention.`;
    durableCandidates.push({
      rowId: stableId("coding_social_system", {
        sourceId: activity.sourceId,
        kind: activity.kind,
        taskId: activity.taskId,
        recipientNodeIds: recipients.map((recipient) => recipient.nodeId),
      }),
      sourceId: activity.sourceId,
      sourceKind: "system-activity",
      author: roster,
      recipients,
      body,
      at: activity.at,
      state: activity.kind === "attention" ? "attention" : "sent",
      durability: "durable",
      taskId: activity.taskId,
      orderSequence: sequence,
      orderPhase: 0,
      handoffBoundary: activity.kind !== "claim",
      liveAnchor: activity.kind === "claim" || activity.kind === "handoff",
    });
  }

  for (const task of tasks.values()) {
    if (task.state !== "failed") continue;
    const upstreamTaskIds = edges
      .filter((edge) => edge.taskId === task.taskId)
      .map((edge) => edge.prerequisiteTaskId)
      .filter((taskId, index, all) => all.indexOf(taskId) === index);
    const frontier = upstreamTaskIds
      .flatMap((taskId) => acceptedFrontierByTask.get(taskId) ?? [])
      .filter((accepted) => accepted.task.state === "accepted");
    if (frontier.length === 0) continue;
    const recipients = participantList([
      ...humanNodeIds,
      ...frontier.map((accepted) => accepted.participant.nodeId),
    ], roster.nodeId);
    const assigneeParticipant = participants.get(task.nodeId);
    if (!recipients || !assigneeParticipant) continue;
    const upstreamNames = [...new Set(frontier.map((accepted) => accepted.participant.displayName))].sort().join(", ");
    const assignee = assigneeParticipant.displayName;
    const body = upstreamNames
      ? `Delivery to ${assignee} needs attention after accepted work from ${upstreamNames}.`
      : `Delivery to ${assignee} needs attention.`;
    const latest = [...frontier].sort((left, right) => left.sequence < right.sequence
      ? 1
      : left.sequence > right.sequence ? -1 : left.at.localeCompare(right.at))[0]!;
    durableCandidates.push({
      rowId: stableId("coding_social_attention", {
        taskId: task.taskId,
        upstreamTaskIds: frontier.map((accepted) => accepted.task.taskId).sort(),
        recipientNodeIds: recipients.map((recipient) => recipient.nodeId),
      }),
      sourceId: `task-attention:${task.taskId}`,
      sourceKind: "system-activity",
      author: roster,
      recipients,
      body,
      at: latest.at,
      state: "attention",
      durability: "durable",
      taskId: task.taskId,
      orderSequence: latest.sequence + 1n,
      orderPhase: 0,
      handoffBoundary: true,
      liveAnchor: false,
    });
  }

  for (const roomUpdate of retainedUpdates) {
    if (roomUpdate.intent !== "question"
      && roomUpdate.settled
      && durablyReplacedTaskIds.has(roomUpdate.taskId)) continue;
    const author = participants.get(roomUpdate.nodeId);
    const task = tasks.get(roomUpdate.taskId);
    const body = roomUpdate.text.trim();
    if (!author || task?.nodeId !== roomUpdate.nodeId || !body) continue;
    const suppliedRecipients = participantList(roomUpdate.recipientNodeIds, roomUpdate.nodeId);
    if (!suppliedRecipients) continue;
    const allowedRecipients = allDirectRecipientNodeIds(roomUpdate.taskId);
    for (const humanNodeId of humanNodeIds) allowedRecipients.add(humanNodeId);
    if (suppliedRecipients.some((participant) => !allowedRecipients.has(participant.nodeId))) continue;
    liveInputs.push({ update: roomUpdate, author, recipients: suppliedRecipients, body });
  }

  const durableForAnchor = [...durableCandidates];
  const liveCandidates: Candidate[] = liveInputs.map(({ update: roomUpdate, author, recipients, body }) => {
    const prerequisiteTaskIds = edges
      .filter((edge) => edge.taskId === roomUpdate.taskId)
      .map((edge) => edge.prerequisiteTaskId);
    const taskAnchors = durableForAnchor.filter((candidate) => candidate.taskId === roomUpdate.taskId
      && candidate.liveAnchor);
    const upstreamAnchors = prerequisiteTaskIds.flatMap((taskId) => {
      const accepted = acceptedFrontierByTask.get(taskId);
      return accepted ? [accepted.sequence] : [];
    });
    const globalAnchors = durableForAnchor
      .filter((candidate) => candidate.at <= roomUpdate.at)
      .map((candidate) => candidate.orderSequence);
    const anchorSequence = [
      ...taskAnchors.map((candidate) => candidate.orderSequence),
      ...upstreamAnchors,
      ...globalAnchors,
      0n,
    ].sort((left, right) => left < right ? 1 : left > right ? -1 : 0)[0]!;
    return {
      rowId: roomUpdate.updateId,
      sourceId: roomUpdate.updateId,
      sourceKind: "live-update" as const,
      author,
      recipients,
      body,
      at: roomUpdate.at,
      state: "live" as const,
      durability: "ephemeral" as const,
      taskId: roomUpdate.taskId,
      updateId: roomUpdate.updateId,
      sequence: roomUpdate.sequence,
      intent: roomUpdate.intent,
      settled: roomUpdate.settled,
      orderSequence: anchorSequence,
      orderPhase: 1 as const,
      handoffBoundary: roomUpdate.intent === "acknowledgement",
      liveAnchor: false,
    };
  });

  const byRowId = new Map<string, Candidate[]>();
  for (const candidate of [...durableCandidates, ...liveCandidates]) {
    const matches = byRowId.get(candidate.rowId) ?? [];
    matches.push(candidate);
    byRowId.set(candidate.rowId, matches);
  }
  const sorted = [...byRowId.values()]
    .map((matches) => [...matches].sort((left, right) => candidateFingerprint(left).localeCompare(candidateFingerprint(right)))[0]!)
    .sort(compareCandidate);
  return clusterCodingSocialRows(sorted.map((candidate): CodingSocialRow => {
    const {
      orderSequence: _orderSequence,
      orderPhase: _orderPhase,
      handoffBoundary: _handoffBoundary,
      liveAnchor: _liveAnchor,
      ...row
    } = candidate;
    return { ...row, cluster: "start", clusterBoundary: candidate.handoffBoundary };
  }));
};

/**
 * Projects the public, already-sanitized durable room timeline through the
 * same row identity and graph-aware addressing contract as server rendering.
 * Private task definitions and artifact payloads are intentionally absent.
 */
export const projectCodingDurableTimelineRows = (input: {
  readonly participants: readonly CodingSocialParticipant[];
  readonly tasks: readonly CodingSocialTaskInput[];
  readonly edges: readonly CodingSocialTaskEdgeInput[];
  readonly messages: readonly CodingSocialDurableTimelineInput[];
}): CodingSocialRow[] => projectCodingSocialRows({
  participants: input.participants,
  messages: input.messages.flatMap((message) => message.sourceKind === "message" ? [{
    sourceId: message.sourceId,
    sourceSequence: message.sourceSequence,
    at: message.at,
    authorNodeId: message.authorNodeId,
    recipientNodeIds: message.recipientNodeIds,
    body: message.body,
  }] : []),
  acceptedSummaries: input.messages.flatMap((message) =>
    message.sourceKind === "accepted-summary"
      && message.taskId
      && message.artifactId
      && message.outputReference
      ? [{
          artifactId: message.artifactId,
          outputReference: message.outputReference,
          sourceSequence: message.sourceSequence,
          at: message.at,
          taskId: message.taskId,
          authorNodeId: message.authorNodeId,
          body: message.body,
        }]
      : []),
  tasks: input.tasks,
  edges: input.edges,
  systemActivities: [],
  roomUpdates: [],
});
