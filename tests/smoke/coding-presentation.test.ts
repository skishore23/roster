import assert from "node:assert/strict";
import test from "node:test";
import {
  codingLiveActivityPresentation,
  codingNodeBlockedStatus,
  codingNodePresentation,
  codingRunAttentionDetail,
  codingRunPresentation,
  isCodingUserVisibleTask,
  type CodingExecutionSnapshot,
  type CodingTaskSnapshot,
} from "../../src/browser/coding-presentation.js";

const execution = (
  overrides: Partial<CodingExecutionSnapshot> = {},
): CodingExecutionSnapshot => ({
  status: "running",
  totalTasks: 4,
  readyTasks: 0,
  blockedTasks: 0,
  inflightTasks: 1,
  acceptedTasks: 2,
  failedTasks: 0,
  canceledTasks: 0,
  skippedTasks: 0,
  terminalReason: "",
  ...overrides,
});

const task = (
  taskId: string,
  status: string,
  nodeId = "workspace.implementation",
): CodingTaskSnapshot => ({
  taskId,
  nodeId,
  capability: "implement",
  objective: "Improve the coding room",
  status,
  lastError: "",
});

test("Coding derives one conversational run state from the durable execution summary", () => {
  assert.deepEqual(codingRunPresentation(execution()), {
    state: "working",
    label: "Working",
    summary: "1 step is in progress now.",
    progress: "2 of 4 steps completed",
    needsAttention: false,
  });

  assert.deepEqual(codingRunPresentation(execution({
    status: "budget_exhausted",
    inflightTasks: 0,
    failedTasks: 1,
    canceledTasks: 1,
    terminalReason: "budget-exhausted",
  })), {
    state: "needs-attention",
    label: "Needs attention",
    summary: "The run stopped after reaching its execution budget.",
    progress: "2 of 4 steps completed",
    needsAttention: true,
  });

  assert.deepEqual(codingRunPresentation(execution({
    totalTasks: 3,
    acceptedTasks: 0,
    inflightTasks: 0,
    readyTasks: 1,
    blockedTasks: 2,
  }), [
    { ...task("announce-investigate", "ready"), capability: "room", displayName: "Kai" },
    { ...task("investigate", "pending"), capability: "investigate", displayName: "Kai" },
    { ...task("synthesize", "pending"), capability: "synthesize", displayName: "Kai" },
  ]), {
    state: "queued",
    label: "Queued",
    summary: "A teammate is queued to prepare the next room update.",
    progress: "0 of 2 steps completed",
    needsAttention: false,
  });
});

test("a durable queued job stays queued until its execution projection exists", () => {
  const expected = {
    state: "queued",
    label: "Queued",
    summary: "Waiting for an available workspace agent.",
    progress: "Queued before the first step",
    needsAttention: false,
  } as const;
  assert.deepEqual(codingRunPresentation(undefined, [], "queued"), expected);
  assert.deepEqual(codingRunPresentation(execution({
    status: "failed",
    inflightTasks: 0,
    failedTasks: 1,
    terminalReason: "runtime-error",
  }), [task("stale-investigation", "failed")], "queued"), expected);
});

test("Successful continuation skips count as completed run steps", () => {
  assert.deepEqual(codingRunPresentation(execution({
    status: "completed",
    inflightTasks: 0,
    acceptedTasks: 3,
    skippedTasks: 1,
  })), {
    state: "complete",
    label: "Complete",
    summary: "The team finished and accepted the run.",
    progress: "4 of 4 steps completed",
    needsAttention: false,
  });
});

test("internal authored-announcement gates do not inflate visible mission progress", () => {
  const tasks: CodingTaskSnapshot[] = [
    { ...task("announce-investigate", "accepted"), capability: "room", displayName: "Kai" },
    { ...task("investigate", "running"), capability: "investigate", displayName: "Kai" },
    { ...task("synthesize", "pending"), capability: "synthesize", displayName: "Kai" },
  ];

  assert.deepEqual(codingRunPresentation(execution({
    totalTasks: 3,
    acceptedTasks: 1,
    inflightTasks: 1,
  }), tasks), {
    state: "working",
    label: "Working",
    summary: "1 step is in progress now.",
    progress: "0 of 2 steps completed",
    needsAttention: false,
  });

  assert.deepEqual(codingRunPresentation(execution({
    totalTasks: 3,
    acceptedTasks: 0,
    inflightTasks: 1,
    blockedTasks: 2,
  }), [
    { ...task("announce-investigate", "running"), capability: "room", displayName: "Kai" },
    { ...task("investigate", "pending"), capability: "investigate", displayName: "Kai" },
    { ...task("synthesize", "pending"), capability: "synthesize", displayName: "Kai" },
  ]), {
    state: "working",
    label: "Working",
    summary: "A teammate is preparing the next room update.",
    progress: "0 of 2 steps completed",
    needsAttention: false,
  });

  assert.deepEqual(codingRunAttentionDetail([
    { ...task("announce-investigate", "failed"), capability: "room", displayName: "Kai" },
    { ...task("investigate", "pending"), capability: "investigate", displayName: "Kai" },
  ], "task-failed"), {
    taskId: "announce-investigate",
    nodeId: "workspace.implementation",
    taskLabel: "Introduction before investigate",
    status: "failed",
    headline: "Kai’s Introduction before investigate step failed.",
    explanation: "Roster did not receive a valid model-authored start update, so the repository task did not begin.",
  });

  assert.deepEqual(codingRunPresentation(execution({
    totalTasks: 3,
    acceptedTasks: 1,
    inflightTasks: 1,
    blockedTasks: 1,
  }), [
    { ...task("coding-coordinate", "accepted", "coordinator"), capability: "coordinate" },
    { ...task("investigate", "running"), capability: "investigate" },
    { ...task("coding-finalize", "pending", "coordinator"), capability: "coordinate" },
  ]), {
    state: "working",
    label: "Working",
    summary: "1 step is in progress now.",
    progress: "0 of 1 steps completed",
    needsAttention: false,
  });
  assert.equal(isCodingUserVisibleTask({ nodeId: "coordinator", capability: "certify" }), false);
  assert.equal(isCodingUserVisibleTask({ nodeId: "workspace.implementation", capability: "coordinate" }), false);
  assert.equal(isCodingUserVisibleTask({ nodeId: "workspace.implementation", capability: "room" }), false);
  assert.equal(isCodingUserVisibleTask({ nodeId: "workspace.quality", capability: "review" }), true);
  assert.equal(codingRunAttentionDetail([
    { ...task("coding-finalize", "failed", "coordinator"), capability: "coordinate" },
  ], "run-failed"), undefined);
});

test("a completed run with missing or contradictory task outcomes needs attention", () => {
  for (const projection of [
    execution({ status: "completed", inflightTasks: 0, acceptedTasks: 3 }),
    execution({ status: "completed", inflightTasks: 1, acceptedTasks: 3 }),
    execution({ status: "completed_with_notes", inflightTasks: 0, acceptedTasks: 3, failedTasks: 1 }),
  ]) {
    const result = codingRunPresentation(projection);
    assert.equal(result.state, "needs-attention");
    assert.equal(result.label, "Needs attention");
    assert.match(result.summary, /marked complete.*incomplete or contradictory/i);
  }
});

test("Terminal run state overrides stale or queued per-agent task state without erasing accepted work", () => {
  const stoppedRun = codingRunPresentation(execution({
    status: "failed",
    inflightTasks: 0,
    failedTasks: 1,
    terminalReason: "run-failed",
  }));

  assert.equal(codingNodePresentation([
    task("proposal", "accepted"),
    task("implementation", "pending"),
  ], stoppedRun).state, "blocked");

  assert.equal(codingNodePresentation([
    task("proposal", "accepted"),
    task("review", "skipped"),
  ], stoppedRun).state, "done");
});

test("Active per-agent state selects current work before queued follow-up tasks", () => {
  const activeRun = codingRunPresentation(execution());
  const presentation = codingNodePresentation([
    task("proposal", "accepted"),
    task("implementation", "running"),
    task("review", "pending"),
  ], activeRun);

  assert.equal(presentation.state, "working");
  assert.equal(presentation.task?.taskId, "implementation");
});

test("unfinished teammate copy names the durable cause without blaming the human", () => {
  assert.deepEqual(codingNodeBlockedStatus({
    taskLabel: "review",
    taskStatus: "failed",
    taskError: "validation command exited with status 1",
    runReason: "The run stopped before every step could be accepted.",
  }), {
    label: "Blocked",
    message: "Review failed. Reason: Validation command exited with status 1.",
  });

  assert.deepEqual(codingNodeBlockedStatus({
    taskLabel: "review",
    taskStatus: "pending",
    runReason: "abort requested",
  }), {
    label: "Not completed",
    message: "Review did not finish before the run stopped. Reason: Abort requested.",
  });

  assert.deepEqual(codingNodeBlockedStatus({
    taskLabel: "review",
    taskStatus: "canceled",
    runReason: "execution budget exhausted",
  }), {
    label: "Stopped with run",
    message: "Review stopped when the run ended. Reason: Execution budget exhausted.",
  });
});

test("failed runs name the exact unfinished specialist step and a safe public cause", () => {
  const tasks: CodingTaskSnapshot[] = [
    { ...task("investigate-implementation", "accepted"), displayName: "Kai" },
    { ...task("investigate-runtime", "accepted"), displayName: "Kai" },
    { ...task("synthesize-investigation", "accepted"), displayName: "Kai", capability: "synthesize" },
    {
      ...task("review-runtime", "failed", "workspace.quality"),
      displayName: "Mira",
      capability: "review",
      failureCategory: "worker-timeout",
      failureReason: "The assigned runtime stopped responding before it returned an accepted result.",
    },
  ];

  assert.deepEqual(codingRunAttentionDetail(tasks, "run-failed"), {
    taskId: "review-runtime",
    nodeId: "workspace.quality",
    taskLabel: "Review runtime",
    status: "failed",
    headline: "Mira’s Review runtime step failed.",
    explanation: "The assigned runtime stopped responding before it returned an accepted result.",
  });

  assert.deepEqual(codingRunPresentation(execution({
    status: "failed",
    inflightTasks: 0,
    acceptedTasks: 3,
    failedTasks: 1,
    terminalReason: "run-failed",
  }), tasks), {
    state: "needs-attention",
    label: "Needs attention",
    summary: "Mira’s Review runtime step failed. The assigned runtime stopped responding before it returned an accepted result.",
    progress: "3 of 4 steps completed",
    needsAttention: true,
  });

  assert.equal(codingRunAttentionDetail([{
    ...task("review-runtime", "failed", "workspace.quality"),
    displayName: "Mira",
    capability: "review",
    failureCategory: "task-failed",
    failureReason: "Roster did not receive an accepted result for this step.",
  }], "budget-exhausted")?.explanation,
  "The run reached its execution budget before this step could return an accepted result.");
});

test("live activity is a neutral compact projection and never repeats raw runtime output", () => {
  assert.deepEqual(codingLiveActivityPresentation({
    nodeId: "workspace.implementation",
    displayName: "Kai",
    capability: "investigate",
    signalCount: 7,
    lastSignalAt: 1_788_000_000_000,
  }), {
    nodeId: "workspace.implementation",
    displayName: "Kai",
    activity: "Investigating the repository",
    signalCount: 7,
    lastSignalAt: 1_788_000_000_000,
  });

  assert.deepEqual(codingLiveActivityPresentation({
    nodeId: "workspace.quality",
    displayName: "Mira",
    capability: "review",
    signalCount: 0,
  }), {
    nodeId: "workspace.quality",
    displayName: "Mira",
    activity: "Reviewing the accepted work",
    signalCount: 0,
  });

  assert.deepEqual(codingLiveActivityPresentation({
    nodeId: "workspace.api",
    displayName: "Theo",
    capability: "investigate",
    phase: "queued",
    signalCount: 0,
  }), {
    nodeId: "workspace.api",
    displayName: "Theo",
    activity: "Queued to investigate the repository",
    signalCount: 0,
  });
});
