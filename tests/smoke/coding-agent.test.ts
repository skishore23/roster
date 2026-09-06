import assert from "node:assert/strict";
import test from "node:test";

import {
  previewCodingAgentGraph,
  type CodingAgentGraphPreview,
} from "../../src/domains/coding.ts";
import { codingRoomUpdateRecipientPolicy } from "../../src/domains/coding-room-updates.ts";
import type { WorkspaceNode } from "../../src/engine/orchestration/types.ts";

const WORKER: WorkspaceNode = {
  id: "workspace.implementation",
  name: "Kai, Implementation Specialist",
  capabilities: ["implement", "respond"],
  runtime: { kind: "pi-agent" },
  metadata: {
    role: "worker",
    specialty: "implementation",
    repositoryReason: "Own focused repository implementation.",
  },
};

const REVIEWER: WorkspaceNode = {
  id: "workspace.quality",
  name: "Mira, Quality Specialist",
  capabilities: ["review", "respond"],
  runtime: { kind: "codex-cli" },
  metadata: {
    role: "supervisor",
    specialty: "quality",
    repositoryReason: "Own independent quality review.",
  },
};

const SECURITY_REVIEWER: WorkspaceNode = {
  id: "workspace.security",
  name: "Noor, Security Specialist",
  capabilities: ["review", "respond"],
  runtime: { kind: "codex-cli" },
  metadata: {
    role: "supervisor",
    specialty: "security",
    repositoryReason: "Own independent security review.",
  },
};

const selection = {
  workspaceNodes: [WORKER, REVIEWER],
  selectedNodeIds: [WORKER.id, REVIEWER.id],
  primaryNodeId: WORKER.id,
  coordination: {
    reviewMode: "reviewed" as const,
    validationScope: "focused" as const,
  },
};

const modelCapabilities = new Set([
  "propose",
  "respond",
  "resolve",
  "implement",
  "investigate",
  "review",
  "remediate",
  "certify",
]);

const announcedCapabilities = new Set([
  "propose",
  "respond",
  "resolve",
  "implement",
  "investigate",
  "review",
]);

test("Coding gates primary model work on a bounded same-node announcement", () => {
  const plan = previewCodingAgentGraph({
    ...selection,
    objective: "Make repository handoffs visible without provider-specific tools",
    runId: "coding-room-announcement-gate",
  });

  const substantiveTasks = plan.tasks.filter((task) => announcedCapabilities.has(task.capability));
  assert.ok(substantiveTasks.length > 0);
  for (const task of substantiveTasks) {
    const announcement = plan.tasks.find((candidate) => candidate.id === `announce-${task.id}`);
    assert.ok(announcement, task.id);
    assert.equal(announcement.nodeId, task.nodeId, task.id);
    assert.equal(announcement.capability, "room", task.id);
    assert.equal(announcement.provides.length, 1, task.id);
    assert.ok(task.needs.includes(announcement.provides[0]!), task.id);
    assert.match(announcement.objective, /strict JSON: \{summary:string \(1-420 characters\)\}/u, task.id);
    assert.match(announcement.objective, /Do not claim work, evidence, or results that are not complete/u, task.id);
    assert.doesNotMatch(announcement.objective, /coding::room\.post-update/u, task.id);
  }
});

const assertRoomContract = (plan: CodingAgentGraphPreview): void => {
  for (const task of plan.tasks.filter((candidate) => modelCapabilities.has(candidate.capability))) {
    assert.match(task.objective, /coding::room\.post-update/u, task.id);
    assert.match(task.objective, /at most three optional/u, task.id);
    assert.match(task.objective, /a room function call is never required for completion/u, task.id);
    assert.match(task.objective, /Do not call a room function solely to announce that work started/u, task.id);
    assert.doesNotMatch(task.objective, /Before substantive work, post/u, task.id);
    assert.match(
      task.objective,
      /Do not include raw commands, logs, hidden reasoning, tool transcripts, JSON, or fabricated results in room text\./u,
      task.id,
    );
    assert.match(
      task.objective,
      /Use the existing `summary` field as the natural model-authored handoff after this task is complete\./u,
      task.id,
    );
  }
};

test("Coding investigation objectives require bounded model-authored room communication", () => {
  const plan = previewCodingAgentGraph({
    ...selection,
    executionKind: "investigation",
    objective: "Explain how Coding routes room updates",
    runId: "coding-room-investigation",
  });

  assertRoomContract(plan);
  const synthesis = plan.tasks.find((task) => task.id === "synthesize-investigation");
  assert.ok(synthesis);
  assert.match(
    synthesis.objective,
    /Use the existing `summary` field as the natural model-authored handoff after this task is complete\./u,
  );
  assert.equal((synthesis.objective.match(/coding::room\.post-update/gu) ?? []).length, 1);

  const leadEvidence = plan.tasks.find((task) =>
    task.id.startsWith("investigate-") && task.nodeId === WORKER.id);
  assert.ok(leadEvidence);
  const leadRecipients = codingRoomUpdateRecipientPolicy(plan.tasks, leadEvidence.id, "human.operator");
  assert.deepEqual(leadRecipients.downstreamNodeIds, []);
  assert.ok(plan.tasks.some((task) =>
    task.needs.some((need) => leadEvidence.provides.includes(need))), "lead evidence is graph-nonterminal");
  assert.match(leadEvidence.objective, /continues the assigned downstream work internally/u);
  assert.doesNotMatch(leadEvidence.objective, /first-person reply to the human/u);
});

test("Coding reviewed objectives address exact upstream and downstream node IDs", () => {
  const plan = previewCodingAgentGraph({
    ...selection,
    objective: "Add natural room updates to Coding objectives",
    runId: "coding-room-reviewed",
  });

  assertRoomContract(plan);
  const implementation = plan.tasks.find((task) => task.id === "implement");
  assert.ok(implementation);
  assert.match(implementation.objective, /Upstream node IDs: workspace\.quality/u);
  assert.match(implementation.objective, /Downstream node IDs: workspace\.quality/u);

  const certification = plan.tasks.find((task) => task.capability === "certify");
  assert.ok(certification);
  assert.match(
    certification.objective,
    /conversational reply to the listed downstream participants/u,
  );
  assert.equal((certification.objective.match(/coding::room\.post-update/gu) ?? []).length, 1);
  const synthesis = plan.tasks.find((task) => task.capability === "synthesize");
  assert.ok(synthesis);
  assert.match(
    synthesis.objective,
    /Write that field as one direct, natural first-person reply to the human.*exactly once\./u,
  );
  const remediation = plan.tasks.find((task) => task.capability === "remediate");
  assert.ok(remediation);
  assert.match(remediation.objective, /summary:string \(1-1600 characters\)/u);
  assert.match(remediation.objective, /validation:string\[\]/u);
  assert.deepEqual(remediation.provides, ["final_report"]);
});

test("Coding fast objectives add a bounded summary without repurposing structured validation", () => {
  const plan = previewCodingAgentGraph({
    workspaceNodes: [WORKER],
    selectedNodeIds: [WORKER.id],
    primaryNodeId: WORKER.id,
    coordination: { reviewMode: "fast", validationScope: "focused" },
    objective: "Make one narrow low-risk change",
    runId: "coding-room-fast",
  });

  assertRoomContract(plan);
  assert.deepEqual(plan.tasks.map((task) => task.capability), ["room", "implement", "synthesize"]);
  const implementation = plan.tasks.find((task) => task.id === "implement");
  assert.ok(implementation);
  assert.match(implementation.objective, /summary:string \(1-1600 characters\)/u);
  assert.match(implementation.objective, /validation:string\[\]/u);
  assert.match(implementation.objective, /Use the existing `summary` field/u);
  assert.doesNotMatch(implementation.objective, /existing `validation` field/u);
  assert.deepEqual(implementation.provides, ["final_report"]);
  const synthesis = plan.tasks.find((task) => task.id === "synthesize-final");
  assert.ok(synthesis);
  assert.match(synthesis.objective, /certified frontierHash/u);
  assert.deepEqual(synthesis.needs, ["final_report"]);
  assert.deepEqual(synthesis.provides, ["coding_final_answer"]);
});

test("Coding full reviewed council objectives cover resolution and every model capability", () => {
  const plan = previewCodingAgentGraph({
    workspaceNodes: [WORKER, REVIEWER, SECURITY_REVIEWER],
    selectedNodeIds: [WORKER.id, REVIEWER.id, SECURITY_REVIEWER.id],
    primaryNodeId: WORKER.id,
    coordination: { reviewMode: "reviewed", validationScope: "focused" },
    objective: "Change a cross-specialty public contract",
    runId: "coding-room-full-reviewed",
  });

  assertRoomContract(plan);
  assert.ok(plan.tasks.some((task) => task.capability === "resolve"));
  const remediation = plan.tasks.find((task) => task.capability === "remediate");
  assert.ok(remediation);
  assert.match(remediation.objective, /summary:string \(1-1600 characters\)/u);
  assert.match(remediation.objective, /validation:string\[\]/u);
  assert.deepEqual(remediation.provides, ["final_report"]);
  assert.deepEqual(
    [...new Set(plan.tasks.filter((task) => modelCapabilities.has(task.capability))
      .map((task) => task.capability))].sort(),
    ["certify", "implement", "propose", "remediate", "resolve", "respond", "review"],
  );
  assert.equal(plan.tasks.some((task) => task.nodeId === "coordinator"), false);
});

test("Coding repository-wide validation stays non-model while adjacent objectives keep room instructions", () => {
  const plan = previewCodingAgentGraph({
    ...selection,
    coordination: { reviewMode: "reviewed", validationScope: "repository-wide" },
    objective: "Change a repository-wide build contract",
    runId: "coding-room-repository-wide",
  });

  assertRoomContract(plan);
  const validation = plan.tasks.find((task) => task.capability === "validate");
  assert.ok(validation);
  assert.doesNotMatch(validation.objective, /coding::room\.post-update/u);
  assert.doesNotMatch(validation.objective, /model-authored room narrative/u);
  const certification = plan.tasks.find((task) => task.capability === "certify");
  assert.ok(certification);
  assert.match(certification.objective, /coding::room\.post-update/u);
});

test("Coding human continuation keeps room contracts without reopening model resolution", () => {
  const plan = previewCodingAgentGraph({
    ...selection,
    humanResolution: {
      status: "resolved",
      summary: "The human selected the bounded public contract.",
      decisions: [{
        subjectId: "public-contract",
        resolution: "Keep the existing public shape.",
        rationale: "The human supplied the missing product decision.",
        evidence: ["conversation-message:human-answer"],
      }],
      unresolved: [],
    },
    objective: "Apply the resolved public contract",
    runId: "coding-room-human-continuation",
  });

  assertRoomContract(plan);
  assert.equal(plan.tasks.some((task) => task.capability === "propose"), false);
  assert.equal(plan.tasks.some((task) => task.capability === "respond"), false);
  assert.equal(plan.tasks.some((task) => task.capability === "resolve"), false);
  assert.ok(plan.tasks.some((task) => task.capability === "implement"));
  assert.ok(plan.tasks.some((task) => task.capability === "certify"));
});
