import assert from "node:assert/strict";
import test from "node:test";

import { hashCanonical } from "../../src/core/canonical.ts";
import {
  InMemoryDataReferenceStore,
} from "../../src/engine/dataflow/data-reference-store.ts";
import {
  InMemoryTaskGraphControl,
} from "../../src/engine/orchestration/task-graph-control.ts";
import {
  createAcceptedTaskOutcome,
  createDynamicTaskDefinition,
} from "../../src/engine/orchestration/task-graph.ts";
import type { TaskGraphControlSnapshot } from "../../src/engine/orchestration/task-graph-control.ts";
import {
  codingAcceptedOutputForTask,
  codingAcceptedOutputSharedArtifactId,
  codingAcceptedOutputValues,
  projectCodingAcceptedOutputs,
  projectCodingAcceptedOutputsForRoots,
  validateCodingAcceptedOutputProjection,
} from "../../src/domains/coding-accepted-outputs.ts";
import {
  admitCodingAutonomousImprovement,
  type CodingAutonomousImprovementAdmission,
} from "../../src/domains/coding-improvements.ts";

const policy = {
  maxTasks: 4,
  maxDepth: 2,
  maxFanout: 2,
  maxInflight: 2,
  maxReady: 4,
  maxBlocked: 4,
  maxAttempts: 2,
  maxContextBytes: 10_000,
  maxCostMicros: 10_000,
  maxTokens: 10_000,
  maxWallTimeMs: 10_000,
} as const;

const acceptedFixture = async () => {
  const runId = "coding-projection";
  const taskId = "propose-api";
  const nodeId = "api";
  const outputKey = "collaboration_proposal_api";
  const value = {
    [outputKey]: {
      status: "proposal",
      summary: "Expose accepted outputs.",
      recommendations: [{
        subjectId: "read-model",
        recommendation: "Join accepted metadata to immutable bodies.",
        rationale: "Receipts intentionally omit bodies.",
        evidence: ["durable outcome"],
        confidence: 1,
      }],
      questions: [],
    },
  } as const;
  const store = new InMemoryDataReferenceStore();
  const reference = await store.put({
    value,
    mediaType: "application/json",
    storage: "artifact",
    artifactId: "accepted-body",
  });
  const definition = createDynamicTaskDefinition({
    taskId,
    semanticKey: taskId,
    nodeId,
    capability: "propose",
    objective: "Propose the API read model",
    handler: { kind: "test", version: "1" },
    acceptance: { policyId: "test", policyVersion: "1" },
    result: { mode: "json", outputKey, schema: true },
    dependencies: [],
    join: { kind: "all-success" },
    inputs: {
      inputVersions: {},
      dataReferences: [],
      frontierVersion: "frontier-1",
      topologyVersion: "topology-1",
      catalogVersion: "catalog-1",
    },
    runtimeBindingEpoch: 1,
    retry: { maxAttempts: 1, initialBackoffMs: 1, maximumBackoffMs: 1 },
    timeoutMs: 1_000,
    sideEffect: "pure",
    estimatedCostMicros: 0,
  });
  const artifact = {
    artifactId: "artifact-proposal",
    outputKey,
    kind: "json",
    contentHash: hashCanonical(value),
    mediaType: reference.mediaType,
    byteLength: reference.byteLength,
    storage: "artifact",
  } as const;
  const outcome = createAcceptedTaskOutcome({
    runId,
    taskId,
    nodeId,
    attempt: 1,
    definitionHash: definition.definitionHash,
    inputVersions: {},
    frontierVersion: "frontier-1",
    topologyVersion: "topology-1",
    catalogVersion: "catalog-1",
    acceptancePolicyId: "test",
    acceptancePolicyVersion: "1",
    artifacts: [artifact],
  });
  const snapshot: TaskGraphControlSnapshot = {
    runId,
    policy,
    tasks: [{
      definition,
      status: "accepted",
      attempt: 1,
      leaseFence: 1,
      outcome,
    }],
    expansions: [],
    acceptedCostMicros: 0,
    acceptedTokens: 0,
    outcomeDataReferences: [{
      taskId,
      outcomeId: outcome.outcomeId,
      artifactId: artifact.artifactId,
      outputKey,
      reference,
    }],
  };
  return { store, snapshot, outputKey };
};

const acceptedPeerProjectionFixture = async (
  taskIds: ReadonlyArray<"consult_data" | "consult_security">,
  outputKey = "peer_response",
) => {
  const runId = "coding-peer-projection";
  const store = new InMemoryDataReferenceStore();
  const tasks: TaskGraphControlSnapshot["tasks"][number][] = [];
  const outcomeDataReferences: TaskGraphControlSnapshot["outcomeDataReferences"][number][] = [];
  for (const taskId of taskIds) {
    const nodeId = taskId === "consult_data" ? "data" : "security";
    const value = { [outputKey]: { taskId, answer: `accepted answer from ${taskId}` } };
    const reference = await store.put({
      value,
      mediaType: "application/json",
      storage: "artifact",
      artifactId: `body-${taskId}`,
    });
    const definition = createDynamicTaskDefinition({
      taskId,
      semanticKey: `peer:${taskId}`,
      nodeId,
      capability: "respond",
      objective: `Respond as ${taskId}`,
      handler: { kind: "test", version: "1" },
      acceptance: { policyId: "test", policyVersion: "1" },
      result: { mode: "json", outputKey, schema: true },
      dependencies: [],
      join: { kind: "all-success" },
      inputs: {
        inputVersions: {},
        dataReferences: [],
        frontierVersion: "frontier-peer",
        topologyVersion: "topology-peer",
        catalogVersion: "catalog-peer",
      },
      runtimeBindingEpoch: 1,
      retry: { maxAttempts: 1, initialBackoffMs: 1, maximumBackoffMs: 1 },
      timeoutMs: 1_000,
      sideEffect: "pure",
      estimatedCostMicros: 0,
    });
    const artifact = {
      artifactId: `artifact-${taskId}`,
      outputKey,
      kind: "json",
      contentHash: hashCanonical(value),
      mediaType: reference.mediaType,
      byteLength: reference.byteLength,
      storage: "artifact",
    } as const;
    const outcome = createAcceptedTaskOutcome({
      runId,
      taskId,
      nodeId,
      attempt: 1,
      definitionHash: definition.definitionHash,
      inputVersions: {},
      frontierVersion: "frontier-peer",
      topologyVersion: "topology-peer",
      catalogVersion: "catalog-peer",
      acceptancePolicyId: "test",
      acceptancePolicyVersion: "1",
      artifacts: [artifact],
    });
    tasks.push({ definition, status: "accepted", attempt: 1, leaseFence: 1, outcome });
    outcomeDataReferences.push({
      taskId,
      outcomeId: outcome.outcomeId,
      artifactId: artifact.artifactId,
      outputKey,
      reference,
    });
  }
  const snapshot: TaskGraphControlSnapshot = {
    runId,
    policy: { ...policy, maxTasks: 4 },
    tasks,
    expansions: [],
    acceptedCostMicros: 0,
    acceptedTokens: 0,
    outcomeDataReferences,
  };
  return projectCodingAcceptedOutputs(snapshot, store);
};

const acceptedContinuationFrontierFixture = async () => {
  const runId = "coding-accepted-continuation";
  const graphPolicy = {
    ...policy,
    maxTasks: 12,
    maxDepth: 8,
    maxFanout: 4,
    maxInflight: 4,
    maxReady: 12,
    maxBlocked: 12,
  } as const;
  const inputs = {
    inputVersions: {},
    dataReferences: [],
    frontierVersion: "frontier-continuation",
    topologyVersion: "topology-continuation",
    catalogVersion: "catalog-continuation",
  } as const;
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
    objective: `Produce ${input.outputKey}`,
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
    nodeId: "implementation",
    capability: "implement",
    outputKey: "implementation_report",
  });
  const review = definition({
    taskId: "review-implementation",
    nodeId: "quality",
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
  await control.initialize({
    runId,
    policy: graphPolicy,
    seedTasks: [implement, review, reviewGate],
  });

  const expand = async (
    parentTaskId: string,
    definitions: ReadonlyArray<ReturnType<typeof definition>>,
    continuationTaskId: string,
  ) => {
    const lease = await control.claim({ taskId: parentTaskId, owner: `owner-${parentTaskId}` });
    assert.ok(lease, `${parentTaskId} should be ready to expand`);
    await control.start(lease);
    return control.expand({
      parentTaskId,
      fence: lease.fence,
      owner: lease.owner,
      expansionKey: `expand-${parentTaskId}`,
      definitions,
      continuationTaskId,
    });
  };
  const consultation = definition({
    taskId: "consult_security",
    nodeId: "security",
    capability: "respond",
    outputKey: "peer_response",
    parentTaskId: implement.taskId,
  });
  const dataConsultation = definition({
    taskId: "consult_data",
    nodeId: "data",
    capability: "respond",
    outputKey: "peer_response",
    parentTaskId: implement.taskId,
  });
  const implementContinuation = definition({
    taskId: "continue_implementation",
    nodeId: "implementation",
    capability: "implement",
    outputKey: "implementation_report",
    dependencies: [consultation.taskId, dataConsultation.taskId],
    parentTaskId: implement.taskId,
  });
  await expand(
    implement.taskId,
    [consultation, dataConsultation, implementContinuation],
    implementContinuation.taskId,
  );

  const store = new InMemoryDataReferenceStore();
  const accepted = new Map<string, {
    readonly outcomeId: string;
    readonly artifactId: string;
    readonly outputKey: string;
  }>();
  const accept = async (taskId: string, value: Readonly<Record<string, unknown>>) => {
    const lease = await control.claim({ taskId, owner: `owner-${taskId}` });
    assert.ok(lease, `${taskId} should be ready to accept`);
    await control.start(lease);
    const task = (await control.snapshot()).tasks.find((candidate) =>
      candidate.definition.taskId === taskId)?.definition;
    assert.ok(task && task.result.mode !== "none");
    const outputKey = task.result.outputKey;
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
    const outcome = createAcceptedTaskOutcome({
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
    });
    await control.accept({
      lease,
      outcome,
      dataReferences: [{ artifactId, reference }],
    });
    accepted.set(taskId, { outcomeId: outcome.outcomeId, artifactId, outputKey });
  };

  await accept(consultation.taskId, { answer: "Keep the runtime fence." });
  await accept(dataConsultation.taskId, { answer: "Keep both accepted peer contributions." });
  await accept(implementContinuation.taskId, { status: "verified" });
  await accept(review.taskId, { verdict: "approve" });

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
    nodeId: "quality",
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
  await accept(finalReport.taskId, {
    status: "verified",
    summary: "Accepted exact implementation.",
    improvementCandidate: {
      artifactType: "prompt_patch",
      target: "coding.prompt",
      patch: { instructions: ["Preserve every accepted peer contribution."] },
      rationale: "Multiple required peer responses share one durable output key.",
      evidence: ["the terminal continuation fixture accepted both responses"],
    },
  });
  await accept(certification.taskId, { verdict: "approve", frontierHash: "frontier-exact" });
  await accept(finalizer.taskId, { status: "completed", outputKeys: ["final_report"] });

  const skippedReference = await store.put({
    value: { implementation_report: { status: "stale" } },
    mediaType: "application/json",
    storage: "artifact",
    artifactId: "body-skipped-implement",
  });
  const snapshot = await control.snapshot();
  return {
    runId,
    store,
    accepted,
    snapshot: {
      ...snapshot,
      outcomeDataReferences: [...snapshot.outcomeDataReferences, {
        taskId: implement.taskId,
        outcomeId: "outcome-skipped-implement",
        artifactId: "artifact-skipped-implement",
        outputKey: "implementation_report",
        reference: skippedReference,
      }],
    } satisfies TaskGraphControlSnapshot,
  };
};

test("accepted coding outputs rehydrate only the exact durable acceptance chain", async () => {
  const fixture = await acceptedFixture();
  const projection = await projectCodingAcceptedOutputs(fixture.snapshot, fixture.store);
  assert.equal(projection.outputs.length, 1);
  assert.equal(projection.omittedCount, 0);
  assert.equal(projection.outputs[0]?.taskId, "propose-api");
  assert.deepEqual(
    JSON.parse(codingAcceptedOutputValues(projection)[fixture.outputKey] ?? ""),
    {
      status: "proposal",
      summary: "Expose accepted outputs.",
      recommendations: [{
        subjectId: "read-model",
        recommendation: "Join accepted metadata to immutable bodies.",
        rationale: "Receipts intentionally omit bodies.",
        evidence: ["durable outcome"],
        confidence: 1,
      }],
      questions: [],
    },
  );
});

test("accepted coding outputs follow durable continuation supersession without re-admitting skipped work", async () => {
  const fixture = await acceptedContinuationFrontierFixture();
  const projection = await projectCodingAcceptedOutputs(fixture.snapshot, fixture.store);
  const byTaskId = Object.fromEntries(projection.outputs.map((output) => [output.taskId, output]));

  assert.deepEqual(Object.keys(byTaskId).sort(), [
    "accept-implementation",
    "certify-quality",
    "coding-finalize",
    "consult_data",
    "consult_security",
    "continue_implementation",
    "review-implementation",
  ]);
  assert.equal(byTaskId.implement, undefined, "the skipped original task must not re-enter acceptance");
  for (const taskId of Object.keys(byTaskId)) {
    assert.deepEqual(
      {
        outcomeId: byTaskId[taskId]?.outcomeId,
        artifactId: byTaskId[taskId]?.artifactId,
        outputKey: byTaskId[taskId]?.outputKey,
      },
      fixture.accepted.get(taskId),
      `${taskId} must retain its exact accepted identity`,
    );
  }
  const callerProjection = validateCodingAcceptedOutputProjection(projection, fixture.runId);
  const peerResponses = callerProjection.outputs.filter((output) => output.outputKey === "peer_response");
  assert.equal(peerResponses.length, 2);
  assert.deepEqual(
    peerResponses.map((output) => output.projectionKey).sort(),
    [
      "accepted-output/12:consult_data/13:peer_response",
      "accepted-output/16:consult_security/13:peer_response",
    ],
  );
  const values = codingAcceptedOutputValues(callerProjection);
  assert.deepEqual(
    peerResponses.map((output) => JSON.parse(values[output.projectionKey] ?? "")),
    peerResponses.map((output) => JSON.parse(output.value)),
  );
  assert.deepEqual(
    JSON.parse(values.peer_response ?? "").map((entry: { taskId: string }) => entry.taskId),
    ["consult_data", "consult_security"],
    "the semantic key must aggregate every contribution in task identity order",
  );
  assert.equal(JSON.parse(values.final_report ?? "").status, "verified");
  let admission: CodingAutonomousImprovementAdmission | undefined;
  assert.equal(await admitCodingAutonomousImprovement(callerProjection, async (input) => {
    admission = input;
  }), true);
  assert.deepEqual(admission?.source, {
    kind: "coding-certified-output",
    actorId: `coding:${byTaskId["accept-implementation"]!.nodeId}`,
    runId: fixture.runId,
    taskId: "accept-implementation",
    nodeId: byTaskId["accept-implementation"]!.nodeId,
    outcomeId: byTaskId["accept-implementation"]!.outcomeId,
    artifactId: byTaskId["accept-implementation"]!.artifactId,
    contentHash: byTaskId["accept-implementation"]!.contentHash,
  }, "the autonomous admission seam must retain the exact accepted final artifact identity");
});

test("finalizer inputs use only exact task-scoped outputs on the validated effective continuation frontier", async () => {
  const fixture = await acceptedContinuationFrontierFixture();
  const projection = await projectCodingAcceptedOutputsForRoots(
    fixture.snapshot,
    fixture.store,
    ["accept-implementation", "certify-quality"],
  );
  assert.deepEqual(projection.outputs.map((output) => output.taskId).sort(), [
    "accept-implementation",
    "certify-quality",
    "consult_data",
    "consult_security",
    "continue_implementation",
  ]);
  assert.equal(
    JSON.parse(codingAcceptedOutputForTask(
      projection,
      "accept-implementation",
      "final_report",
    )).summary,
    "Accepted exact implementation.",
  );
  assert.equal(
    JSON.parse(codingAcceptedOutputForTask(
      projection,
      "consult_data",
      "peer_response",
    )).answer,
    "Keep both accepted peer contributions.",
  );
  assert.throws(
    () => codingAcceptedOutputForTask(projection, "consult_data", "final_report"),
    /missing exact accepted output/u,
  );
  assert.throws(
    () => codingAcceptedOutputForTask({
      outputs: [projection.outputs[0]!, projection.outputs[0]!],
      omittedCount: 0,
    }, projection.outputs[0]!.taskId, projection.outputs[0]!.outputKey),
    /ambiguous exact accepted output/u,
  );
});

test("accepted coding continuation frontiers fail closed without exact durable supersession", async () => {
  const fixture = await acceptedContinuationFrontierFixture();
  const implement = fixture.snapshot.tasks.find((task) => task.definition.taskId === "implement")!;
  const continuation = fixture.snapshot.tasks.find((task) =>
    task.definition.taskId === "continue_implementation")!;
  const review = fixture.snapshot.tasks.find((task) =>
    task.definition.taskId === "review-implementation")!;

  await assert.rejects(
    projectCodingAcceptedOutputs({ ...fixture.snapshot, expansions: [] }, fixture.store),
    /durable continuation|non-accepted task implement/,
  );
  await assert.rejects(
    projectCodingAcceptedOutputs({
      ...fixture.snapshot,
      tasks: fixture.snapshot.tasks.filter((task) => task !== continuation),
    }, fixture.store),
    /continuation|non-accepted task implement|child identity/,
  );
  for (const status of ["failed", "canceled", "skipped"] as const) {
    await assert.rejects(
      projectCodingAcceptedOutputs({
        ...fixture.snapshot,
        tasks: fixture.snapshot.tasks.map((task) => task === continuation
          ? { ...task, status }
          : task),
      }, fixture.store),
      /non-accepted task continue_implementation|continuation/,
    );
    await assert.rejects(
      projectCodingAcceptedOutputs({
        ...fixture.snapshot,
        tasks: fixture.snapshot.tasks.map((task) => task === review
          ? { ...task, status }
          : task),
      }, fixture.store),
      /non-accepted task review-implementation|continuation/,
    );
  }
  await assert.rejects(
    projectCodingAcceptedOutputs({
      ...fixture.snapshot,
      tasks: fixture.snapshot.tasks.map((task) => task === implement
        ? { ...task, continuationTaskId: "continue_changed" }
        : task),
    }, fixture.store),
    /continuation|retired parent admission/,
  );
  await assert.rejects(
    projectCodingAcceptedOutputs({
      ...fixture.snapshot,
      tasks: fixture.snapshot.tasks.map((task) => task === implement
        ? { ...task, status: "canceled", error: "execution budget exhausted" }
        : task),
    }, fixture.store),
    /invalid continuation|non-accepted task implement/,
    "structural cancellation replay must not authorize Coding accepted supersession",
  );
  await assert.rejects(
    projectCodingAcceptedOutputs({
      ...fixture.snapshot,
      expansions: fixture.snapshot.expansions.map((entry) => entry.parentTaskId === "implement"
        ? { ...entry, expansionHash: "changed" }
        : entry),
    }, fixture.store),
    /invalid hash/,
  );
  await assert.rejects(
    projectCodingAcceptedOutputs({
      ...fixture.snapshot,
      expansions: [...fixture.snapshot.expansions, {
        ...fixture.snapshot.expansions.find((entry) => entry.parentTaskId === "implement")!,
        expansionKey: "ambiguous-implement-expansion",
      }],
    }, fixture.store),
    /ambiguous|multiple|continuation/,
  );
});

test("accepted coding output projection fails closed on mismatched authority", async () => {
  const fixture = await acceptedFixture();
  const entry = fixture.snapshot.outcomeDataReferences[0]!;
  await assert.rejects(
    projectCodingAcceptedOutputs({
      ...fixture.snapshot,
      outcomeDataReferences: [{
        ...entry,
        outcomeId: "task_outcome_changed",
      }],
    }, fixture.store),
    /no durable reference|changed acceptance identity/,
  );
  await assert.rejects(
    projectCodingAcceptedOutputs({
      ...fixture.snapshot,
      outcomeDataReferences: [{
        ...entry,
        reference: { ...entry.reference, contentHash: "changed" },
      }],
    }, fixture.store),
    /changed artifact metadata/,
  );
  await assert.rejects(
    projectCodingAcceptedOutputs({
      ...fixture.snapshot,
      outcomeDataReferences: [],
    }, fixture.store),
    /has no durable reference/,
  );
});

test("accepted coding output projection validates every body before deterministic bounds", async () => {
  const fixture = await acceptedFixture();
  await assert.rejects(
    projectCodingAcceptedOutputs(fixture.snapshot, fixture.store, {
      maxOutputs: 1,
      maxValueBytes: 1,
    }),
    /exceeds maxValueBytes=1/,
  );

  const unavailableStore = new InMemoryDataReferenceStore();
  await assert.rejects(
    projectCodingAcceptedOutputs(fixture.snapshot, unavailableStore, {
      maxOutputs: 1,
      maxValueBytes: 1,
    }),
    /unavailable or changed/,
  );
  await assert.rejects(
    projectCodingAcceptedOutputs(fixture.snapshot, fixture.store, {
      maxReadBytes: 1,
    }),
    /exceeds maxReadBytes=1/,
  );
});

test("accepted coding output values reject forged duplicate projection identities", async () => {
  const fixture = await acceptedFixture();
  const projection = await projectCodingAcceptedOutputs(fixture.snapshot, fixture.store);
  assert.throws(
    () => codingAcceptedOutputValues({
      outputs: [projection.outputs[0]!, {
        ...projection.outputs[0]!,
        taskId: "follow-up",
        outcomeId: "follow-up-outcome",
        artifactId: "follow-up-artifact",
      }],
    }),
    /is ambiguous/,
  );
});

test("accepted projection identity is permanent across sibling arrival and delivery order", async () => {
  const singleton = await acceptedPeerProjectionFixture(["consult_data"]);
  const forward = await acceptedPeerProjectionFixture(["consult_data", "consult_security"]);
  const reversed = await acceptedPeerProjectionFixture(["consult_security", "consult_data"]);
  const singletonData = singleton.outputs.find((output) => output.taskId === "consult_data")!;
  const forwardData = forward.outputs.find((output) => output.taskId === "consult_data")!;
  const reversedData = reversed.outputs.find((output) => output.taskId === "consult_data")!;
  const expectedDataKey = "accepted-output/12:consult_data/13:peer_response";

  assert.equal(singletonData.projectionKey, expectedDataKey);
  assert.equal(forwardData.projectionKey, singletonData.projectionKey);
  assert.equal(reversedData.projectionKey, singletonData.projectionKey);
  assert.equal(
    codingAcceptedOutputSharedArtifactId(singletonData),
    codingAcceptedOutputSharedArtifactId(forwardData),
  );
  assert.deepEqual(forward, reversed, "accepted projection order must not follow delivery order");

  const singletonValues = codingAcceptedOutputValues(singleton);
  assert.equal(singletonValues.peer_response, singletonData.value);
  assert.equal(singletonValues[expectedDataKey], singletonData.value);
  const forwardValues = codingAcceptedOutputValues(forward);
  assert.equal(forwardValues[expectedDataKey], forwardData.value);
  assert.deepEqual(
    JSON.parse(forwardValues.peer_response ?? "").map((entry: { taskId: string }) => entry.taskId),
    ["consult_data", "consult_security"],
  );
});

test("singleton raw aliases cannot collide with the scoped projection namespace", async () => {
  const rawOutputKey = "accepted-output:12:consult_data:13:peer_response";
  const projection = await acceptedPeerProjectionFixture(["consult_data"], rawOutputKey);
  const output = projection.outputs[0]!;
  const values = codingAcceptedOutputValues(projection);

  assert.equal(output.outputKey, rawOutputKey);
  assert.equal(output.projectionKey, `accepted-output/12:consult_data/${rawOutputKey.length}:${rawOutputKey}`);
  assert.notEqual(output.projectionKey, rawOutputKey);
  assert.equal(values[rawOutputKey], output.value);
  assert.equal(values[output.projectionKey], output.value);
});

test("accepted coding continuation frontier rejects accepted dependency cycles", async () => {
  const fixture = await acceptedFixture();
  const original = fixture.snapshot.tasks[0]!;
  const originalOutcome = original.outcome!;
  const originalArtifact = originalOutcome.artifacts[0]!;
  const makeCycleTask = (taskId: string, dependencyTaskId: string, outputKey: string) => {
    const { definitionHash: _definitionHash, schemaVersion: _schemaVersion, ...definitionInput } = original.definition;
    const definition = createDynamicTaskDefinition({
      ...definitionInput,
      taskId,
      semanticKey: taskId,
      result: { mode: "json", outputKey, schema: true },
      dependencies: [{ taskId: dependencyTaskId, condition: "accepted" }],
    });
    const artifact = { ...originalArtifact, artifactId: `artifact-${taskId}`, outputKey };
    const outcome = {
      ...originalOutcome,
      taskId,
      outcomeId: `outcome-${taskId}`,
      definitionHash: definition.definitionHash,
      artifacts: [artifact],
    };
    return { definition, status: "accepted" as const, attempt: 1, leaseFence: 1, outcome };
  };
  const left = makeCycleTask("cycle-left", "cycle-right", "cycle_left");
  const right = makeCycleTask("cycle-right", "cycle-left", "cycle_right");
  const originalReference = fixture.snapshot.outcomeDataReferences[0]!;
  await assert.rejects(
    projectCodingAcceptedOutputs({
      ...fixture.snapshot,
      tasks: [left, right],
      outcomeDataReferences: [left, right].map((task) => ({
        ...originalReference,
        taskId: task.definition.taskId,
        outcomeId: task.outcome.outcomeId,
        artifactId: task.outcome.artifacts[0]!.artifactId,
        outputKey: task.outcome.artifacts[0]!.outputKey,
      })),
    }, fixture.store),
    /accepted dependency cycle/,
  );
});

test("accepted output view projection rejects cross-run, duplicate, and unbounded adapter results", async () => {
  const fixture = await acceptedFixture();
  const projection = await projectCodingAcceptedOutputs(fixture.snapshot, fixture.store);
  const output = projection.outputs[0]!;

  assert.equal(validateCodingAcceptedOutputProjection(projection, fixture.snapshot.runId), projection);
  assert.throws(
    () => validateCodingAcceptedOutputProjection({
      outputs: [{ ...output, runId: "another-run" }],
      omittedCount: 0,
    }, fixture.snapshot.runId),
    /belongs to another run/,
  );
  assert.throws(
    () => validateCodingAcceptedOutputProjection({
      outputs: [output, {
        ...output,
        artifactId: "another-artifact",
      }],
      omittedCount: 0,
    }, fixture.snapshot.runId),
    /is ambiguous/,
  );
  assert.throws(
    () => validateCodingAcceptedOutputProjection({
      outputs: [output, {
        ...output,
        outputKey: "another-output",
        projectionKey: `accepted-output/${output.taskId.length}:${output.taskId}/14:another-output`,
      }],
      omittedCount: 0,
    }, fixture.snapshot.runId),
    /artifact .* is ambiguous/,
  );
  assert.throws(
    () => validateCodingAcceptedOutputProjection({
      outputs: [{ ...output, value: "x".repeat(512 * 1024 + 1) }],
      omittedCount: 0,
    }, fixture.snapshot.runId),
    /exceeds its value bound/,
  );
  assert.throws(
    () => validateCodingAcceptedOutputProjection({ outputs: [], omittedCount: -1 }, fixture.snapshot.runId),
    /invalid omitted count/,
  );
});
