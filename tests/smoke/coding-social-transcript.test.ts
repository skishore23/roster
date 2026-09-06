import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

import {
  NodeRoomUpdateStore,
  type NodeRoomUpdate,
} from "../../src/engine/runtime/node-room-updates.ts";
import {
  reconcileCodingLiveSocialRows,
  projectCodingSocialRows,
  type CodingSocialProjectionInput,
} from "../../src/browser/coding-social-transcript.ts";

const participants = [
  { nodeId: "human", displayName: "Ari", role: "Human", avatarLabel: "AR", human: true },
  { nodeId: "kai", displayName: "Kai", role: "Implementation", avatarLabel: "KA", human: false },
  { nodeId: "mira", displayName: "Mira", role: "Quality", avatarLabel: "MI", human: false },
  { nodeId: "investigator", displayName: "Inez", role: "Investigator", avatarLabel: "IN", human: false },
  { nodeId: "synthesizer", displayName: "Sol", role: "Synthesizer", avatarLabel: "SO", human: false },
  { nodeId: "roster", displayName: "Roster", role: "System", avatarLabel: "RO", human: false },
] as const;

const update = (input: Partial<NodeRoomUpdate> & Pick<NodeRoomUpdate, "updateId" | "taskId" | "nodeId" | "text" | "intent" | "sequence">): NodeRoomUpdate => ({
  schema: "roster.node-room-update.v1",
  runId: "run-social",
  executionId: `execution-${input.taskId}`,
  updateKey: "working",
  recipientNodeIds: [],
  at: "2026-08-26T20:00:00.000Z",
  settled: false,
  ...input,
});

const fixture = (): CodingSocialProjectionInput => ({
  participants,
  messages: [{
    sourceId: "message-human",
    sourceSequence: "1",
    at: "2026-08-26T20:00:01.000Z",
    authorNodeId: "human",
    recipientNodeIds: ["kai"],
    body: "  Please make the room feel like a real conversation.  ",
  }],
  tasks: [
    { taskId: "implement", nodeId: "kai", state: "accepted" },
    { taskId: "review", nodeId: "mira", state: "accepted" },
    { taskId: "repair", nodeId: "kai", state: "pending" },
    { taskId: "missing", nodeId: "kai", state: "accepted" },
    { taskId: "investigate", nodeId: "investigator", state: "accepted" },
    { taskId: "synthesize", nodeId: "synthesizer", state: "accepted" },
    { taskId: "deliver", nodeId: "human", state: "pending" },
  ],
  edges: [
    { taskId: "review", prerequisiteTaskId: "implement" },
    { taskId: "repair", prerequisiteTaskId: "review" },
    { taskId: "synthesize", prerequisiteTaskId: "missing" },
    { taskId: "synthesize", prerequisiteTaskId: "investigate" },
    { taskId: "deliver", prerequisiteTaskId: "synthesize" },
  ],
  acceptedSummaries: [
    {
      artifactId: "artifact-implement",
      outputReference: "output-implement",
      sourceSequence: "2",
      at: "2026-08-26T20:00:02.000Z",
      taskId: "implement",
      authorNodeId: "kai",
      body: "  The stream now reconciles one stable row.\nReady for review.  ",
    },
    {
      artifactId: "artifact-review",
      outputReference: "output-review",
      sourceSequence: "4",
      at: "2026-08-26T20:00:04.000Z",
      taskId: "review",
      authorNodeId: "mira",
      body: "  Please keep questions visible through reconnect.  ",
    },
    {
      artifactId: "artifact-missing",
      outputReference: "output-missing",
      sourceSequence: "5",
      at: "2026-08-26T20:00:05.000Z",
      taskId: "missing",
      authorNodeId: "kai",
    },
    {
      artifactId: "artifact-investigation",
      outputReference: "output-investigation",
      sourceSequence: "6",
      at: "2026-08-26T20:00:06.000Z",
      taskId: "investigate",
      authorNodeId: "investigator",
      body: "  Reordered delivery produces the same projection.  ",
    },
    {
      artifactId: "artifact-final",
      outputReference: "output-final",
      sourceSequence: "7",
      at: "2026-08-26T20:00:07.000Z",
      taskId: "synthesize",
      authorNodeId: "synthesizer",
      body: "  The room is ready.  ",
    },
    {
      artifactId: "artifact-final-duplicate",
      outputReference: "output-final",
      sourceSequence: "8",
      at: "2026-08-26T20:00:08.000Z",
      taskId: "synthesize",
      authorNodeId: "synthesizer",
      body: "  The room is ready.  ",
    },
  ],
  roomUpdates: [update({
    updateId: "update-review-ack",
    taskId: "review",
    nodeId: "mira",
    updateKey: "ack",
    text: "  Got it. I’m reviewing the accepted implementation now.  ",
    intent: "acknowledgement",
    recipientNodeIds: ["kai"],
    sequence: 3,
    at: "2026-08-26T20:00:03.000Z",
  })],
  systemActivities: [],
});

test("projects authored Coding work as stable addressed social rows", () => {
  const input = fixture();
  const rows = projectCodingSocialRows(input);

  assert.deepEqual(
    rows.map((row) => [row.sourceKind, row.author.nodeId, row.recipients.map((recipient) => recipient.nodeId)]),
    [
      ["message", "human", ["kai"]],
      ["accepted-summary", "kai", ["mira"]],
      ["live-update", "mira", ["kai"]],
      ["accepted-summary", "mira", ["kai"]],
      ["system-activity", "roster", ["synthesizer"]],
      ["accepted-summary", "investigator", ["synthesizer"]],
      ["accepted-summary", "synthesizer", ["human"]],
    ],
  );
  assert.equal(rows[0]?.body, "Please make the room feel like a real conversation.");
  assert.equal(rows[1]?.body, "The stream now reconciles one stable row.\nReady for review.");
  assert.equal(rows[2]?.body, "Got it. I’m reviewing the accepted implementation now.");
  assert.equal(rows[3]?.body, "Please keep questions visible through reconnect.");
  assert.equal(rows[5]?.body, "Reordered delivery produces the same projection.");
  assert.equal(rows[6]?.body, "The room is ready.");
  assert.equal(rows.filter((row) => row.body === "The room is ready.").length, 1);
  assert.equal(rows.find((row) => row.sourceKind === "accepted-summary")?.author.nodeId, "kai");
  assert.equal(rows.find((row) => row.intent === "acknowledgement")?.author.nodeId, "mira");
  assert.equal(rows.find((row) => row.sourceKind === "system-activity")?.author.nodeId, "roster");

  const missing = rows[4];
  assert.equal(missing?.author.nodeId, "roster");
  assert.match(missing?.body ?? "", /^Accepted work from Kai was delivered to Sol\.$/);
  assert.doesNotMatch(missing?.body ?? "", /\bI(?:'m|'ve)?\b|[“”"]|\bKai said\b/u);

  const reordered = projectCodingSocialRows({
    ...input,
    participants: [...input.participants].reverse(),
    messages: [...input.messages].reverse(),
    acceptedSummaries: [...input.acceptedSummaries].reverse(),
    tasks: [...input.tasks].reverse(),
    edges: [...input.edges].reverse(),
    systemActivities: [...input.systemActivities].reverse(),
    roomUpdates: [...input.roomUpdates].reverse(),
  });
  assert.deepEqual(
    reordered.map(({ rowId, sourceId }) => [rowId, sourceId]),
    rows.map(({ rowId, sourceId }) => [rowId, sourceId]),
  );
});

test("addresses a durable model-authored task announcement to the human", () => {
  const rows = projectCodingSocialRows({
    participants,
    messages: [],
    tasks: [
      { taskId: "inspect-runtime", nodeId: "kai", state: "accepted" },
      { taskId: "announce-investigate", nodeId: "investigator", state: "accepted" },
      { taskId: "investigate", nodeId: "investigator", state: "running" },
    ],
    edges: [
      { taskId: "announce-investigate", prerequisiteTaskId: "inspect-runtime" },
      { taskId: "investigate", prerequisiteTaskId: "announce-investigate" },
    ],
    acceptedSummaries: [{
      artifactId: "artifact-announce-investigate",
      outputReference: "output-announce-investigate",
      sourceSequence: "1",
      at: "2026-08-26T20:00:01.000Z",
      taskId: "announce-investigate",
      authorNodeId: "investigator",
      body: "I’ll trace the runtime path first, then check how live updates reach the room.",
    }],
    roomUpdates: [],
    systemActivities: [],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.sourceKind, "accepted-summary");
  assert.equal(rows[0]?.author.nodeId, "investigator");
  assert.deepEqual(rows[0]?.recipients.map((recipient) => recipient.nodeId), ["human"]);
  assert.equal(rows[0]?.body, "I’ll trace the runtime path first, then check how live updates reach the room.");
});

test("replaces progress and acknowledgements, retains questions, and lets accepted work supersede settled live rows", () => {
  const base = fixture();
  const rows = projectCodingSocialRows({
    ...base,
    acceptedSummaries: base.acceptedSummaries.filter((summary) => summary.taskId !== "review"),
    roomUpdates: [
      update({ updateId: "progress-one", taskId: "review", nodeId: "mira", text: "First progress.", intent: "progress", recipientNodeIds: ["kai"], sequence: 2, at: "2026-08-26T20:00:02.000Z" }),
      update({ updateId: "progress-two", taskId: "review", nodeId: "mira", text: "Newest progress.", intent: "progress", recipientNodeIds: ["kai"], sequence: 4, at: "2026-08-26T20:00:04.000Z" }),
      update({ updateId: "progress-two", taskId: "review", nodeId: "mira", text: "Stale replacement.", intent: "progress", recipientNodeIds: ["kai"], sequence: 3, at: "2026-08-26T20:00:03.000Z" }),
      update({ updateId: "question-one", taskId: "review", nodeId: "mira", updateKey: "question-one", text: "Should this remain?", intent: "question", recipientNodeIds: ["kai"], sequence: 1, at: "2026-08-26T20:00:01.000Z" }),
      update({ updateId: "question-two", taskId: "review", nodeId: "mira", updateKey: "question-two", text: "And this one?", intent: "question", recipientNodeIds: ["kai"], sequence: 5, at: "2026-08-26T20:00:05.000Z" }),
    ],
  });
  assert.deepEqual(
    rows.filter((row) => row.sourceKind === "live-update").map((row) => row.body),
    ["Should this remain?", "Newest progress.", "And this one?"],
  );

  const settledRows = projectCodingSocialRows({
    ...base,
    roomUpdates: [
      ...base.roomUpdates.map((roomUpdate) => ({ ...roomUpdate, settled: true })),
      update({ updateId: "missing-settled-progress", taskId: "missing", nodeId: "kai", text: "Missing summary fallback settles this.", intent: "progress", recipientNodeIds: ["synthesizer"], sequence: 4, settled: true }),
    ],
  });
  assert.equal(settledRows.some((row) => row.updateId === "update-review-ack"), false);
  assert.equal(settledRows.some((row) => row.updateId === "missing-settled-progress"), false);
});

test("keeps an accepted upstream handoff and adds one neutral attention row for a failed downstream task", () => {
  const base = fixture();
  const rows = projectCodingSocialRows({
    ...base,
    acceptedSummaries: base.acceptedSummaries.filter((summary) => summary.taskId === "implement"),
    tasks: [
      ...base.tasks.map((task) => task.taskId === "review" ? { ...task, state: "failed" as const } : task),
      { taskId: "unselected-upstream", nodeId: "investigator", state: "accepted" as const },
    ],
    edges: [...base.edges, { taskId: "review", prerequisiteTaskId: "unselected-upstream" }],
    roomUpdates: [],
  });

  assert.equal(rows.filter((row) => row.sourceId === "artifact-implement").length, 1);
  const attention = rows.filter((row) => row.state === "attention");
  assert.equal(attention.length, 1);
  assert.deepEqual(attention[0]?.recipients.map((recipient) => recipient.nodeId), ["human", "kai"]);
  assert.equal(attention[0]?.author.nodeId, "roster");
  assert.doesNotMatch(attention[0]?.body ?? "", /Inez/u);
  assert.doesNotMatch(attention[0]?.body ?? "", /\bI(?:'m|'ve)?\b|[“”"]|\bKai said\b/u);
  assert.ok(rows.findIndex((row) => row.sourceId === "artifact-implement") < rows.findIndex((row) => row.state === "attention"));
});

test("clusters only adjacent rows with identical authors and recipients outside handoff boundaries", () => {
  const rows = projectCodingSocialRows({
    participants,
    messages: [
      { sourceId: "m1", sourceSequence: "1", at: "2026-08-26T20:00:01.000Z", authorNodeId: "human", recipientNodeIds: ["kai"], body: "One" },
      { sourceId: "m2", sourceSequence: "2", at: "2026-08-26T20:00:02.000Z", authorNodeId: "human", recipientNodeIds: ["kai"], body: "Two" },
      { sourceId: "m3", sourceSequence: "3", at: "2026-08-26T20:00:03.000Z", authorNodeId: "human", recipientNodeIds: ["mira"], body: "Three" },
    ],
    acceptedSummaries: [],
    tasks: [],
    edges: [],
    systemActivities: [],
    roomUpdates: [],
  });
  assert.deepEqual(rows.map((row) => row.cluster), ["start", "continuation", "start"]);
});

test("incremental live rows cluster against the complete preceding durable chronology", () => {
  const input: CodingSocialProjectionInput = {
    participants,
    messages: [{
      sourceId: "durable-kai",
      sourceSequence: "1",
      at: "2026-08-26T20:00:01.000Z",
      authorNodeId: "kai",
      recipientNodeIds: ["human"],
      body: "I finished the first pass.",
    }],
    acceptedSummaries: [],
    tasks: [{ taskId: "follow-up", nodeId: "kai", state: "running" }],
    edges: [],
    systemActivities: [],
    roomUpdates: [update({
      updateId: "live-kai",
      taskId: "follow-up",
      nodeId: "kai",
      text: "I am checking the follow-up now.",
      intent: "progress",
      recipientNodeIds: ["human"],
      sequence: 1,
      at: "2026-08-26T20:00:02.000Z",
    })],
  };
  const reload = projectCodingSocialRows(input);
  const durable = projectCodingSocialRows({ ...input, roomUpdates: [] });
  const projectedLive = projectCodingSocialRows({ ...input, messages: [] });
  assert.equal(projectedLive.find((row) => row.updateId === "live-kai")?.cluster, "start");

  const incremental = reconcileCodingLiveSocialRows({
    existingLiveRows: [],
    projectedLiveRows: projectedLive,
    durableRows: durable,
  });
  assert.equal(incremental.find((row) => row.updateId === "live-kai")?.cluster, "continuation");
  assert.equal(
    incremental.find((row) => row.updateId === "live-kai")?.cluster,
    reload.find((row) => row.updateId === "live-kai")?.cluster,
  );
});

test("does not let arrival order resolve equal-sequence duplicate sources", () => {
  const base = fixture();
  const conflictingSummary = {
    ...base.acceptedSummaries[0]!,
    body: "A conflicting accepted replay.",
  };
  const conflictingUpdate = {
    ...base.roomUpdates[0]!,
    text: "A conflicting live replay.",
  };
  const left = projectCodingSocialRows({
    ...base,
    acceptedSummaries: [base.acceptedSummaries[0]!, conflictingSummary],
    roomUpdates: [base.roomUpdates[0]!, conflictingUpdate],
  });
  const right = projectCodingSocialRows({
    ...base,
    acceptedSummaries: [conflictingSummary, base.acceptedSummaries[0]!],
    roomUpdates: [conflictingUpdate, base.roomUpdates[0]!],
  });
  assert.deepEqual(
    left.map(({ rowId, body }) => [rowId, body]),
    right.map(({ rowId, body }) => [rowId, body]),
  );
});

test("allows validated human recipients for authored questions and acknowledgements", () => {
  const base = fixture();
  const rows = projectCodingSocialRows({
    ...base,
    acceptedSummaries: [],
    roomUpdates: [
      update({ updateId: "human-question", taskId: "review", nodeId: "mira", text: "Can you confirm?", intent: "question", recipientNodeIds: ["human"], sequence: 1, at: "2026-08-26T20:00:01.000Z" }),
      update({ updateId: "human-ack", taskId: "implement", nodeId: "kai", text: "Thanks, starting now.", intent: "acknowledgement", recipientNodeIds: ["human"], sequence: 2, at: "2026-08-26T20:00:02.000Z" }),
    ],
  });
  assert.deepEqual(
    rows.filter((row) => row.sourceKind === "live-update").map((row) => [row.updateId, row.recipients.map((recipient) => recipient.nodeId)]),
    [["human-question", ["human"]], ["human-ack", ["human"]]],
  );
});

test("accepted rows replace only settled working updates and malformed summaries replace nothing", () => {
  const base = fixture();
  const accepted = projectCodingSocialRows({
    ...base,
    roomUpdates: [
      update({ updateId: "settled-progress", taskId: "review", nodeId: "mira", text: "Done working.", intent: "progress", recipientNodeIds: ["kai"], sequence: 1, settled: true }),
      update({ updateId: "settled-question", taskId: "review", nodeId: "mira", text: "Still need an answer?", intent: "question", recipientNodeIds: ["kai"], sequence: 2, settled: true }),
    ],
  });
  assert.equal(accepted.some((row) => row.updateId === "settled-progress"), false);
  assert.equal(accepted.some((row) => row.updateId === "settled-question"), true);

  const malformed = projectCodingSocialRows({
    ...base,
    acceptedSummaries: [{
      artifactId: "artifact-malformed",
      outputReference: "output-malformed",
      sourceSequence: "not-decimal",
      at: "2026-08-26T20:00:04.000Z",
      taskId: "review",
      authorNodeId: "mira",
      body: "This malformed source must not settle presentation state.",
    }],
    roomUpdates: [update({ updateId: "settled-but-live", taskId: "review", nodeId: "mira", text: "Keep this row.", intent: "progress", recipientNodeIds: ["kai"], sequence: 1, settled: true })],
  });
  assert.equal(malformed.some((row) => row.sourceId === "artifact-malformed"), false);
  assert.equal(malformed.some((row) => row.updateId === "settled-but-live"), true);
});

test("reconciles stable replay rows once and fails closed on conflicting artifact references", () => {
  const base = fixture();
  const implement = base.acceptedSummaries[0]!;
  const rows = projectCodingSocialRows({
    ...base,
    messages: [base.messages[0]!, base.messages[0]!],
    acceptedSummaries: [
      implement,
      { ...implement, outputReference: "conflicting-output-reference" },
      base.acceptedSummaries[1]!,
    ],
    systemActivities: [{
      sourceId: "fallback-review-handoff",
      sourceSequence: "4",
      at: "2026-08-26T20:00:04.000Z",
      taskId: "review",
      recipientNodeIds: ["kai"],
      kind: "handoff",
    }],
    roomUpdates: [],
  });
  assert.equal(rows.filter((row) => row.sourceId === "message-human").length, 1);
  assert.equal(rows.some((row) => row.sourceId === "artifact-implement"), false);
  assert.equal(rows.filter((row) => row.taskId === "review" && row.sourceKind === "accepted-summary").length, 1);
  assert.equal(rows.some((row) => row.sourceId === "fallback-review-handoff"), false);
  assert.equal(new Set(rows.map((row) => row.rowId)).size, rows.length);

  const reversed = projectCodingSocialRows({
    ...base,
    acceptedSummaries: [
      { ...implement, outputReference: "conflicting-output-reference" },
      implement,
    ],
    roomUpdates: [],
  });
  assert.equal(reversed.some((row) => row.sourceId === "artifact-implement"), false);
});

test("malformed same-artifact references cannot poison a structurally valid accepted summary", () => {
  const base = fixture();
  const valid = base.acceptedSummaries[0]!;
  const rows = projectCodingSocialRows({
    ...base,
    acceptedSummaries: [
      valid,
      {
        ...valid,
        outputReference: "malformed-conflicting-reference",
        sourceSequence: "not-decimal",
        taskId: "unknown-task",
        authorNodeId: "unknown-node",
      },
    ],
    roomUpdates: [],
  });
  assert.equal(rows.filter((row) => row.sourceId === valid.artifactId).length, 1);
  assert.equal(rows.find((row) => row.sourceId === valid.artifactId)?.sourceKind, "accepted-summary");
});

test("derives failed-task attention only from selected accepted upstream contributions", () => {
  const base = fixture();
  const failedTasks = base.tasks.map((task) => task.taskId === "review" ? { ...task, state: "failed" as const } : task);
  const withoutSummary = projectCodingSocialRows({
    ...base,
    tasks: failedTasks,
    acceptedSummaries: [],
    roomUpdates: [],
    systemActivities: [{ sourceId: "unproven-attention", sourceSequence: "3", at: "2026-08-26T20:00:03.000Z", taskId: "review", recipientNodeIds: ["human", "kai"], kind: "attention" }],
  });
  assert.equal(withoutSummary.some((row) => row.state === "attention"), false);

  const pendingUpstream = projectCodingSocialRows({
    ...base,
    tasks: failedTasks.map((task) => task.taskId === "implement" ? { ...task, state: "running" as const } : task),
    acceptedSummaries: [base.acceptedSummaries[0]!],
    roomUpdates: [],
  });
  assert.equal(pendingUpstream.some((row) => row.state === "attention"), false);
});

test("selects a failed task's latest accepted upstream frontier independent of delivery order", () => {
  const base = fixture();
  const early = base.acceptedSummaries[0]!;
  const late = { ...early, artifactId: "artifact-implement-late", outputReference: "output-implement-late", sourceSequence: "10", at: "2026-08-26T20:00:10.000Z", body: "Latest accepted implementation." };
  const project = (acceptedSummaries: CodingSocialProjectionInput["acceptedSummaries"]) => projectCodingSocialRows({
    ...base,
    messages: [{ ...base.messages[0]!, sourceSequence: "5", at: "2026-08-26T20:00:05.000Z" }],
    tasks: base.tasks.map((task) => task.taskId === "review" ? { ...task, state: "failed" as const } : task),
    acceptedSummaries,
    roomUpdates: [],
  });
  const left = project([early, late]);
  const right = project([late, early]);
  assert.deepEqual(left.map((row) => row.sourceId), right.map((row) => row.sourceId));
  assert.ok(left.findIndex((row) => row.sourceId === "artifact-implement-late") < left.findIndex((row) => row.state === "attention"));
});

test("anchors process-local update chronology without comparing it to durable source sequences", () => {
  const store = new NodeRoomUpdateStore({ now: () => "2026-08-26T20:00:02.000Z" });
  const live = store.post({ runId: "run-social", taskId: "review", executionId: "execution-review", nodeId: "mira" }, {
    updateKey: "ack",
    text: "This real sequence-one acknowledgement came after the durable message.",
    intent: "acknowledgement",
    recipientNodeIds: ["human"],
  });
  assert.equal(live.sequence, 1);
  const rows = projectCodingSocialRows({
    participants,
    messages: [{ sourceId: "durable-100", sourceSequence: "100", at: "2026-08-26T20:00:01.000Z", authorNodeId: "human", recipientNodeIds: ["mira"], body: "Earlier durable message." }],
    acceptedSummaries: [],
    tasks: [{ taskId: "review", nodeId: "mira", state: "running" }],
    edges: [],
    systemActivities: [],
    roomUpdates: [live],
  });
  assert.deepEqual(rows.map((row) => row.sourceId), ["durable-100", live.updateId]);
});

test("rejects ambiguous identities, unknown tasks, and recipient overflow without arrival-order dependence", () => {
  const base = fixture();
  const unauthorized = projectCodingSocialRows({
    ...base,
    roomUpdates: [update({
      updateId: "unauthorized-live",
      taskId: "review",
      nodeId: "mira",
      text: "This entire record must be rejected.",
      intent: "question",
      recipientNodeIds: ["kai", "unrelated"],
      sequence: 9,
    })],
  });
  assert.equal(unauthorized.some((row) => row.updateId === "unauthorized-live"), false);
  const ambiguousParticipants = [
    ...base.participants,
    { nodeId: "kai", displayName: "Other Kai", role: "Unknown", avatarLabel: "OK", human: false },
  ];
  const ambiguousTasks = [
    ...base.tasks,
    { taskId: "implement", nodeId: "mira", state: "accepted" as const },
  ];
  const unknownSummary = { ...base.acceptedSummaries[0]!, artifactId: "artifact-unknown", outputReference: "output-unknown", taskId: "unknown-task" };
  for (const input of [
    { ...base, participants: ambiguousParticipants },
    { ...base, participants: [...ambiguousParticipants].reverse() },
    { ...base, tasks: ambiguousTasks },
    { ...base, tasks: [...ambiguousTasks].reverse() },
  ]) {
    const rows = projectCodingSocialRows({ ...input, acceptedSummaries: [base.acceptedSummaries[0]!, unknownSummary], roomUpdates: [] });
    assert.equal(rows.some((row) => row.sourceId === "artifact-implement"), false);
    assert.equal(rows.some((row) => row.sourceId === "artifact-unknown"), false);
  }

  const overflowParticipants = Array.from({ length: 7 }, (_, index) => ({
    nodeId: `recipient-${index}`,
    displayName: `Recipient ${index}`,
    role: "Reviewer",
    avatarLabel: `R${index}`,
    human: false,
  }));
  const overflowTasks = overflowParticipants.map((participant, index) => ({
    taskId: `review-${index}`,
    nodeId: participant.nodeId,
    state: "pending" as const,
  }));
  const overflow = projectCodingSocialRows({
    participants: [participants[1]!, ...overflowParticipants],
    messages: [{ sourceId: "overflow-message", sourceSequence: "1", at: "2026-08-26T20:00:01.000Z", authorNodeId: "kai", recipientNodeIds: overflowParticipants.map((participant) => participant.nodeId), body: "Too many recipients." }],
    acceptedSummaries: [{ artifactId: "overflow-summary", outputReference: "overflow-output", sourceSequence: "2", at: "2026-08-26T20:00:02.000Z", taskId: "implement", authorNodeId: "kai", body: "Too much fanout." }],
    tasks: [{ taskId: "implement", nodeId: "kai", state: "accepted" }, ...overflowTasks],
    edges: overflowTasks.map((task) => ({ taskId: task.taskId, prerequisiteTaskId: "implement" })),
    systemActivities: [{ sourceId: "overflow-system", sourceSequence: "3", at: "2026-08-26T20:00:03.000Z", taskId: "implement", recipientNodeIds: overflowParticipants.map((participant) => participant.nodeId), kind: "handoff" }],
    roomUpdates: [update({ updateId: "overflow-live", taskId: "implement", nodeId: "kai", text: "Too many live recipients.", intent: "question", recipientNodeIds: overflowParticipants.map((participant) => participant.nodeId), sequence: 1 })],
  });
  assert.deepEqual(overflow, []);
});

test("canonical byte-identical participant and task replays preserve the valid projection", () => {
  const base = fixture();
  const kai = base.participants.find((participant) => participant.nodeId === "kai")!;
  const implement = base.tasks.find((task) => task.taskId === "implement")!;
  const rows = projectCodingSocialRows({
    ...base,
    participants: [...base.participants, { ...kai }],
    tasks: [...base.tasks, { ...implement }],
    acceptedSummaries: [base.acceptedSummaries[0]!],
    roomUpdates: [],
  });
  assert.equal(rows.filter((row) => row.sourceId === "artifact-implement").length, 1);
  assert.equal(rows.find((row) => row.sourceId === "artifact-implement")?.author.nodeId, "kai");

  const reordered = projectCodingSocialRows({
    ...base,
    participants: [{ ...kai }, ...base.participants].reverse(),
    tasks: [{ ...implement }, ...base.tasks].reverse(),
    acceptedSummaries: [base.acceptedSummaries[0]!],
    roomUpdates: [],
  });
  assert.deepEqual(reordered.map((row) => [row.rowId, row.sourceId]), rows.map((row) => [row.rowId, row.sourceId]));
});

test("browser bundle erases the NodeRoomUpdate type dependency", async () => {
  const result = await build({
    entryPoints: [new URL("../../src/browser/coding-social-transcript.ts", import.meta.url).pathname],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs).sort();
  assert.ok(inputs.some((input) => input.endsWith("src/browser/coding-social-transcript.ts")));
  assert.ok(inputs.some((input) => input.endsWith("src/core/canonical.ts")));
  assert.equal(inputs.some((input) => input.includes("node-room-updates") || input.includes("engine/runtime")), false);
});
