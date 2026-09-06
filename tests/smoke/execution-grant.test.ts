import assert from "node:assert/strict";
import test from "node:test";

import { hashCanonical } from "../../src/core/canonical.ts";
import { createDynamicTaskDefinition } from "../../src/engine/orchestration/task-graph.ts";
import {
  assertTaskExecutionGrant,
  assertTaskExecutionGrantTool,
  assertTaskExecutionGrantWorkspaceOperation,
  createTaskExecutionGrant,
  validateTaskExecutionGrant,
  type TaskExecutionGrant,
} from "../../src/engine/platform/execution-grant.ts";
import type {
  DynamicTaskDefinition,
  RunExecutionPolicy,
} from "../../src/engine/platform/protocol.ts";
import {
  createTaskContextManifest,
  validateTaskContextManifest,
} from "../../src/engine/platform/task-context-manifest.ts";

const POLICY: RunExecutionPolicy = {
  maxTasks: 8,
  maxDepth: 3,
  maxFanout: 4,
  maxInflight: 2,
  maxReady: 8,
  maxBlocked: 8,
  maxAttempts: 2,
  maxContextBytes: 1_000_000,
  maxCostMicros: 500_000,
  maxTokens: 64_000,
  maxWallTimeMs: 60_000,
};

const definition = (): DynamicTaskDefinition => createDynamicTaskDefinition({
  taskId: "implement",
  semanticKey: "grant:implement",
  nodeId: "coding-node",
  capability: "implement",
  objective: "Implement one bounded workspace change.",
  handler: { kind: "roster.node", version: "1" },
  acceptance: { policyId: "grant-test", policyVersion: "1" },
  result: { mode: "none" },
  dependencies: [],
  join: { kind: "all-success" },
  inputs: {
    inputVersions: { repository: "commit-a" },
    dataReferences: [],
    frontierVersion: "frontier-a",
    topologyVersion: "topology-a",
    catalogVersion: "catalog-a",
  },
  runtimeBindingEpoch: 7,
  retry: { maxAttempts: 2, initialBackoffMs: 0, maximumBackoffMs: 0 },
  timeoutMs: 30_000,
  sideEffect: "idempotent",
  estimatedCostMicros: 10_000,
});

const grant = (
  task = definition(),
  overrides: Partial<Parameters<typeof createTaskExecutionGrant>[0]> = {},
): TaskExecutionGrant => createTaskExecutionGrant({
  runId: "grant-run",
  definition: task,
  attempt: 2,
  fence: 9,
  policyVersion: "grant-policy.v1",
  policy: POLICY,
  functionAccess: {
    functionGrants: ["workspace::write", "workspace::read"],
    scopes: ["workspace:write", "workspace:read"],
    allowedEffects: ["write", "read"],
  },
  workspaceOperations: ["publish", "read"],
  skills: [
    { id: "testing", contentHash: "skill-testing" },
    { id: "implementation", contentHash: "skill-implementation" },
  ],
  tools: [
    { id: "workspace::write", version: "1", effects: ["write"] },
    { id: "workspace::read", version: "1", effects: ["read"] },
  ],
  codeMode: {
    maxFunctionCalls: 8,
    maxContextValues: 32,
    maxContextBytes: 1_000_000,
    maxValueBytes: 500_000,
    maxObservationBytes: 64_000,
    maxRequestBytes: 128_000,
  },
  maxFunctionCalls: 8,
  rationale: "The deterministic test policy admits this idempotent workspace write.",
  ...overrides,
});

test("execution grants are deterministic, normalized, and exact-content addressed", () => {
  const first = grant();
  const reordered = grant(definition(), {
    functionAccess: {
      functionGrants: ["workspace::read", "workspace::write"],
      scopes: ["workspace:read", "workspace:write"],
      allowedEffects: ["read", "write"],
    },
    workspaceOperations: ["read", "publish"],
    skills: [
      { id: "implementation", contentHash: "skill-implementation" },
      { id: "testing", contentHash: "skill-testing" },
    ],
    tools: [
      { id: "workspace::read", version: "1", effects: ["read"] },
      { id: "workspace::write", version: "1", effects: ["write"] },
    ],
  });

  assert.deepEqual(reordered, first);
  assert.equal(first.riskAssessment.riskClass, "workspace-write");
  assert.equal(validateTaskExecutionGrant(first).grantId, first.grantId);
  assert.equal(
    assertTaskExecutionGrantTool(first, "workspace::write").version,
    "1",
  );
  assert.doesNotThrow(() => assertTaskExecutionGrantWorkspaceOperation(first, "publish"));
});

test("execution grants reject nested tampering, stale fences, and ungranted effects", () => {
  const task = definition();
  const admitted = grant(task);
  const forged = {
    ...admitted,
    riskAssessment: {
      ...admitted.riskAssessment,
      assessmentId: `risk_${hashCanonical("forged").slice(0, 28)}`,
    },
  } as TaskExecutionGrant;

  assert.throws(
    () => validateTaskExecutionGrant(forged),
    /identity does not match its exact contents/,
  );
  assert.throws(
    () => assertTaskExecutionGrant({
      grant: admitted,
      runId: "grant-run",
      definition: task,
      attempt: 2,
      fence: 10,
    }),
    /does not match its exact execution fence/,
  );
  assert.throws(
    () => assertTaskExecutionGrantTool(admitted, "network::post"),
    /does not authorize tool network::post/,
  );
  const readOnly = grant(task, {
    functionAccess: { allowedEffects: ["read"] },
    workspaceOperations: ["read"],
    tools: [{ id: "workspace::read", version: "1", effects: ["read"] }],
  });
  assert.throws(
    () => assertTaskExecutionGrantWorkspaceOperation(readOnly, "publish"),
    /does not authorize workspace publish/,
  );
});

test("human admission requires exact authorization and denied decisions cannot mint grants", () => {
  assert.throws(
    () => grant(definition(), {
      admissionDecision: {
        disposition: "granted",
        authority: "runtime" as "human",
        reason: "A runtime cannot grant itself authority.",
      },
    }),
    /unsupported authority/,
  );
  assert.throws(
    () => grant(definition(), {
      admissionDecision: {
        disposition: "granted",
        authority: "human",
        reason: "Approved by an operator.",
      },
    }),
    /requires an exact authorizationId/,
  );
  assert.throws(
    () => grant(definition(), {
      admissionDecision: {
        disposition: "denied",
        authority: "deterministic-policy",
        reason: "External writes are disabled.",
      },
    }),
    /cannot create a grant from denied admission/,
  );
  assert.equal(grant(definition(), {
    admissionDecision: {
      disposition: "granted",
      authority: "human",
      authorizationId: "approval-42",
      reason: "Approved by an operator.",
    },
  }).admissionDecision.authorizationId, "approval-42");
});

test("task context identity durably includes the exact execution grant", () => {
  const task = definition();
  const admitted = grant(task);
  const manifest = createTaskContextManifest({
    runId: "grant-run",
    definition: task,
    attempt: 2,
    fence: 9,
    executionGrant: admitted,
  });

  assert.equal(manifest.executionGrant.grantId, admitted.grantId);
  assert.equal(validateTaskContextManifest(manifest).manifestId, manifest.manifestId);
  assert.throws(
    () => createTaskContextManifest({
      runId: "grant-run",
      definition: task,
      attempt: 2,
      fence: 10,
      executionGrant: admitted,
    }),
    /does not match its exact execution fence/,
  );
});
