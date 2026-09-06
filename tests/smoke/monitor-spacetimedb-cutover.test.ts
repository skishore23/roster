import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  projectMonitorCanvasRuns,
  projectMonitorJobs,
  renderMonitorFleet,
  renderMonitorReplay,
  type MonitorJobCommandRow,
  type MonitorJobRow,
  type MonitorReceiptRow,
} from "../../src/browser/monitor-renderers.ts";
import { monitorShell } from "../../src/views/monitor.ts";

const jobRow: MonitorJobRow = {
  id: "job_demo",
  workspaceId: "roster/default",
  agentId: "writer",
  lane: "collect",
  sessionKey: "writer:agents/writer",
  singletonMode: "cancel",
  payloadJson: JSON.stringify({
    kind: "writer.run",
    stream: "agents/writer",
    runId: "run_demo",
    problem: "Draft a launch memo",
  }),
  status: "running",
  attempt: 1,
  maxAttempts: 2,
  leaseWorker: "writer-1",
  leaseFence: 1n,
  lastError: "",
  resultJson: "",
  canceledReason: "",
  abortRequested: false,
  createdAt: 1_000,
  updatedAt: 3_000,
};

const commandRow: MonitorJobCommandRow = {
  id: "cmd_demo",
  workspaceId: "roster/default",
  jobId: "job_demo",
  command: "steer",
  lane: "steer",
  payloadJson: JSON.stringify({ problem: "Focus on evidence" }),
  by: "operator",
  createdAt: 2_500,
};

const event = (seq: bigint, occurredAtMs: bigint, body: Record<string, unknown>): MonitorReceiptRow => ({
  id: `event_${seq}`,
  workspaceId: "roster/default",
  streamId: "jobs/job_demo",
  seq,
  receiptId: `event_${seq}`,
  occurredAtMs,
  bodyJson: JSON.stringify(body),
});

test("monitor shell uses unified replay and a direct SpacetimeDB boot only", () => {
  const html = monitorShell({
    stream: "agents/writer",
    selectedJobId: "job_demo",
    nonce: "nonce-demo",
    improvementAudit: {
      generationId: "runtime_generation_1234567890abcdef1234567890ab",
      activeCount: 1,
      proposals: [{
        id: "proposal-auto",
        status: "promoted",
        artifactType: "prompt_patch",
        target: "coding.prompt",
        source: "Coding run run-1 · node node-author",
        transitionCount: 5,
        observationCount: 2,
        updatedAt: 3_000,
      }],
    },
    realtime: {
      workspaceId: "roster/default",
      queueStream: "jobs",
      activityStream: "agents/writer",
      selectedJobId: "job_demo",
      memoryScope: "agent",
      capabilitySecret: "short-lived-secret",
      realtime: {
        enabled: true,
        uri: "http://127.0.0.1:3000",
        database: "roster-local",
        confirmedReads: true,
      },
    },
  });

  assert.match(html, /id="monitor-replay"[^>]*data-agent-replay-bar/);
  assert.match(html, /id="monitor-travel"[^>]*data-replay-controls/);
  assert.match(html, /id="monitor-realtime-boot" type="application\/json"/);
  assert.match(html, /src="\/assets\/roster-client\.js"/);
  assert.match(html, /Realtime is automatic · no refresh polling/);
  assert.match(html, /id="room-directory-title">Your rooms<\/h2>/);
  assert.match(html, /Open room/);
  assert.match(html, /Self-improvement audit/);
  assert.match(html, /coding\.prompt/);
  assert.match(html, /2 monitored runs/);
  assert.doesNotMatch(html, /EventSource|text\/event-stream|hx-|sse-|\/monitor\/island|setInterval/);
});

test("monitor projects current jobs while replay remains an exact historical prefix", () => {
  const foreignJob: MonitorJobRow = {
    ...jobRow,
    workspaceId: "roster/foreign",
    status: "failed",
  };
  const foreignCommand: MonitorJobCommandRow = {
    ...commandRow,
    id: "cmd_foreign",
    workspaceId: "roster/foreign",
    command: "abort",
  };
  const projected = projectMonitorJobs(
    [foreignJob, jobRow],
    [foreignCommand, commandRow],
    "roster/default",
  );
  assert.equal(projected.length, 1);
  const [job] = projected;
  assert.ok(job);
  assert.equal(job.status, "running");
  assert.equal(job.commands.length, 1);
  assert.equal(job.commands[0]?.command, "steer");

  const receipts = [
    event(1n, 1_000n, {
      type: "job.enqueued",
      jobId: "job_demo",
      agentId: "writer",
      lane: "collect",
      payload: job.payload,
      maxAttempts: 2,
      createdAt: 1_000,
    }),
    event(2n, 2_000n, {
      type: "job.leased",
      jobId: "job_demo",
      workerId: "writer-1",
      leaseMs: 30_000,
      attempt: 1,
    }),
    event(3n, 3_000n, {
      type: "job.heartbeat",
      jobId: "job_demo",
      workerId: "writer-1",
      leaseMs: 30_000,
    }),
  ];

  const foreignReceipt = {
    ...event(4n, 4_000n, { type: "job.failed", jobId: "job_demo", error: "foreign" }),
    id: "event_foreign",
    workspaceId: "roster/foreign",
  };
  const leasedFrame = renderMonitorReplay(job, [...receipts, foreignReceipt], 2n, "roster/default");
  assert.deepEqual(leasedFrame.sequences, [1n, 2n, 3n]);
  assert.match(leasedFrame.label, /Replay 2\/3 · job\.leased/);
  assert.match(leasedFrame.html, /status-leased/);
  assert.match(leasedFrame.html, /2 linked receipts/);

  const liveFrame = renderMonitorReplay(job, [...receipts, foreignReceipt], null, "roster/default");
  assert.match(liveFrame.label, /Live 3\/3 · running/);
  assert.match(liveFrame.html, /status-running/);
});

test("monitor projects Canvas runs into the same fleet and queue model", () => {
  const [canvas] = projectMonitorCanvasRuns([{
    id: "canvas_demo",
    workspaceId: "roster/default",
    prompt: "A fox under moonlight",
    status: "running",
    desiredAgents: 8,
    maxInflight: 6,
    objectCount: 12,
    activeAgents: 5,
    totalAgents: 8,
    totalTasks: 10,
    completedTasks: 5,
    createdAt: 1_000,
    updatedAt: 2_000,
  }], "roster/default");
  assert.ok(canvas);
  assert.equal(canvas.agentId, "canvas");
  assert.equal(canvas.status, "running");
  assert.equal(canvas.payload.runId, "canvas_demo");
  const fleet = renderMonitorFleet([canvas]);
  assert.match(fleet, /Canvas Roster/);
  assert.match(fleet, /1 active/);
  assert.match(fleet, /Present in 1 active room/);
  assert.match(fleet, /Recent context available/);
  assert.doesNotMatch(fleet, /agents\/canvas|1 runs/);
});

test("monitor client subscribes to narrow projections and has no legacy refresh transport", () => {
  const client = fs.readFileSync("src/browser/monitor-client.ts", "utf8");
  const route = fs.readFileSync("src/agents/monitor.agent.ts", "utf8");
  assert.match(client, /tables\.myRosterJobs\.where/);
  assert.match(client, /tables\.myCanvasFleetRuns\.where/);
  assert.match(client, /tables\.myRosterJobCommands\.where/);
  assert.match(client, /tables\.myRosterJobEvents\.where/);
  assert.match(client, /tables\.myStreamReceipts\.where/);
  assert.match(client, /row\.workspaceId\.eq\(boot\.workspaceId\)\.and\(row\.jobId\.eq\(selectedJobId\)\)/);
  assert.match(client, /row\.workspaceId\.eq\(boot\.workspaceId\)\.and\(row\.streamId\.eq\(streamId\)\)/);
  assert.match(client, /row\.workspaceId !== boot\.workspaceId/);
  assert.match(client, /\.onApplied\(/);
  assert.match(client, /joinWorkspace/);
  assert.doesNotMatch(client, /EventSource|setInterval|\/island\//);
  assert.doesNotMatch(route, /SseHub|EventSource|monitor\/stream|monitor\/island|hx-|sse-/i);
});
