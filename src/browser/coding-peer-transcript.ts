import { hashCanonical } from "../core/canonical.js";
import {
  projectCodingSocialRows,
  type CodingSocialAcceptedSummaryInput,
  type CodingSocialParticipant,
} from "./coding-social-transcript.js";

type PeerTranscriptReceipt = {
  readonly id: string;
  readonly streamId: string;
  readonly seq: bigint;
  readonly occurredAtMs: bigint;
  readonly bodyJson: string;
};

type PeerTranscriptTask = {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
};

type PeerTranscriptEdge = {
  readonly runId: string;
  readonly taskKey: string;
  readonly prerequisiteTaskKey: string;
};

type PeerTranscriptNode = {
  readonly runId: string;
  readonly nodeId: string;
  readonly name: string;
};

export type CodingPeerTranscriptMessage = {
  readonly rowId: string;
  readonly seq: bigint;
  readonly occurredAtMs: bigint;
  readonly messageId: string;
  readonly artifactId: string;
  readonly taskId: string;
  readonly authorNodeId: string;
  readonly authorName: string;
  readonly kind: "proposal" | "response" | "resolution" | "endorsement";
  readonly text: string;
  readonly recipients: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
};

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

const parseRecord = (value: string): Readonly<Record<string, unknown>> | undefined => {
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
};

const stringValue = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const displayName = (name: string, fallback: string): string =>
  name.split(",", 1)[0]?.trim() || name.trim() || fallback;

const safeIsoTimestamp = (occurredAtMs: bigint): string | undefined => {
  if (occurredAtMs < 0n || occurredAtMs > 8_640_000_000_000_000n) return undefined;
  const numeric = Number(occurredAtMs);
  if (!Number.isSafeInteger(numeric)) return undefined;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const taskForKey = (
  tasks: ReadonlyArray<PeerTranscriptTask>,
  key: string,
): PeerTranscriptTask | undefined => {
  const exactIds = tasks.filter((task) => task.id === key);
  if (exactIds.length !== 0) return exactIds.length === 1 ? exactIds[0] : undefined;
  const exactTaskIds = tasks.filter((task) => task.taskId === key);
  if (exactTaskIds.length !== 0) return exactTaskIds.length === 1 ? exactTaskIds[0] : undefined;
  const suffixes = tasks.filter((task) => key.endsWith(`:${task.taskId}`));
  return suffixes.length === 1 ? suffixes[0] : undefined;
};

const contribution = (
  outputKey: string,
  value: Readonly<Record<string, unknown>>,
): { readonly kind: CodingPeerTranscriptMessage["kind"]; readonly text: string } | undefined => {
  const summary = stringValue(value.summary).slice(0, 1_200);
  if (!summary) return undefined;
  if (outputKey.startsWith("collaboration_proposal_") && value.status === "proposal") {
    return { kind: "proposal", text: summary };
  }
  if (outputKey.startsWith("collaboration_response_") && value.status === "response") {
    return { kind: "response", text: summary };
  }
  if (outputKey === "collaboration_resolution"
    && ["aligned", "resolved", "ambiguous"].includes(stringValue(value.status))) {
    return { kind: "resolution", text: summary };
  }
  if (outputKey.startsWith("collaboration_endorsement_")
    && ["approve", "changes_requested"].includes(stringValue(value.verdict))) {
    return { kind: "endorsement", text: summary };
  }
  return undefined;
};

const participantFor = (node: PeerTranscriptNode): CodingSocialParticipant => {
  const name = displayName(node.name, node.nodeId);
  const role = node.name.split(",").slice(1).join(",").trim() || "Workspace node";
  const avatarLabel = name.split(/\s+/u).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase()
    || node.nodeId.slice(0, 2).toUpperCase();
  return {
    nodeId: node.nodeId,
    displayName: name,
    role,
    avatarLabel,
    human: false,
  };
};

type ParsedPeerContribution = {
  readonly receipt: PeerTranscriptReceipt;
  readonly artifactId: string;
  readonly taskId: string;
  readonly authorNodeId: string;
  readonly kind: CodingPeerTranscriptMessage["kind"];
  readonly text: string;
};

/**
 * Projects accepted collaboration artifacts into a chronological social
 * transcript. The artifacts remain the durable authority; this function only
 * turns their validated summaries and graph relationships into live room copy.
 */
export const projectCodingPeerTranscript = (input: {
  readonly runId: string;
  readonly receipts: ReadonlyArray<PeerTranscriptReceipt>;
  readonly tasks: ReadonlyArray<PeerTranscriptTask>;
  readonly edges: ReadonlyArray<PeerTranscriptEdge>;
  readonly nodes: ReadonlyArray<PeerTranscriptNode>;
}): ReadonlyArray<CodingPeerTranscriptMessage> => {
  const runStream = `agents/coding-agent/runs/${input.runId}`;
  const runTasks = input.tasks.filter((task) => task.runId === input.runId);
  const tasks = runTasks.filter((task) => runTasks.filter((candidate) => candidate.taskId === task.taskId).length === 1
    && runTasks.filter((candidate) => candidate.id === task.id).length === 1);
  const edges = input.edges.filter((edge) => edge.runId === input.runId);
  const runNodes = input.nodes.filter((node) => !node.runId || node.runId === input.runId);
  const nodes = runNodes.filter((node) => runNodes.filter((candidate) => candidate.nodeId === node.nodeId).length === 1);
  const parsed = input.receipts
    .filter((receipt) => receipt.streamId === runStream
      && receipt.seq >= 0n
      && safeIsoTimestamp(receipt.occurredAtMs) !== undefined)
    .flatMap((receipt): ReadonlyArray<ParsedPeerContribution> => {
      const event = parseRecord(receipt.bodyJson);
      const payload = record(event?.payload);
      if (event?.type !== "artifact.published"
        || event.origin !== "task"
        || payload?.storage !== "inline"
        || typeof payload.value !== "string") return [];
      const outputKey = stringValue(event.outputKey);
      const value = parseRecord(payload.value);
      const projected = value ? contribution(outputKey, value) : undefined;
      if (!projected) return [];
      const artifactId = stringValue(event.artifactId);
      const taskId = stringValue(event.taskId);
      const authorNodeId = stringValue(event.nodeId);
      if (!artifactId || !taskId || !authorNodeId) return [];
      const sourceTask = tasks.find((task) => task.taskId === taskId);
      if (!sourceTask || sourceTask.nodeId !== authorNodeId) return [];
      return [{
        receipt,
        artifactId,
        taskId,
        authorNodeId,
        kind: projected.kind,
        text: projected.text,
      }];
    });

  const parsedByArtifact = new Map<string, ParsedPeerContribution>();
  for (const item of parsed) {
    const existing = parsedByArtifact.get(item.artifactId);
    if (!existing
      || item.receipt.seq < existing.receipt.seq
      || (item.receipt.seq === existing.receipt.seq
        && (item.receipt.occurredAtMs < existing.receipt.occurredAtMs
          || (item.receipt.occurredAtMs === existing.receipt.occurredAtMs
            && hashCanonical({
              receiptId: item.receipt.id,
              artifactId: item.artifactId,
              taskId: item.taskId,
              authorNodeId: item.authorNodeId,
              kind: item.kind,
              text: item.text,
            }).localeCompare(hashCanonical({
              receiptId: existing.receipt.id,
              artifactId: existing.artifactId,
              taskId: existing.taskId,
              authorNodeId: existing.authorNodeId,
              kind: existing.kind,
              text: existing.text,
            })) < 0)))) {
      parsedByArtifact.set(item.artifactId, item);
    }
  }
  const selected = [...parsedByArtifact.values()];
  const acceptedSummaries: CodingSocialAcceptedSummaryInput[] = selected.map((item) => ({
    artifactId: item.artifactId,
    outputReference: item.artifactId,
    sourceSequence: item.receipt.seq.toString(),
    at: safeIsoTimestamp(item.receipt.occurredAtMs)!,
    taskId: item.taskId,
    authorNodeId: item.authorNodeId,
    body: item.text,
  }));
  const socialRows = projectCodingSocialRows({
    participants: nodes.map(participantFor),
    messages: [],
    acceptedSummaries,
    tasks: tasks.map((task) => ({ taskId: task.taskId, nodeId: task.nodeId, state: "accepted" as const })),
    edges: edges.flatMap((edge) => {
      const task = taskForKey(tasks, edge.taskKey);
      const prerequisite = taskForKey(tasks, edge.prerequisiteTaskKey);
      return task && prerequisite
        ? [{ taskId: task.taskId, prerequisiteTaskId: prerequisite.taskId }]
        : [];
    }),
    systemActivities: [],
    roomUpdates: [],
  });

  return socialRows.flatMap((row): ReadonlyArray<CodingPeerTranscriptMessage> => {
    if (row.sourceKind !== "accepted-summary") return [];
    const item = parsedByArtifact.get(row.sourceId);
    if (!item) return [];
    return [{
      rowId: row.rowId,
      seq: item.receipt.seq,
      occurredAtMs: item.receipt.occurredAtMs,
      messageId: `coding_peer_${item.artifactId}`.slice(0, 240),
      artifactId: item.artifactId,
      taskId: item.taskId,
      authorNodeId: row.author.nodeId,
      authorName: row.author.displayName,
      kind: item.kind,
      text: row.body,
      recipients: row.recipients.map((recipient) => recipient.displayName),
      tags: [
        "protocol:agent-turn",
        `turn:${item.kind}`,
        "routing:node",
        ...(item.kind === "response" ? ["thread:reply"] : []),
      ],
    }];
  });
};
