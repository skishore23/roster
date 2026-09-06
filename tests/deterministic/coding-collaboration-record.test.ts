import assert from "node:assert/strict";
import test from "node:test";

import type { QueueJob } from "../../src/engine/runtime/job-queue.ts";
import {
  initialOrchestrationState,
  inlineArtifactPublishedEvent,
  reduceOrchestration,
  type OrchestrationEvent,
  type OrchestrationState,
} from "../../src/modules/orchestration.ts";
import {
  CODING_COLLABORATION_RECORD_LIMITS,
  renderCodingCollaborationRecord,
} from "../../src/views/coding-collaboration-record.ts";
import {
  codingAcceptedOutputProjectionKey,
  type CodingAcceptedOutput,
} from "../../src/domains/coding-accepted-outputs.ts";

const completedJob = (objective: string): QueueJob => ({
  id: "job-export",
  agentId: "coding-agent",
  lane: "collect",
  payload: {
    kind: "coding-agent.run",
    runId: "coding-export",
    branch: "roster/coding-export",
    objective,
    selectedNodeIds: ["worker", "reviewer"],
  },
  status: "completed",
  attempt: 1,
  maxAttempts: 1,
  createdAt: 1,
  updatedAt: 2,
  commands: [],
  result: {
    status: "verified",
    summary: "Selected job result.",
    changedFiles: ["src/views/coding.ts"],
    validation: ["AWS_SECRET_ACCESS_KEY='quoted secret value' npm test"],
    frontierHash: "frontier-selected-job",
    commit: "a".repeat(40),
  },
});

const baseState = (): OrchestrationState => ({
  ...initialOrchestrationState,
  nodes: {
    worker: {
      id: "worker",
      name: "Implementation <Engineer>",
      capabilities: ["implement"],
      runtime: { kind: "claude-code", profile: "declared", metadata: { model: "declared-model" } },
      status: "active",
      updatedAt: 1,
    },
    reviewer: {
      id: "reviewer",
      name: "Quality Steward",
      capabilities: ["review", "certify"],
      runtime: { kind: "codex-cli", metadata: { model: "gpt-review" } },
      status: "active",
      updatedAt: 1,
    },
    resolver: {
      id: "resolver",
      name: "Temporary Resolver",
      capabilities: ["resolve"],
      status: "retired",
      updatedAt: 1,
    },
  },
  nodeBindings: {
    worker: {
      bindingId: "binding-worker",
      nodeId: "worker",
      runtime: { kind: "pi-agent", profile: "effective", metadata: { model: "bound-model" } },
      epoch: 2,
      topologyVersion: "topology-1",
      updatedAt: 2,
    },
  },
  taskGraph: {
    runId: "coding-export",
    projectionVersion: "graph-projection-1",
    tasks: [
      { taskId: "propose-worker", nodeId: "worker", capability: "propose", objective: "Propose", status: "accepted", attempt: 1, dependencies: [] },
      { taskId: "respond-reviewer", nodeId: "reviewer", capability: "respond", objective: "Respond", status: "accepted", attempt: 1, dependencies: [{ taskId: "propose-worker", condition: "accepted" }] },
      { taskId: "resolve-collaboration", nodeId: "resolver", capability: "resolve", objective: "Resolve", status: "accepted", attempt: 1, dependencies: [{ taskId: "propose-worker", condition: "accepted" }, { taskId: "respond-reviewer", condition: "accepted" }] },
      { taskId: "implement", nodeId: "worker", capability: "implement", objective: "Implement safely", status: "accepted", attempt: 1, dependencies: [{ taskId: "resolve-collaboration", condition: "accepted" }] },
      { taskId: "certify-reviewer", nodeId: "reviewer", capability: "certify", objective: "Certify", status: "accepted", attempt: 1, dependencies: [{ taskId: "implement", condition: "accepted" }] },
    ],
    expansions: [],
    acceptedCostMicros: 0,
    acceptedTokens: 0,
    updatedAt: 1,
  },
});

const publish = (
  state: OrchestrationState,
  outputKey: string,
  taskId: string,
  nodeId: string,
  value: string,
  updatedAt: number,
  origin: "task" | "input" = "task",
): OrchestrationState => reduceOrchestration(state, inlineArtifactPublishedEvent({
  runId: "coding-export",
  artifactId: `artifact-${outputKey}`,
  origin,
  outputKey,
  ...(origin === "task" ? { taskId } : {}),
  nodeId,
  kind: outputKey,
  inputVersions: {},
}, value), updatedAt);

const values = {
  proposal: JSON.stringify({
    status: "proposal",
    summary: "Use <strong>one renderer</strong>.",
    recommendations: [{
      subjectId: "implementation-approach",
      recommendation: "Share the renderer",
      rationale: "API and browser must match",
      evidence: ["src/agents/coding.agent.ts Bearer eyJhbGciOiJIUzI1NiJ9.payloadsignaturevalue.signaturevalue"],
      confidence: 0.95,
    }],
    questions: [],
  }),
  response: JSON.stringify({
    status: "response",
    summary: "Bearer policy stays unchanged.",
    answers: [{
      subjectId: "public-contract",
      response: "Use a browser route",
      rationale: "Normal links cannot supply bearer headers",
      evidence: ["docs/api.md"],
      confidence: 0.99,
    }],
    openQuestions: [],
  }),
  resolution: JSON.stringify({
    status: "resolved",
    summary: "All subjects resolved.",
    decisions: [
      { subjectId: "public-contract", resolution: "Keep API auth", rationale: "Existing policy", evidence: ["docs/api.md"] },
      { subjectId: "implementation-approach", resolution: "Share renderer", rationale: "Determinism", evidence: ["src/views"] },
    ],
    unresolved: [],
  }),
  endorsement: JSON.stringify({
    verdict: "approve",
    frontierHash: "frontier-123",
    summary: "Exact frontier approved.",
    evidence: ["focused tests passed"],
  }),
  result: JSON.stringify({
    implementation_report: {
      status: "verified",
      summary: "Export added.",
      changedFiles: ["src/views/coding.ts"],
      validation: ["npm test"],
      frontierHash: "frontier-123",
      raw: "RAW_RESULT_MUST_NOT_APPEAR",
    },
  }),
};

const buildState = (order: ReadonlyArray<keyof typeof values>): OrchestrationState => order.reduce((state, key, index) => {
  const metadata = {
    proposal: ["collaboration_proposal_worker", "propose-worker", "worker"],
    response: ["collaboration_response_reviewer", "respond-reviewer", "reviewer"],
    resolution: ["collaboration_resolution", "resolve-collaboration", "resolver"],
    endorsement: ["collaboration_endorsement_reviewer", "certify-reviewer", "reviewer"],
    result: ["implementation_report", "implement", "worker"],
  }[key] as readonly [string, string, string];
  return publish(state, metadata[0], metadata[1], metadata[2], values[key], index + 10);
}, publish(baseState(), "patch", "", "worker", "PATCH_SECRET_MUST_NOT_APPEAR", 3, "input"));

test("coding collaboration records are deterministic, semantic, bounded, and allowlisted", () => {
  const objective = "Add <script>alert(1)</script> export with api_key=supersecret123 and\u0000controls";
  const events: ReadonlyArray<OrchestrationEvent> = [{
    type: "control.frontier.certified",
    runId: "coding-export",
    artifactId: "coding:coding-export:collaboration",
    frontierVersion: "2.2.0-reviewed",
    topologyVersion: "topology-1",
    certificationId: "certification-1",
    versionHash: "version-1",
    acceptedProposalIds: ["proposal-1"],
  }];
  const first = renderCodingCollaborationRecord({
    runId: "coding-export",
    receiptCount: events.length,
    state: buildState(["endorsement", "resolution", "response", "proposal", "result"]),
    events,
    job: completedJob(objective),
  });
  const second = renderCodingCollaborationRecord({
    runId: "coding-export",
    receiptCount: events.length,
    state: buildState(["proposal", "response", "resolution", "endorsement", "result"]),
    events,
    job: completedJob(objective),
  });

  assert.equal(first, second);
  assert.ok(first.indexOf("proposal —") < first.indexOf("response —"));
  assert.ok(first.indexOf("response —") < first.indexOf("resolution —"));
  assert.ok(first.indexOf("resolution —") < first.indexOf("endorsement —"));
  assert.match(first, /Runtime: pi-agent/);
  assert.match(first, /Profile: effective/);
  assert.match(first, /Model: bound-model/);
  assert.match(first, /Binding epoch: 2/);
  assert.doesNotMatch(first, /declared-model/);
  assert.ok(first.includes("&lt;script&gt;alert\\(1\\)&lt;/script&gt;"));
  assert.ok(first.includes("api\\_key=[REDACTED]"));
  assert.doesNotMatch(first, /\u0000/);
  assert.doesNotMatch(first, /supersecret123|quoted secret value|eyJhbGciOiJIUzI1NiJ9|PATCH_SECRET_MUST_NOT_APPEAR|RAW_RESULT_MUST_NOT_APPEAR/);
  assert.match(first, /Certified frontier receipt: certification-1/);
  assert.match(first, /Result status: verified/);
  assert.match(first, /Selected job result\\\./);
  assert.doesNotMatch(first, /Export added\./);
  assert.match(first, /Record basis: durable receipt replay head with 1 receipt/);
  assert.ok(Buffer.byteLength(first, "utf8") <= CODING_COLLABORATION_RECORD_LIMITS.totalBytes);
  assert.equal(first.endsWith("\n"), true);
});

test("coding collaboration records never infer certification from completion or task names", () => {
  const record = renderCodingCollaborationRecord({
    runId: "coding-export",
    receiptCount: 0,
    state: publish(baseState(), "implementation_report", "implement", "worker", values.result, 4),
    events: [],
    job: completedJob("Export the record"),
  });
  assert.match(record, /No certification evidence recorded at this replay head\./);
  assert.match(record, /Certification task context — certify-reviewer: accepted/);
  assert.doesNotMatch(record, /peer certified|Certified & complete/);
});

test("coding collaboration records include authoritative accepted peer outputs", () => {
  const accepted = (
    outputKey: string,
    taskId: string,
    nodeId: string,
    value: string,
  ): CodingAcceptedOutput => ({
    runId: "coding-export",
    taskId,
    nodeId,
    outcomeId: `outcome-${taskId}`,
    artifactId: `artifact-${taskId}`,
    projectionKey: codingAcceptedOutputProjectionKey(outputKey, taskId),
    outputKey,
    kind: "json",
    contentHash: `hash-${taskId}`,
    mediaType: "application/json",
    byteLength: Buffer.byteLength(value),
    value,
  });
  const record = renderCodingCollaborationRecord({
    runId: "coding-export",
    receiptCount: 0,
    state: baseState(),
    events: [],
    job: completedJob("Export accepted collaboration"),
    acceptedOutputs: [
      accepted("collaboration_proposal_worker", "propose-worker", "worker", values.proposal),
      accepted("collaboration_resolution", "resolve-collaboration", "resolver", values.resolution),
      accepted("collaboration_endorsement_reviewer", "certify-reviewer", "reviewer", values.endorsement),
    ],
    acceptedOutputsOmitted: 2,
  });
  assert.match(record, /proposal — collaboration\\_proposal\\_worker/);
  assert.match(record, /Resolution status: resolved/);
  assert.match(record, /Endorsement by reviewer: approve/);
  assert.doesNotMatch(record, /No certification evidence recorded/);
  assert.match(record, /0 receipts plus an authoritative accepted-output snapshot with 3 outputs/);
  assert.match(record, /2 outputs omitted/);
});

test("coding collaboration record sections truncate visibly and repeatably", () => {
  const long = "x".repeat(500);
  const proposal = JSON.stringify({
    status: "proposal",
    summary: "s".repeat(1_200),
    recommendations: Array.from({ length: 8 }, (_, index) => ({
      subjectId: `subject-${index}`,
      recommendation: "r".repeat(1_600),
      rationale: "q".repeat(1_600),
      evidence: Array.from({ length: 12 }, () => long),
      confidence: 0.5,
    })),
    questions: Array.from({ length: 6 }, () => "z".repeat(600)),
  });
  const state = publish(baseState(), "collaboration_proposal_worker", "propose-worker", "worker", proposal, 8);
  const input = { runId: "coding-export", receiptCount: 0, state, events: [], job: completedJob(`Bound it ${"🧪".repeat(6_000)}`) } as const;
  const first = renderCodingCollaborationRecord(input);
  assert.equal(first, renderCodingCollaborationRecord(input));
  assert.match(first, /\[Truncated deterministically\]/);
  assert.ok(Buffer.byteLength(first, "utf8") <= CODING_COLLABORATION_RECORD_LIMITS.totalBytes);
});

test("coding collaboration records include bounded redacted runtime diagnostics", () => {
  const runtimeDiagnostics = Array.from({ length: 82 }, (_, index) => ({
    runId: "coding-export",
    nodeId: index === 81 ? "worker<script>" : `worker-${index}`,
    taskId: `task-${index}`,
    runtime: "codex-cli" as const,
    stream: index % 2 === 0 ? "stdout" as const : "stderr" as const,
    text: index === 81
      ? "Authorization: Bearer secret-token-value and api_key=another-secret-value"
      : `diagnostic ${index}`,
    at: index + 1,
    truncated: index === 80,
  }));
  const input = {
    runId: "coding-export",
    receiptCount: 0,
    state: baseState(),
    events: [],
    job: completedJob("Export diagnostics safely"),
    runtimeDiagnostics,
  } as const;
  const record = renderCodingCollaborationRecord(input);

  assert.equal(record, renderCodingCollaborationRecord(input));
  assert.match(record, /## Runtime diagnostics/);
  assert.match(record, /diagnostic 2/);
  assert.doesNotMatch(record, /diagnostic (?:0|1)(?:\n|$)/);
  assert.match(record, /2 items omitted/);
  assert.match(record, /Bearer \[REDACTED\]/);
  assert.match(record, /api\\_key=\[REDACTED\]/);
  assert.doesNotMatch(record, /secret-token-value|another-secret-value|<script>/);
  assert.match(record, /worker&lt;script&gt;/);
  assert.match(record, /\[Truncated deterministically\]/);
  assert.match(record, /diagnostic only; durable receipts remain authoritative/);
});

test("coding collaboration records visibly bound collections", () => {
  const selectedNodeIds = Array.from({ length: 26 }, (_, index) => `worker-${index.toString().padStart(2, "0")}`);
  const job = {
    ...completedJob("Bound selected agents"),
    payload: { ...completedJob("Bound selected agents").payload, selectedNodeIds },
  };
  const record = renderCodingCollaborationRecord({
    runId: "coding-export",
    receiptCount: 0,
    state: baseState(),
    events: [],
    job,
  });
  assert.match(record, /\[Truncated deterministically\]: 2 items omitted/);
});

test("coding collaboration records visibly bound dynamic graph dependencies", () => {
  const state = baseState();
  const dependencies = Array.from({ length: 23 }, (_, index) => ({
    taskId: `need-${index.toString().padStart(2, "0")}`,
    condition: "accepted" as const,
  }));
  const boundedState: OrchestrationState = {
    ...state,
    taskGraph: {
      ...state.taskGraph!,
      tasks: state.taskGraph!.tasks.map((task) =>
        task.taskId === "implement" ? { ...task, dependencies } : task),
    },
  };
  const record = renderCodingCollaborationRecord({
    runId: "coding-export",
    receiptCount: 0,
    state: boundedState,
    events: [],
    job: completedJob("Bound task collections"),
  });

  assert.ok(record.includes("Dependencies: need-00 \\(accepted\\), need-01 \\(accepted\\)"));
  assert.match(record, /need-19/);
  assert.doesNotMatch(record, /need-20|need-21|need-22/);
  assert.ok(record.includes("    - Dependencies [Truncated deterministically]: 3 items omitted"));
});

test("coding collaboration records advance with structured integration receipts", () => {
  const job = completedJob("Project the current replay head");
  const beforeState = baseState();
  const before = renderCodingCollaborationRecord({
    runId: "coding-export",
    receiptCount: 4,
    state: beforeState,
    events: [],
    job,
  });
  const integration = JSON.stringify({
    schema: "roster.coding-integration.result.v1",
    runId: "coding-export",
    status: "integrated",
    targetBranch: "main",
    resultingCommit: "a".repeat(40),
  });
  const afterState = publish(beforeState, "integration_result", "", "coordinator", integration, 5, "input");
  const afterInput = {
    runId: "coding-export",
    receiptCount: 5,
    state: afterState,
    events: [],
    job,
  } as const;
  const after = renderCodingCollaborationRecord(afterInput);
  assert.notEqual(after, before);
  assert.equal(renderCodingCollaborationRecord(afterInput), after);
  assert.match(before, /No structured integration result recorded at this replay head\./);
  assert.match(after, /## Current\-head integration/);
  assert.match(after, /Status: integrated/);
  assert.match(after, /Record basis: durable receipt replay head with 5 receipts/);

  const alreadyIntegrated = JSON.stringify({
    schema: "roster.coding-integration.result.v1",
    runId: "coding-export",
    status: "already_integrated",
    targetBranch: "main",
    resultingCommit: "a".repeat(40),
    ignoredFutureField: { forwardCompatible: true },
  });
  const alreadyIntegratedState = publish(beforeState, "integration_result", "", "coordinator", alreadyIntegrated, 5, "input");
  const alreadyIntegratedRecord = renderCodingCollaborationRecord({ ...afterInput, state: alreadyIntegratedState });
  assert.match(alreadyIntegratedRecord, /Status: already\\_integrated/);
});

test("coding collaboration records reject unrelated or malformed integration receipts", () => {
  const job = completedJob("Validate the current integration receipt");
  const invalidReceipts: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
    ["mismatched run", { runId: "coding-other-run", status: "integrated", targetBranch: "main", resultingCommit: "a".repeat(40) }],
    ["unsupported status", { runId: "coding-export", status: "failed", targetBranch: "main", resultingCommit: "a".repeat(40) }],
    ["missing target branch", { runId: "coding-export", status: "integrated", resultingCommit: "a".repeat(40) }],
    ["blank target branch", { runId: "coding-export", status: "integrated", targetBranch: " ", resultingCommit: "a".repeat(40) }],
    ["malformed target branch", { runId: "coding-export", status: "integrated", targetBranch: 7, resultingCommit: "a".repeat(40) }],
    ["missing resulting commit", { runId: "coding-export", status: "integrated", targetBranch: "main" }],
    ["blank resulting commit", { runId: "coding-export", status: "integrated", targetBranch: "main", resultingCommit: " " }],
    ["malformed resulting commit", { runId: "coding-export", status: "integrated", targetBranch: "main", resultingCommit: null }],
  ];

  for (const [label, fields] of invalidReceipts) {
    const receipt = JSON.stringify({ schema: "roster.coding-integration.result.v1", ...fields });
    const state = publish(baseState(), "integration_result", "", "coordinator", receipt, 5, "input");
    const record = renderCodingCollaborationRecord({
      runId: "coding-export",
      receiptCount: 5,
      state,
      events: [],
      job,
    });
    assert.match(record, /No structured integration result recorded at this replay head\./, label);
    assert.doesNotMatch(record, /Target branch: main|Resulting commit: a{40}/, label);
  }
});
