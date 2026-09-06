import assert from "node:assert/strict";

import { hashCanonical } from "../../src/core/canonical.ts";
import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import { InMemoryTaskGraphControl } from "../../src/engine/orchestration/task-graph-control.ts";
import {
  createAcceptedTaskOutcome,
  createDynamicTaskDefinition,
} from "../../src/engine/orchestration/task-graph.ts";

const policy = {
  maxTasks: 16,
  maxDepth: 8,
  maxFanout: 5,
  maxInflight: 4,
  maxReady: 16,
  maxBlocked: 16,
  maxAttempts: 2,
  maxContextBytes: 10_000,
  maxCostMicros: 10_000,
  maxTokens: 10_000,
  maxWallTimeMs: 10_000,
} as const;

/** Real control-plane fixture for skipped parent -> multi-peer continuation -> certified finalizer. */
export const codingAcceptedContinuationFixture = async () => {
  const runId = "coding-route-continuation-execution";
  const inputs = {
    inputVersions: {},
    dataReferences: [],
    frontierVersion: "frontier-route-continuation",
    topologyVersion: "topology-route-continuation",
    catalogVersion: "catalog-route-continuation",
  } as const;
  const acceptedTurns: Array<{
    readonly artifactId: string;
    readonly taskId: string;
    readonly nodeId: string;
    readonly body: string;
  }> = [];
  const definition = (input: {
    readonly taskId: string;
    readonly nodeId: string;
    readonly capability: string;
    readonly outputKey: string;
    readonly dependencies?: ReadonlyArray<string>;
    readonly parentTaskId?: string;
  }) => createDynamicTaskDefinition({
    taskId: input.taskId,
    semanticKey: `coding:${runId}:${input.taskId}`,
    nodeId: input.nodeId,
    capability: input.capability,
    objective: `Privately produce ${input.outputKey}; inspect with git --no-pager diff --cached --binary --full-index HEAD -- and stage with git add -A -- .`,
    handler: { kind: "test", version: "1" },
    acceptance: { policyId: "test", policyVersion: "1" },
    result: { mode: "json", outputKey: input.outputKey, schema: true },
    dependencies: (input.dependencies ?? []).map((taskId) => ({
      taskId,
      condition: "accepted" as const,
    })),
    join: { kind: "all-success" },
    inputs,
    runtimeBindingEpoch: 1,
    retry: { maxAttempts: 1, initialBackoffMs: 1, maximumBackoffMs: 1 },
    timeoutMs: 1_000,
    sideEffect: "pure",
    estimatedCostMicros: 0,
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
  });
  const implement = definition({
    taskId: "implement",
    nodeId: "workspace.implementation",
    capability: "implement",
    outputKey: "implementation_report",
  });
  const review = definition({
    taskId: "review-implementation",
    nodeId: "workspace.quality",
    capability: "review",
    outputKey: "review_report",
    dependencies: [implement.taskId],
  });
  const reviewGate = definition({
    taskId: "coding-review-gate",
    nodeId: "coordinator",
    capability: "coordinate",
    outputKey: "review_gate_result",
    dependencies: [implement.taskId, review.taskId],
  });
  const control = new InMemoryTaskGraphControl();
  await control.initialize({ runId, policy, seedTasks: [implement, review, reviewGate] });
  const store = new InMemoryDataReferenceStore();

  const expand = async (
    parentTaskId: string,
    definitions: ReadonlyArray<ReturnType<typeof definition>>,
    continuationTaskId: string,
  ) => {
    const lease = await control.claim({ taskId: parentTaskId, owner: `owner-${parentTaskId}` });
    assert.ok(lease);
    await control.start(lease);
    await control.expand({
      parentTaskId,
      fence: lease.fence,
      owner: lease.owner,
      expansionKey: `expand-${parentTaskId}`,
      definitions,
      continuationTaskId,
    });
  };
  const accept = async (taskId: string, value: Readonly<Record<string, unknown>>) => {
    const lease = await control.claim({ taskId, owner: `owner-${taskId}` });
    assert.ok(lease, `${taskId} should be ready`);
    await control.start(lease);
    const task = (await control.snapshot()).tasks.find((candidate) =>
      candidate.definition.taskId === taskId)!.definition;
    assert.notEqual(task.result.mode, "none");
    const outputKey = task.result.mode === "none" ? "unreachable" : task.result.outputKey;
    const body = { [outputKey]: value };
    const artifactId = `artifact-${taskId}`;
    const reference = await store.put({
      value: body,
      mediaType: "application/json",
      storage: "artifact",
      artifactId: `body-${taskId}`,
    });
    const artifact = {
      artifactId,
      outputKey,
      kind: "json",
      contentHash: hashCanonical(body),
      mediaType: reference.mediaType,
      byteLength: reference.byteLength,
      storage: "artifact",
    } as const;
    await control.accept({
      lease,
      outcome: createAcceptedTaskOutcome({
        runId,
        taskId,
        nodeId: task.nodeId,
        attempt: lease.attempt,
        definitionHash: task.definitionHash,
        inputVersions: task.inputs.inputVersions,
        frontierVersion: task.inputs.frontierVersion,
        topologyVersion: task.inputs.topologyVersion,
        catalogVersion: task.inputs.catalogVersion,
        acceptancePolicyId: task.acceptance.policyId,
        acceptancePolicyVersion: task.acceptance.policyVersion,
        artifacts: [artifact],
      }),
      dataReferences: [{ artifactId, reference }],
    });
    const summary = typeof value.summary === "string" ? value.summary : undefined;
    if (summary) acceptedTurns.push({
      artifactId,
      taskId,
      nodeId: task.nodeId,
      body: summary,
    });
  };

  const security = definition({
    taskId: "consult_security",
    nodeId: "workspace.security",
    capability: "respond",
    outputKey: "peer_response",
    parentTaskId: implement.taskId,
  });
  const data = definition({
    taskId: "consult_data",
    nodeId: "workspace.data",
    capability: "respond",
    outputKey: "peer_response",
    parentTaskId: implement.taskId,
  });
  const continuation = definition({
    taskId: "continue_implementation",
    nodeId: "workspace.implementation",
    capability: "implement",
    outputKey: "implementation_report",
    dependencies: [security.taskId, data.taskId],
    parentTaskId: implement.taskId,
  });
  await expand(implement.taskId, [security, data, continuation], continuation.taskId);
  await accept(security.taskId, {
    status: "response",
    summary: "Keep the lease fence exact.",
    answers: [{
      subjectId: "frontier",
      response: "Validate the retired parent fence.",
      rationale: "A stale expansion cannot prove supersession.",
      evidence: ["published fence"],
      confidence: 1,
    }],
    openQuestions: [],
  });
  await accept(data.taskId, {
    status: "response",
    summary: "Preserve both peer contributions.",
    answers: [{
      subjectId: "projection",
      response: "Use distinct stable projection identities.",
      rationale: "Both required recipients authored accepted evidence.",
      evidence: ["responseRequirement all"],
      confidence: 1,
    }],
    openQuestions: [],
  });
  await accept(continuation.taskId, {
    status: "verified",
    summary: "The continued implementation preserved both accepted peer frontiers.",
  });
  await accept(review.taskId, {
    verdict: "approve",
    summary: "Independent review accepted the continued implementation.",
  });

  const finalReport = definition({
    taskId: "accept-implementation",
    nodeId: "coordinator",
    capability: "coordinate",
    outputKey: "final_report",
    dependencies: [implement.taskId],
    parentTaskId: reviewGate.taskId,
  });
  const certification = definition({
    taskId: "certify-quality",
    nodeId: "workspace.quality",
    capability: "certify",
    outputKey: "collaboration_endorsement_quality",
    dependencies: [finalReport.taskId],
    parentTaskId: reviewGate.taskId,
  });
  const finalizer = definition({
    taskId: "coding-finalize",
    nodeId: "coordinator",
    capability: "coordinate",
    outputKey: "coding_result",
    dependencies: [finalReport.taskId, certification.taskId],
    parentTaskId: reviewGate.taskId,
  });
  await expand(reviewGate.taskId, [finalReport, certification, finalizer], finalizer.taskId);
  await accept(finalReport.taskId, { status: "verified", summary: "Accepted exact implementation." });
  await accept(certification.taskId, {
    verdict: "approve",
    frontierHash: "frontier-exact",
    summary: "Certification accepted the reviewed frontier.",
  });
  await accept(finalizer.taskId, {
    status: "completed",
    outputKeys: ["final_report"],
    summary: "Roster published the certified final result.",
  });

  const staleReference = await store.put({
    value: { implementation_report: { status: "stale" } },
    mediaType: "application/json",
    storage: "artifact",
    artifactId: "body-skipped-implement",
  });
  const snapshot = await control.snapshot();
  return {
    runId,
    store,
    acceptedTurns,
    snapshot: {
      ...snapshot,
      outcomeDataReferences: [...snapshot.outcomeDataReferences, {
        taskId: implement.taskId,
        outcomeId: "outcome-skipped-implement",
        artifactId: "artifact-skipped-implement",
        outputKey: "implementation_report",
        reference: staleReference,
      }],
    },
  };
};
