import assert from "node:assert/strict";
import test from "node:test";

import {
  codingDeliveryDispositionEvent,
  codingDeliveryDispositionFromEvents,
  codingRoomGitFrontierEvent,
  codingRoomGitFrontierFromEvents,
  codingRoomProjection,
  codingRoomReactionEvent,
  codingRoomReactionsFromEvents,
  createCodingDeliveryDisposition,
  createCodingRoomGitFrontier,
  createCodingRoomReaction,
} from "../../src/domains/coding-room.ts";
import type { WorkspaceNode } from "../../src/engine/orchestration/types.ts";
import { workspaceNodeSocialParticipant } from "../../src/engine/workspace/node.ts";
import {
  initialOrchestrationState,
  reduceOrchestration,
} from "../../src/modules/orchestration.ts";

const nodes: ReadonlyArray<WorkspaceNode> = [
  {
    id: "human.operator",
    name: "You, Workspace Participant",
    capabilities: ["decide"],
    metadata: { participantKind: "human", givenName: "You", displayRole: "Workspace Participant", persistent: true },
  },
  {
    id: "coordinator",
    name: "Roster, Collaboration Facilitator",
    capabilities: ["coordinate"],
    metadata: { role: "facilitator", givenName: "Roster", displayRole: "Collaboration Facilitator", persistent: true },
  },
  {
    id: "workspace.implementation",
    name: "Kai, Implementation Engineer",
    capabilities: ["implement"],
    runtime: { kind: "codex-cli", metadata: { model: "gpt-5.6-sol" } },
    metadata: { role: "worker", givenName: "Kai", displayRole: "Implementation Engineer", persistent: true },
  },
];

test("social participant identity survives runtime replacement", () => {
  const original = workspaceNodeSocialParticipant(nodes[2]!);
  const rebound = workspaceNodeSocialParticipant({
    ...nodes[2]!,
    runtime: { kind: "pi-agent", metadata: { model: "openai-codex/gpt-5.6-luna", sessionId: "replacement" } },
  });

  assert.deepEqual(rebound, original);
  assert.equal(original.nodeId, "workspace.implementation");
  assert.equal(original.handle, "@kai");
  assert.equal(original.role, "Implementation Engineer");
});

test("one durable room keeps the same branch identity across execution delivery", () => {
  const open = codingRoomProjection({
    conversationId: "conversation-42",
    repositoryName: "theorem",
    job: {
      id: "job-1",
      status: "running",
      branch: "roster/coding-conversation-42",
      objective: "Make collaboration feel like a room.",
    },
    nodes,
    tasks: [{ nodeId: "workspace.implementation", status: "running" }],
  });
  const archived = codingRoomProjection({
    conversationId: "conversation-42",
    repositoryName: "theorem",
    job: {
      id: "job-1",
      status: "completed",
      branch: "roster/coding-conversation-42",
      commit: "a".repeat(40),
      integration: { integrated: true, canIntegrate: false },
    },
    nodes,
  });
  const repository = codingRoomProjection({
    conversationId: "conversation-42",
    repositoryName: "theorem",
    nodes,
  });

  assert.equal(open.kind, "branch");
  assert.equal(open.title, "#coding-conversation-42");
  assert.equal(open.state, "open");
  assert.equal(open.roomId, repository.roomId);
  assert.equal(archived.roomId, open.roomId);
  assert.equal(archived.state, "open");
  assert.equal(repository.kind, "repository");
  assert.equal(repository.state, "open");
  assert.equal(open.participants.find((participant) => participant.nodeId === "workspace.implementation")?.presence, "working");
  assert.equal(open.participants.find((participant) => participant.nodeId === "human.operator")?.presence, "present");
  assert.equal(open.participants.some((participant) => participant.nodeId === "coordinator"), false);
  assert.deepEqual(open.participants.map((participant) => participant.kind), ["human", "agent"]);
});

test("room Git frontiers replay as one ordered certified branch history", () => {
  const initial = createCodingRoomGitFrontier({
    conversationId: "conversation-frontier",
    roomId: "room_repository_conversation-frontier",
    branch: "roster/rooms/room_repository_conversation-frontier",
    commit: "a".repeat(40),
    epoch: 0,
    targetBranch: "main",
    targetCommit: "a".repeat(40),
  });
  const advanced = createCodingRoomGitFrontier({
    conversationId: initial.conversationId,
    roomId: initial.roomId,
    branch: initial.branch,
    commit: "b".repeat(40),
    epoch: 1,
    previousCommit: initial.commit,
    targetBranch: initial.targetBranch,
    targetCommit: initial.targetCommit,
    executionRunId: "execution-frontier",
  });
  assert.deepEqual(codingRoomGitFrontierFromEvents([
    codingRoomGitFrontierEvent(initial),
    codingRoomGitFrontierEvent(advanced),
  ]), advanced);
  const initialEvent = codingRoomGitFrontierEvent(initial);
  assert.equal(initialEvent.origin, "input");
  assert.equal(initialEvent.taskId, undefined);
  assert.doesNotThrow(() => reduceOrchestration(initialOrchestrationState, initialEvent, 1));

  const competing = createCodingRoomGitFrontier({
    ...advanced,
    commit: "c".repeat(40),
  });
  assert.throws(() => codingRoomGitFrontierFromEvents([
    codingRoomGitFrontierEvent(initial),
    codingRoomGitFrontierEvent(advanced),
    codingRoomGitFrontierEvent(competing),
  ]), /chain diverged/);
});

test("an explicit close keeps the certified branch while archiving its room", () => {
  const disposition = createCodingDeliveryDisposition({
    conversationId: "conversation-kept",
    executionRunId: "execution-kept",
    jobId: "job-kept",
    branch: "roster/execution-kept",
    commit: "b".repeat(40),
  });
  const event = codingDeliveryDispositionEvent(disposition);
  const room = codingRoomProjection({
    conversationId: disposition.conversationId,
    job: {
      id: disposition.jobId,
      status: "completed",
      branch: disposition.branch,
      commit: disposition.commit,
      integration: { integrated: false, canIntegrate: false, reason: "Working tree is dirty." },
      deliveryDisposition: disposition,
    },
    nodes,
  });

  assert.deepEqual(codingDeliveryDispositionFromEvents([event]), disposition);
  assert.equal(room.state, "archived");
  assert.equal(room.stateLabel, "Closed · branch kept");
});

test("human questions keep the room open while exposing a waiting state", () => {
  const room = codingRoomProjection({
    conversationId: "conversation-waiting",
    repositoryName: "theorem",
    job: { id: "job-waiting", status: "running", branch: "roster/waiting" },
    nodes,
    waitingForHuman: true,
  });

  assert.equal(room.state, "waiting");
  assert.equal(room.stateLabel, "Waiting for you");
});

test("room reactions are durable, replayable, and content-idempotent", () => {
  const first = createCodingRoomReaction({
    conversationId: "conversation-react",
    messageId: "coding_message_target",
    authorId: "human.operator",
    emoji: "❤️",
    createdAt: 20,
  });
  const duplicate = createCodingRoomReaction({
    conversationId: "conversation-react",
    messageId: "coding_message_target",
    authorId: "human.operator",
    emoji: "❤️",
    createdAt: 30,
  });
  const replayed = codingRoomReactionsFromEvents([codingRoomReactionEvent(first)]);

  assert.equal(duplicate.reactionId, first.reactionId);
  assert.deepEqual(replayed, [first]);
  assert.equal(codingRoomReactionEvent(first).inputVersions.message, "coding_message_target");
});
