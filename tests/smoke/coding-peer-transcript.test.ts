import assert from "node:assert/strict";
import test from "node:test";

import { projectCodingPeerTranscript } from "../../src/browser/coding-peer-transcript.ts";

const artifactReceipt = (input: {
  readonly id: string;
  readonly seq: bigint;
  readonly outputKey: string;
  readonly artifactId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly occurredAtMs?: bigint;
}) => ({
  id: input.id,
  streamId: "agents/coding-agent/runs/run-peer-chat",
  seq: input.seq,
  occurredAtMs: input.occurredAtMs ?? input.seq * 100n,
  bodyJson: JSON.stringify({
    type: "artifact.published",
    runId: "run-peer-chat",
    artifactId: input.artifactId,
    origin: "task",
    outputKey: input.outputKey,
    taskId: input.taskId,
    nodeId: input.nodeId,
    payload: { storage: "inline", value: JSON.stringify(input.value) },
  }),
});

test("accepted Coding peer artifacts project as an addressed live conversation", () => {
  const messages = projectCodingPeerTranscript({
    runId: "run-peer-chat",
    nodes: [
      { runId: "run-peer-chat", nodeId: "workspace.implementation", name: "Kai, Implementation Engineer" },
      { runId: "run-peer-chat", nodeId: "workspace.quality", name: "Mira, Quality Reviewer" },
      { runId: "run-peer-chat", nodeId: "workspace.api", name: "Theo, API Architect" },
    ],
    tasks: [
      { id: "run-peer-chat:propose-kai", runId: "run-peer-chat", taskId: "propose-kai", nodeId: "workspace.implementation" },
      { id: "run-peer-chat:respond-mira", runId: "run-peer-chat", taskId: "respond-mira", nodeId: "workspace.quality" },
      { id: "run-peer-chat:implement", runId: "run-peer-chat", taskId: "implement", nodeId: "workspace.implementation" },
      { id: "run-peer-chat:resolve", runId: "run-peer-chat", taskId: "resolve-collaboration", nodeId: "workspace.api" },
    ],
    edges: [
      { runId: "run-peer-chat", taskKey: "run-peer-chat:respond-mira", prerequisiteTaskKey: "run-peer-chat:propose-kai" },
      { runId: "run-peer-chat", taskKey: "run-peer-chat:resolve", prerequisiteTaskKey: "run-peer-chat:respond-mira" },
      { runId: "run-peer-chat", taskKey: "run-peer-chat:implement", prerequisiteTaskKey: "run-peer-chat:resolve" },
    ],
    receipts: [
      artifactReceipt({
        id: "receipt-proposal",
        seq: 1n,
        outputKey: "collaboration_proposal_implementation",
        artifactId: "artifact-proposal",
        taskId: "propose-kai",
        nodeId: "workspace.implementation",
        value: { status: "proposal", summary: "Keep the change inside the existing room boundary." },
      }),
      artifactReceipt({
        id: "receipt-response",
        seq: 2n,
        outputKey: "collaboration_response_quality",
        artifactId: "artifact-response",
        taskId: "respond-mira",
        nodeId: "workspace.quality",
        value: { status: "response", summary: "Agreed; add a replay test for the handoff." },
      }),
      artifactReceipt({
        id: "receipt-resolution",
        seq: 3n,
        outputKey: "collaboration_resolution",
        artifactId: "artifact-resolution",
        taskId: "resolve-collaboration",
        nodeId: "workspace.api",
        value: { status: "resolved", summary: "Use the room boundary with replay coverage." },
      }),
    ],
  });

  assert.deepEqual(messages.map((message) => ({
    author: message.authorName,
    kind: message.kind,
    recipients: message.recipients,
    text: message.text,
  })), [
    {
      author: "Kai",
      kind: "proposal",
      recipients: ["Mira"],
      text: "Keep the change inside the existing room boundary.",
    },
    {
      author: "Mira",
      kind: "response",
      recipients: ["Theo"],
      text: "Agreed; add a replay test for the handoff.",
    },
    {
      author: "Theo",
      kind: "resolution",
      recipients: ["Kai"],
      text: "Use the room boundary with replay coverage.",
    },
  ]);
  assert.ok(messages.every((message) => message.tags.includes("protocol:agent-turn")));
  assert.ok(messages[1]?.tags.includes("thread:reply"));
});

test("peer transcript delegates content identity, ordering, and output deduplication to the social projector", () => {
  const receipt = artifactReceipt({
    id: "receipt-original",
    seq: 2n,
    outputKey: "collaboration_proposal_implementation",
    artifactId: "artifact-stable",
    taskId: "propose-kai",
    nodeId: "workspace.implementation",
    value: { status: "proposal", summary: "  Keep this exact\nsummary shape.  " },
  });
  const common = {
    runId: "run-peer-chat",
    nodes: [
      { runId: "run-peer-chat", nodeId: "workspace.implementation", name: "Kai, Implementation Engineer" },
      { runId: "run-peer-chat", nodeId: "workspace.quality", name: "Mira, Quality Reviewer" },
    ],
    tasks: [
      { id: "run-peer-chat:propose-kai", runId: "run-peer-chat", taskId: "propose-kai", nodeId: "workspace.implementation" },
      { id: "run-peer-chat:respond-mira", runId: "run-peer-chat", taskId: "respond-mira", nodeId: "workspace.quality" },
    ],
    edges: [
      { runId: "run-peer-chat", taskKey: "run-peer-chat:respond-mira", prerequisiteTaskKey: "run-peer-chat:propose-kai" },
    ],
  } as const;
  const first = projectCodingPeerTranscript({ ...common, receipts: [receipt, { ...receipt, id: "receipt-duplicate", seq: 3n }] });
  const replayed = projectCodingPeerTranscript({ ...common, receipts: [{ ...receipt, id: "receipt-replayed" }] });

  assert.equal(first.length, 1);
  assert.equal(first[0]?.text, "Keep this exact\nsummary shape.");
  assert.equal(first[0]?.rowId, replayed[0]?.rowId);
});

test("peer transcript ignores non-task, malformed, and unrelated artifacts", () => {
  const messages = projectCodingPeerTranscript({
    runId: "run-peer-chat",
    nodes: [],
    tasks: [],
    edges: [],
    receipts: [{
      ...artifactReceipt({
        id: "receipt-unrelated",
        seq: 1n,
        outputKey: "implementation_report",
        artifactId: "artifact-unrelated",
        taskId: "implement",
        nodeId: "workspace.implementation",
        value: { status: "verified", summary: "Not a peer turn." },
      }),
      streamId: "agents/coding-agent/runs/another-run",
    }],
  });
  assert.deepEqual(messages, []);
});

test("peer transcript selects one complete canonical contribution for equal-sequence duplicates", () => {
  const common = {
    runId: "run-peer-chat",
    nodes: [
      { runId: "run-peer-chat", nodeId: "workspace.implementation", name: "Kai, Implementation Engineer" },
      { runId: "run-peer-chat", nodeId: "workspace.quality", name: "Mira, Quality Reviewer" },
    ],
    tasks: [
      { id: "run-peer-chat:propose-kai", runId: "run-peer-chat", taskId: "propose-kai", nodeId: "workspace.implementation" },
      { id: "run-peer-chat:respond-mira", runId: "run-peer-chat", taskId: "respond-mira", nodeId: "workspace.quality" },
    ],
    edges: [{ runId: "run-peer-chat", taskKey: "run-peer-chat:respond-mira", prerequisiteTaskKey: "run-peer-chat:propose-kai" }],
  } as const;
  const proposal = artifactReceipt({
    id: "receipt-b",
    seq: 7n,
    outputKey: "collaboration_proposal_implementation",
    artifactId: "artifact-equal",
    taskId: "propose-kai",
    nodeId: "workspace.implementation",
    value: { status: "proposal", summary: "Proposal body." },
  });
  const endorsement = artifactReceipt({
    id: "receipt-a",
    seq: 7n,
    outputKey: "collaboration_endorsement_quality",
    artifactId: "artifact-equal",
    taskId: "propose-kai",
    nodeId: "workspace.implementation",
    value: { verdict: "approve", summary: "Endorsement body." },
  });
  const left = projectCodingPeerTranscript({ ...common, receipts: [proposal, endorsement] });
  const right = projectCodingPeerTranscript({ ...common, receipts: [endorsement, proposal] });
  assert.deepEqual(left, right);
  assert.equal(left.length, 1);
  const selected = left[0]!;
  assert.equal(selected.tags.includes(`turn:${selected.kind}`), true);
  assert.equal(selected.kind === "response", selected.tags.includes("thread:reply"));
  assert.equal(
    (selected.kind === "proposal" && selected.text === "Proposal body.")
      || (selected.kind === "endorsement" && selected.text === "Endorsement body."),
    true,
  );
});

test("peer transcript excludes unsafe or out-of-range bigint timestamps", () => {
  const common = {
    runId: "run-peer-chat",
    nodes: [{ runId: "run-peer-chat", nodeId: "workspace.implementation", name: "Kai, Implementation Engineer" }],
    tasks: [{ id: "run-peer-chat:propose-kai", runId: "run-peer-chat", taskId: "propose-kai", nodeId: "workspace.implementation" }],
    edges: [],
  } as const;
  const receipt = artifactReceipt({
    id: "receipt-time",
    seq: 1n,
    outputKey: "collaboration_proposal_implementation",
    artifactId: "artifact-time",
    taskId: "propose-kai",
    nodeId: "workspace.implementation",
    value: { status: "proposal", summary: "Unsafe time." },
  });
  assert.deepEqual(projectCodingPeerTranscript({ ...common, receipts: [{ ...receipt, occurredAtMs: -1n }] }), []);
  assert.deepEqual(projectCodingPeerTranscript({ ...common, receipts: [{ ...receipt, occurredAtMs: 8_640_000_000_000_001n }] }), []);
});

test("peer task-key suffix fallback fails closed when overlapping task IDs are ambiguous", () => {
  const proposal = artifactReceipt({
    id: "receipt-overlap",
    seq: 1n,
    outputKey: "collaboration_proposal_implementation",
    artifactId: "artifact-overlap",
    taskId: "proposal",
    nodeId: "workspace.implementation",
    value: { status: "proposal", summary: "Do not route through an ambiguous suffix." },
  });
  const source = { id: "run-peer-chat:proposal", runId: "run-peer-chat", taskId: "proposal", nodeId: "workspace.implementation" };
  const short = { id: "task-short", runId: "run-peer-chat", taskId: "a", nodeId: "workspace.quality" };
  const long = { id: "task-long", runId: "run-peer-chat", taskId: "b:a", nodeId: "workspace.api" };
  const common = {
    runId: "run-peer-chat",
    nodes: [
      { runId: "run-peer-chat", nodeId: "workspace.implementation", name: "Kai, Implementation Engineer" },
      { runId: "run-peer-chat", nodeId: "workspace.quality", name: "Mira, Quality Reviewer" },
      { runId: "run-peer-chat", nodeId: "workspace.api", name: "Theo, API Architect" },
    ],
    edges: [{ runId: "run-peer-chat", taskKey: "prefix:b:a", prerequisiteTaskKey: source.id }],
    receipts: [proposal],
  } as const;
  const left = projectCodingPeerTranscript({ ...common, tasks: [source, short, long] });
  const right = projectCodingPeerTranscript({ ...common, tasks: [long, short, source] });
  assert.deepEqual(left, right);
  assert.equal(left.length, 1);
  assert.deepEqual(left[0]?.recipients, []);
});
