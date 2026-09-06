import assert from "node:assert/strict";
import test from "node:test";

import type { TranscriptTrajectorySource } from "@letta-ai/trajectory";

import {
  createNodeExecutionSurface,
  NODE_EXECUTION_SCHEMA_VERSION,
  type NodeExecutionEnvelope,
} from "../../src/engine/runtime/node-runtime.ts";
import {
  NODE_EXECUTION_TRAJECTORY_SCHEMA_VERSION,
  normalizeNodeExecutionTrajectory,
} from "../../src/engine/runtime/node-trajectory.ts";
import type { WorkspaceNodeRuntimeKind } from "../../src/engine/orchestration/types.ts";

const sourceGroupId = "session-trajectory-1";

const runtimeForSource: Record<TranscriptTrajectorySource, WorkspaceNodeRuntimeKind> = {
  "claude-code": "claude-code",
  codex: "codex-cli",
  hermes: "hermes-agent",
  "letta-code": "custom",
  openclaw: "custom",
  openhands: "custom",
  pi: "pi-agent",
};

const envelope = (source: TranscriptTrajectorySource): NodeExecutionEnvelope => ({
  schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
  executionId: "node_execution_1234567890abcdef1234567890ab",
  runId: "trajectory-run",
  node: {
    id: "researcher",
    name: "Researcher",
    capabilities: ["research"],
  },
  runtime: { kind: runtimeForSource[source] },
  task: {
    taskId: "research",
    nodeId: "researcher",
    capability: "research",
  },
  surface: createNodeExecutionSurface({}),
});

const transcripts: Record<Extract<
  TranscriptTrajectorySource,
  "codex" | "claude-code" | "pi" | "hermes"
>, string> = {
  codex: [
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: sourceGroupId, cwd: "/workspace", timestamp: "2026-07-24T12:00:00.000Z" },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect." }] },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:02.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
    }),
  ].join("\n"),
  "claude-code": [
    JSON.stringify({
      type: "user",
      uuid: "user-1",
      sessionId: sourceGroupId,
      cwd: "/workspace",
      timestamp: "2026-07-24T12:00:00.000Z",
      message: { role: "user", content: "Inspect." },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "assistant-1",
      sessionId: sourceGroupId,
      timestamp: "2026-07-24T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude",
        content: [{ type: "text", text: "Done." }],
      },
    }),
  ].join("\n"),
  pi: [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sourceGroupId,
      timestamp: "2026-07-24T12:00:00.000Z",
      cwd: "/workspace",
    }),
    JSON.stringify({
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-07-24T12:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "Inspect." }] },
    }),
    JSON.stringify({
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-07-24T12:00:02.000Z",
      message: {
        role: "assistant",
        model: "model",
        content: [{ type: "text", text: "Done." }],
      },
    }),
  ].join("\n"),
  hermes: JSON.stringify({
    session: {
      id: sourceGroupId,
      model: "model",
      cwd: "/workspace",
      started_at: 1_774_353_600,
    },
    messages: [
      {
        id: 1,
        session_id: sourceGroupId,
        role: "user",
        content: "Inspect.",
        timestamp: 1_774_353_601,
      },
      {
        id: 2,
        session_id: sourceGroupId,
        role: "assistant",
        content: "Done.",
        timestamp: 1_774_353_602,
      },
    ],
  }),
};

for (const source of ["codex", "claude-code", "pi", "hermes"] as const) {
  test(`normalizes ${source} native sessions into one Roster trajectory contract`, () => {
    const trajectory = normalizeNodeExecutionTrajectory({
      envelope: envelope(source),
      source,
      sourceGroupId,
      transcript: transcripts[source],
    });
    const repeated = normalizeNodeExecutionTrajectory({
      envelope: envelope(source),
      source,
      sourceGroupId,
      transcript: transcripts[source],
    });

    assert.equal(trajectory.schemaVersion, NODE_EXECUTION_TRAJECTORY_SCHEMA_VERSION);
    assert.equal(trajectory.source, source);
    assert.equal(trajectory.sourceGroupId, sourceGroupId);
    assert.equal(trajectory.nodeId, "researcher");
    assert.equal(trajectory.taskId, "research");
    assert.match(trajectory.contentHash, /^[0-9a-f]{64}$/u);
    assert.equal(trajectory.contentHash, repeated.contentHash);
    assert.ok(trajectory.records.some((record) => record.record_type === "user"));
    assert.ok(trajectory.records.some((record) => record.record_type === "assistant"));
  });
}

test("trajectory normalization enforces Roster transcript and record bounds", () => {
  assert.throws(() => normalizeNodeExecutionTrajectory({
    envelope: envelope("codex"),
    source: "codex",
    sourceGroupId,
    transcript: transcripts.codex,
    limits: { maxTranscriptBytes: 8 },
  }), /maxTranscriptBytes=8/u);

  assert.throws(() => normalizeNodeExecutionTrajectory({
    envelope: envelope("codex"),
    source: "codex",
    sourceGroupId,
    transcript: transcripts.codex,
    limits: { maxRecords: 1 },
  }), /maxRecords=1/u);
});
