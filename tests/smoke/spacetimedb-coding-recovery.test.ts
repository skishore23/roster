import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";

import {
  connectSpacetimeControlPlaneFromEnv,
  SpacetimeControlPlane,
} from "../../src/adapters/spacetimedb-control.ts";
import { createSpacetimeJobQueue } from "../../src/adapters/spacetimedb-job-queue.ts";
import { SpacetimeEventRepository } from "../../src/adapters/spacetimedb-runtime.ts";
import { receipt } from "../../src/core/chain.ts";
import { hashCanonical } from "../../src/core/canonical.ts";
import {
  createAcceptedTaskOutcome,
  createDynamicTaskDefinition,
} from "../../src/engine/orchestration/task-graph.ts";
import type {
  DynamicTaskDefinition,
  RunExecutionPolicy,
} from "../../src/engine/platform/protocol.ts";
import { createTaskExecutionGrant } from "../../src/engine/platform/execution-grant.ts";
import { createTaskContextManifest } from "../../src/engine/platform/task-context-manifest.ts";
import {
  codingConversationMessageEvent,
  createCodingConversationMessage,
} from "../../src/domains/coding-conversation.ts";
import { CODING_FINAL_ANSWER_OUTPUT, runCodingAgent } from "../../src/domains/coding.ts";
import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import { InMemoryTaskGraphControl } from "../../src/engine/orchestration/task-graph-control.ts";
import type { RosterPlatformExecutionOptions } from "../../src/engine/platform/roster-platform.ts";
import {
  NODE_EXECUTION_SCHEMA_VERSION,
  NodeRuntimeRegistry,
} from "../../src/engine/runtime/node-runtime.ts";
import { NodeRoomUpdateStore } from "../../src/engine/runtime/node-room-updates.ts";
import {
  createRosterTaskContext,
  SharedWorkspaceLedger,
} from "../../src/engine/workspace/shared-workspace.ts";
import { codingRunPresentation } from "../../src/browser/coding-presentation.ts";

const enabled = Boolean(process.env.SPACETIMEDB_URI && process.env.SPACETIMEDB_DATABASE);
const execFileAsync = promisify(execFile);

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const waitFor = async (predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(predicate(), true, message);
};

const executeActualFastCodingGraph = async (runId: string) => {
  const taskGraph = new InMemoryTaskGraphControl();
  const dataReferences = new InMemoryDataReferenceStore();
  const roomUpdates = new NodeRoomUpdateStore();
  const ledger = new SharedWorkspaceLedger(`coding-workspace-${runId}`);
  const createTaskContext: RosterPlatformExecutionOptions["createTaskContext"] = ({
    node,
    definition,
    lease,
  }) => createRosterTaskContext({
    node,
    ledger,
    fence: {
      runId,
      taskId: definition.taskId,
      nodeId: definition.nodeId,
      fence: BigInt(lease.fence),
      runtimeBindingEpoch: definition.runtimeBindingEpoch,
      frontierVersion: definition.inputs.frontierVersion,
      topologyVersion: definition.inputs.topologyVersion,
      catalogVersion: definition.inputs.catalogVersion,
      inputVersions: definition.inputs.inputVersions,
    },
    authority: {
      assertActive: async () => {
        const record = (await taskGraph.snapshot()).tasks.find((candidate) =>
          candidate.definition.taskId === definition.taskId);
        if (!record || (record.status !== "leased" && record.status !== "running")) {
          throw new Error(`Task ${definition.taskId} lost its execution fence`);
        }
      },
    },
  });
  const implementationNode = {
    id: "implementation",
    name: "Kai, Implementation Engineer",
    capabilities: ["implement"],
    runtime: { kind: "pi-agent" as const },
    metadata: {
      role: "worker",
      specialty: "implementation",
      repositoryReason: "Own the bounded implementation and its focused validation evidence.",
    },
  };
  return runCodingAgent({
    runId,
    objective: "Apply and validate the bounded fast-path change",
    workingDirectory: "/tmp/repository",
    workspaceNodes: [implementationNode],
    selectedNodeIds: [implementationNode.id],
    primaryNodeId: implementationNode.id,
    coordination: { reviewMode: "fast", validationScope: "focused" },
    workerRuntime: "pi-agent",
    taskGraph,
    dataReferences,
    createTaskContext,
    roomUpdates,
    nodeRuntimes: new NodeRuntimeRegistry([{
      kind: "pi-agent",
      executeEnvelope: async (envelope) => {
        const outputKey = envelope.resultContract.mode === "json"
          ? (envelope.resultContract.schema as { readonly required?: ReadonlyArray<string> }).required?.[0]
          : undefined;
        assert.ok(outputKey);
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: envelope.task.capability === "room" ? {
            [outputKey]: { summary: `Starting ${envelope.task.taskId.slice("announce-".length)}.` },
          } : envelope.task.capability === "synthesize" ? {
          [CODING_FINAL_ANSWER_OUTPUT]: {
            status: "completed",
            summary: "I implemented the fast-path change and validated its exact frontier.",
            frontierHash: "a".repeat(64),
          },
        } : {
          final_report: {
            status: "verified",
            summary: "I implemented the fast-path change and validated its exact frontier.",
            frontierHash: "a".repeat(64),
          },
          },
        };
      },
    }]),
  });
};

const recoveryPolicy: RunExecutionPolicy = {
  maxTasks: 8,
  maxDepth: 4,
  maxFanout: 4,
  maxInflight: 2,
  maxReady: 8,
  maxBlocked: 8,
  maxAttempts: 4,
  maxContextBytes: 1_000_000,
  maxCostMicros: 1_000_000,
  maxTokens: 1_000_000,
  maxWallTimeMs: 60_000,
};

const recoveryTask = (input: {
  readonly taskId: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly objective: string;
  readonly dependencies?: DynamicTaskDefinition["dependencies"];
}): DynamicTaskDefinition => createDynamicTaskDefinition({
  taskId: input.taskId,
  semanticKey: `coding.recovery:${input.taskId}`,
  nodeId: input.nodeId,
  capability: input.capability,
  objective: input.objective,
  handler: { kind: "coding.test", version: "v3" },
  acceptance: { policyId: "coding.test", policyVersion: "v3" },
  result: {
    mode: "artifact",
    outputKey: "result",
    artifactKind: "coding.test-result",
    mediaType: "application/json",
  },
  dependencies: input.dependencies ?? [],
  join: { kind: "all-success" },
  inputs: {
    inputVersions: { objective: hashCanonical(input.objective) },
    dataReferences: [],
    frontierVersion: "coding.recovery.frontier.v1",
    topologyVersion: "coding.recovery.topology.v1",
    catalogVersion: "coding.recovery.catalog.v1",
  },
  runtimeBindingEpoch: 1,
  retry: {
    maxAttempts: 4,
    initialBackoffMs: 10,
    maximumBackoffMs: 100,
  },
  timeoutMs: 5_000,
  sideEffect: "idempotent",
  estimatedCostMicros: 1,
});

const recoveryExecutionGrant = (input: {
  readonly runId: string;
  readonly definition: DynamicTaskDefinition;
  readonly attempt: number;
  readonly fence: number;
}) => createTaskExecutionGrant({
  ...input,
  policyVersion: "coding.recovery.policy.v1",
  policy: {
    maxTokens: recoveryPolicy.maxTokens,
    maxCostMicros: input.definition.estimatedCostMicros,
  },
  functionAccess: { allowedEffects: ["read", "write"] },
  workspaceOperations: ["read", "publish"],
  rationale: "The durable coding recovery task is admitted by the test policy.",
});

const recoveryOutcome = (
  runId: string,
  definition: DynamicTaskDefinition,
  attempt: number,
  contentHash: string,
  presentationText?: string,
) => {
  assert.equal(definition.result.mode, "artifact");
  return createAcceptedTaskOutcome({
  runId,
  taskId: definition.taskId,
  nodeId: definition.nodeId,
  attempt,
  definitionHash: definition.definitionHash,
  inputVersions: definition.inputs.inputVersions,
  frontierVersion: definition.inputs.frontierVersion,
  topologyVersion: definition.inputs.topologyVersion,
  catalogVersion: definition.inputs.catalogVersion,
  acceptancePolicyId: definition.acceptance.policyId,
  acceptancePolicyVersion: definition.acceptance.policyVersion,
  artifacts: [{
    artifactId: `${definition.taskId}:${definition.result.outputKey}`,
    outputKey: definition.result.outputKey,
    kind: definition.result.artifactKind,
    contentHash,
    mediaType: definition.result.mediaType,
    byteLength: contentHash.length,
    storage: "inline",
    ...(presentationText ? { presentationText } : {}),
  }],
  });
};

const terminalOutcome = (
  runId: string,
  definition: DynamicTaskDefinition,
  attempt: number,
) => createAcceptedTaskOutcome({
  runId,
  taskId: definition.taskId,
  nodeId: definition.nodeId,
  attempt,
  definitionHash: definition.definitionHash,
  inputVersions: definition.inputs.inputVersions,
  frontierVersion: definition.inputs.frontierVersion,
  topologyVersion: definition.inputs.topologyVersion,
  catalogVersion: definition.inputs.catalogVersion,
  acceptancePolicyId: definition.acceptance.policyId,
  acceptancePolicyVersion: definition.acceptance.policyVersion,
  artifacts: [],
});

test("Coding rooms are atomic, job-independent, and recoverable", {
  skip: !enabled,
  timeout: 20_000,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = `verification/coding-room/${suffix}`;
  const codingWorkspaceId = `coding_workspace_${suffix}`;
  const conversationId = `coding-room-${suffix}`;
  const streamId = `agents/coding-agent/runs/${conversationId}`;
  const firstControl = await connectSpacetimeControlPlaneFromEnv();
  assert.ok(firstControl);
  const firstRepository = new SpacetimeEventRepository(
    firstControl,
    workspaceId,
    "Coding room verification",
  );
  let secondControl: Awaited<ReturnType<typeof connectSpacetimeControlPlaneFromEnv>> | undefined;
  let secondRepository: SpacetimeEventRepository | undefined;
  try {
    await firstRepository.initialize();
    const message = createCodingConversationMessage({
      conversationId,
      workspaceId: codingWorkspaceId,
      author: { kind: "user", id: "human.operator", name: "You" },
      source: { kind: "api" },
      text: "Explain the saved repository team without starting an execution.",
      createdAt: 10,
    });
    await firstRepository.append(receipt(
      streamId,
      undefined,
      codingConversationMessageEvent(message),
      10,
      { eventId: `coding-conversation:${message.messageId}` },
    ));

    assert.deepEqual((await firstRepository.list(codingWorkspaceId)).map((room) => ({
      conversationId: room.conversationId,
      title: room.title,
      messageCount: room.messageCount,
    })), [{
      conversationId,
      title: "Explain the saved repository team without starting an execution.",
      messageCount: 1,
    }]);
    assert.equal(firstRepository.streamMetadata(streamId)?.kind, "coding-room");

    const rejectedConversationId = `coding-room-rejected-${suffix}`;
    const rejectedStreamId = `agents/coding-agent/runs/${rejectedConversationId}`;
    const rejectedMessage = createCodingConversationMessage({
      conversationId: rejectedConversationId,
      workspaceId: codingWorkspaceId,
      author: { kind: "user", id: "human.operator", name: "You" },
      source: { kind: "api" },
      text: "This invalid frontier must not leave an empty room.",
      createdAt: 11,
    });
    await assert.rejects(firstRepository.append(receipt(
      rejectedStreamId,
      "f".repeat(64),
      codingConversationMessageEvent(rejectedMessage),
      11,
    )), /expected previous hash|genesis/);
    assert.equal(
      (await firstRepository.list(codingWorkspaceId))
        .some((room) => room.conversationId === rejectedConversationId),
      false,
      "a rejected first message must roll back its room row",
    );

    firstRepository.close();
    firstControl.disconnect();
    secondControl = await connectSpacetimeControlPlaneFromEnv();
    assert.ok(secondControl);
    secondRepository = new SpacetimeEventRepository(
      secondControl,
      workspaceId,
      "Coding room verification",
    );
    await secondRepository.initialize();
    assert.deepEqual(
      (await secondRepository.list(codingWorkspaceId))
        .map((room) => room.conversationId)
        .sort(),
      [conversationId],
      "replacement processes must recover the durable room directory without queue jobs",
    );
  } finally {
    firstRepository.close();
    secondRepository?.close();
    firstControl.disconnect();
    secondControl?.disconnect();
  }
});

test("accepted Coding continuation timeline is durable and identical after reconnect", {
  skip: !enabled,
  timeout: 30_000,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Reuse the verification workspace so this production-path fixture does not
  // consume an additional durable workspace from the identity-wide test cap.
  const workspaceId = process.env.ROSTER_WORKSPACE_ID ?? `verification/coding-timeline/${suffix}`;
  const runId = `coding-timeline-${suffix}`;
  const roomId = `room-coding-timeline-${suffix}`;
  const streamId = `agents/coding-agent/runs/${runId}`;
  const firstControl = await connectSpacetimeControlPlaneFromEnv();
  assert.ok(firstControl);
  let firstSubscription: ReturnType<typeof firstControl.subscribeRosterRoomState> | undefined;
  let publicBindingSubscription: { readonly isActive: () => boolean; readonly unsubscribe: () => void } | undefined;
  let secondControl: Awaited<ReturnType<typeof connectSpacetimeControlPlaneFromEnv>> | undefined;
  let secondSubscription: ReturnType<typeof firstControl.subscribeRosterRoomState> | undefined;
  try {
    await firstControl.ensureWorkspace(workspaceId, "Coding accepted timeline verification");
    await firstControl.ensureEventStream({ workspaceId, streamId, kind: "coding" });

    const specs = [
      ["continue-implementation", "implementation", "implement", "implementation_report", "Implemented the bounded continuation and published its accepted summary."],
      ["review-implementation", "quality", "review", "review_report", "Reviewed the continuation and recorded the accepted quality findings."],
      ["certify-quality", "quality", "certify", "review_quality_report", "Certified the review evidence for the accepted remediation handoff."],
      ["remediate-after-review", "implementation", "remediate", "final_report", "Remediated the review findings and accepted the corrected implementation."],
      ["investigate-runtime", "investigator", "investigate", "investigation_runtime_report", "Investigated the runtime behavior and accepted the bounded finding."],
      ["synthesize-investigation", "investigator", "investigate", "final_report", "Synthesized the accepted investigation evidence for the room."],
      ["coding-finalize", "coordinator", "coordinate", "final_report", "Final certification accepted the complete continuation and review sequence."],
    ] as const;
    let previous: string | undefined;
    const definitions = specs.map(([taskId, nodeId, capability, outputKey]) => {
      const { definitionHash: _definitionHash, schemaVersion: _schemaVersion, ...base } = recoveryTask({
        taskId,
        nodeId,
        capability,
        objective: `Complete the bounded ${capability} stage`,
        dependencies: previous ? [{ taskId: previous, condition: "accepted" }] : [],
      });
      previous = taskId;
      return createDynamicTaskDefinition({
        ...base,
        semanticKey: `coding.timeline:${taskId}`,
        result: {
          mode: "artifact",
          outputKey,
          artifactKind: "coding.accepted-report",
          mediaType: "application/json",
        },
      });
    });
    const nodes = [
      { id: "implementation", name: "Kai, Implementation Engineer", capabilities: ["implement", "remediate"], runtime: { kind: "codex-cli" as const, metadata: { model: "gpt-5.6-sol", reasoningEffort: "high" } } },
      { id: "quality", name: "Mira, Quality Reviewer", capabilities: ["review", "certify"], runtime: { kind: "codex-cli" as const, metadata: { model: "gpt-5.6-terra" } } },
      { id: "investigator", name: "Noor, Runtime Investigator", capabilities: ["investigate"], runtime: { kind: "pi-agent" as const, metadata: { model: "openai-codex/gpt-5.6-luna" } } },
      { id: "coordinator", name: "Roster, Collaboration Facilitator", capabilities: ["coordinate"], runtime: { kind: "roster-native" as const } },
    ];
    await firstControl.initializeRosterExecution({
      workspaceId,
      runId,
      receiptStreamId: streamId,
      policy: recoveryPolicy,
      room: { id: roomId, roomKey: runId, kind: "coding", title: "Accepted continuation verification" },
      nodes,
      runtimeBindings: nodes.map((node) => ({
        bindingId: `binding-${node.id}`,
        nodeId: node.id,
        runtime: node.runtime,
        epoch: 1,
        topologyVersion: "coding.recovery.topology.v1",
        ...(node.id === "implementation" ? {
          sessionId: "private-provider-session",
          sandboxId: "private-runtime-sandbox",
        } : {}),
      })),
      seedTasks: definitions,
      initialContextFrontier: {
        contextVersion: "coding.recovery.context.v1",
        frontierVersion: "coding.recovery.frontier.v1",
        topologyVersion: "coding.recovery.topology.v1",
        catalogVersion: "coding.recovery.catalog.v1",
        bindingVersion: "1",
      },
      idempotencyKey: `coding-timeline-${suffix}`,
    });
    firstSubscription = firstControl.subscribeRosterRoomState(workspaceId, roomId, runId);
    await firstSubscription.ready;
    await new Promise<void>((resolve, reject) => {
      publicBindingSubscription = firstControl.connection.subscriptionBuilder()
        .onApplied(() => resolve())
        .onError(() => reject(new Error("Coding active runtime DTO subscription failed")))
        .subscribe([`SELECT * FROM my_coding_active_runtime_bindings_window WHERE run_id = '${runId}'`]);
    });
    const publicBindings = [...firstControl.connection.db.myCodingActiveRuntimeBindingsWindow.iter()]
      .filter((row) => row.runId === runId);
    assert.equal(publicBindings.find((row) => row.nodeId === "implementation")?.runtimeKind, "codex-cli");
    assert.equal(publicBindings.find((row) => row.nodeId === "implementation")?.model, "gpt-5.6-sol");
    assert.equal(publicBindings.find((row) => row.nodeId === "implementation")?.reasoningEffort, "high");
    const publicBindingJson = JSON.stringify(publicBindings, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value);
    assert.doesNotMatch(publicBindingJson, /private-provider-session|private-runtime-sandbox|runtimeJson/u);

    for (const [index, definition] of definitions.entries()) {
      await firstControl.claimRosterTask({ runId, taskId: definition.taskId, leaseMs: 5_000 });
      const task = firstControl.rosterSnapshot(runId).tasks.find((candidate) => candidate.taskId === definition.taskId);
      assert.ok(task, `missing claimed ${definition.taskId}`);
      await firstControl.startRosterTask({
        runId,
        taskId: definition.taskId,
        fence: task.leaseFence,
        contextManifest: createTaskContextManifest({
          runId,
          definition,
          attempt: task.attempt,
          fence: Number(task.leaseFence),
          executionGrant: recoveryExecutionGrant({
            runId,
            definition,
            attempt: task.attempt,
            fence: Number(task.leaseFence),
          }),
          includedInputIds: [
            ...Object.keys(definition.inputs.inputVersions),
            ...definition.dependencies.map((dependency) => dependency.taskId),
          ],
          includedArtifactIds: index > 0
            ? [`${specs[index - 1]![0]}:${specs[index - 1]![3]}`]
            : [],
        }),
      });
      const accepted = recoveryOutcome(
        runId,
        definition,
        task.attempt,
        hashCanonical({ index, taskId: definition.taskId }),
        specs[index]![4],
      );
      await firstControl.acceptRosterTaskOutcome({
        runId,
        taskId: definition.taskId,
        fence: task.leaseFence,
        outcome: accepted,
      });
    }

    const acceptedTimeline = () => firstControl.roomSnapshot(workspaceId, roomId, runId).timeline
      .filter((row) => row.kind === "message")
      .map((row) => [row.id, row.seq.toString(), row.taskId, row.nodeId, row.entryJson] as const);
    const beforeReconnect = acceptedTimeline();
    assert.equal(beforeReconnect.length, specs.length);
    assert.deepEqual(beforeReconnect.map((row) => row[2]), specs.map((spec) => spec[0]));

    firstSubscription.close();
    firstSubscription = undefined;
    firstControl.disconnect();
    secondControl = await connectSpacetimeControlPlaneFromEnv();
    assert.ok(secondControl);
    secondSubscription = secondControl.subscribeRosterRoomState(workspaceId, roomId, runId);
    await secondSubscription.ready;
    const afterReconnect = secondControl.roomSnapshot(workspaceId, roomId, runId).timeline
      .filter((row) => row.kind === "message")
      .map((row) => [row.id, row.seq.toString(), row.taskId, row.nodeId, row.entryJson] as const);
    assert.deepEqual(afterReconnect, beforeReconnect);
    assert.equal(new Set(afterReconnect.map((row) => row[0])).size, specs.length);
  } finally {
    firstSubscription?.close();
    if (publicBindingSubscription?.isActive()) publicBindingSubscription.unsubscribe();
    secondSubscription?.close();
    firstControl.disconnect();
    secondControl?.disconnect();
  }
});

test("actual fast Coding graph publishes implement and final-answer summaries identically after reconnect", {
  skip: !enabled,
  timeout: 30_000,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = process.env.ROSTER_WORKSPACE_ID ?? `verification/coding-fast-timeline/${suffix}`;
  const runId = `coding-fast-timeline-${suffix}`;
  const roomId = `room-${runId}`;
  const streamId = `agents/coding-agent/runs/${runId}`;
  const actual = await executeActualFastCodingGraph(runId);
  assert.equal(actual.status, "completed");
  const records = actual.snapshot.tasks.flatMap((record) => {
    if (!record.outcome) return [];
    const {
      definitionHash: _definitionHash,
      parentTaskId: _parentTaskId,
      runtimeBindingEpoch: _runtimeBindingEpoch,
      schemaVersion: _definitionSchemaVersion,
      ...definitionInput
    } = record.definition;
    const definition = createDynamicTaskDefinition({
      ...definitionInput,
      runtimeBindingEpoch: 1,
    });
    const {
      outcomeId: _outcomeId,
      schemaVersion: _outcomeSchemaVersion,
      definitionHash: _outcomeDefinitionHash,
      ...outcomeInput
    } = record.outcome;
    return [{
      definition,
      outcome: createAcceptedTaskOutcome({
        ...outcomeInput,
        definitionHash: definition.definitionHash,
      }),
    }];
  });
  records.sort((left, right) =>
    left.definition.dependencies.length - right.definition.dependencies.length
    || left.definition.taskId.localeCompare(right.definition.taskId));
  const implementArtifact = records.find(({ definition }) =>
    definition.taskId === "implement")?.outcome.artifacts[0];
  const announcementArtifact = records.find(({ definition }) =>
    definition.taskId === "announce-implement")?.outcome.artifacts[0];
  const synthesisArtifact = records.find(({ definition }) =>
    definition.taskId === "synthesize-final")?.outcome.artifacts[0];
  const completionArtifact = records.find(({ definition }) =>
    definition.taskId === "coding-complete")?.outcome.artifacts[0];
  assert.equal(implementArtifact?.outputKey, "final_report");
  assert.ok(announcementArtifact?.outputKey.startsWith("room_announcement_"));
  assert.equal(announcementArtifact?.presentationText, "Starting implement.");
  assert.equal(implementArtifact?.presentationText,
    "I implemented the fast-path change and validated its exact frontier.");
  assert.equal(synthesisArtifact?.outputKey, CODING_FINAL_ANSWER_OUTPUT);
  assert.equal(synthesisArtifact?.presentationText,
    "I implemented the fast-path change and validated its exact frontier.");
  assert.equal(completionArtifact?.outputKey, "coding_result");
  assert.equal(completionArtifact?.presentationText, undefined,
    "native completion must not create a second public answer");

  const firstControl = await connectSpacetimeControlPlaneFromEnv();
  assert.ok(firstControl);
  let firstSubscription: ReturnType<typeof firstControl.subscribeRosterRoomState> | undefined;
  let secondControl: Awaited<ReturnType<typeof connectSpacetimeControlPlaneFromEnv>> | undefined;
  let secondSubscription: ReturnType<typeof firstControl.subscribeRosterRoomState> | undefined;
  try {
    await firstControl.ensureWorkspace(workspaceId, "Coding actual fast timeline verification");
    await firstControl.ensureEventStream({ workspaceId, streamId, kind: "coding" });
    const definitions = records.map(({ definition }) => definition);
    const nodeIds = [...new Set(definitions.map((definition) => definition.nodeId))];
    const initial = definitions[0]!;
    await firstControl.initializeRosterExecution({
      workspaceId,
      runId,
      receiptStreamId: streamId,
      policy: { ...recoveryPolicy, maxCostMicros: 50_000_000, maxTokens: 2_000_000 },
      room: { id: roomId, roomKey: runId, kind: "coding", title: "Actual fast graph verification" },
      nodes: nodeIds.map((nodeId) => ({
        id: nodeId,
        name: nodeId === "coordinator" ? "Roster" : "Kai, Implementation Engineer",
        capabilities: [...new Set(definitions
          .filter((definition) => definition.nodeId === nodeId)
          .map((definition) => definition.capability))],
        runtime: { kind: nodeId === "coordinator" ? "roster-native" as const : "pi-agent" as const },
      })),
      runtimeBindings: nodeIds.map((nodeId) => ({
        bindingId: `binding-${nodeId}`,
        nodeId,
        runtime: { kind: nodeId === "coordinator" ? "roster-native" as const : "pi-agent" as const },
        epoch: 1,
        topologyVersion: initial.inputs.topologyVersion,
      })),
      seedTasks: definitions,
      initialContextFrontier: {
        contextVersion: `context-${runId}`,
        frontierVersion: initial.inputs.frontierVersion,
        topologyVersion: initial.inputs.topologyVersion,
        catalogVersion: initial.inputs.catalogVersion,
        bindingVersion: "1",
      },
      idempotencyKey: `actual-fast-${suffix}`,
    });
    firstSubscription = firstControl.subscribeRosterRoomState(workspaceId, roomId, runId);
    await firstSubscription.ready;

    const acceptedArtifacts: string[] = [];
    for (const { definition, outcome } of records) {
      await firstControl.claimRosterTask({ runId, taskId: definition.taskId, leaseMs: 5_000 });
      const task = firstControl.rosterSnapshot(runId).tasks.find((candidate) =>
        candidate.taskId === definition.taskId);
      assert.ok(task);
      await firstControl.startRosterTask({
        runId,
        taskId: definition.taskId,
        fence: task.leaseFence,
        contextManifest: createTaskContextManifest({
          runId,
          definition,
          attempt: task.attempt,
          fence: Number(task.leaseFence),
          executionGrant: recoveryExecutionGrant({
            runId,
            definition,
            attempt: task.attempt,
            fence: Number(task.leaseFence),
          }),
          includedInputIds: [
            ...Object.keys(definition.inputs.inputVersions),
            ...definition.dependencies.map((dependency) => dependency.taskId),
          ],
          includedArtifactIds: definition.dependencies.length > 0 ? acceptedArtifacts : [],
        }),
      });
      await firstControl.acceptRosterTaskOutcome({
        runId,
        taskId: definition.taskId,
        fence: task.leaseFence,
        outcome,
      });
      acceptedArtifacts.push(...outcome.artifacts.map((artifact) => artifact.artifactId));
    }

    const projected = (control: SpacetimeControlPlane) => control
      .roomSnapshot(workspaceId, roomId, runId).timeline
      .filter((row) => row.kind === "message")
      .map((row) => [row.id, row.seq.toString(), row.taskId, row.nodeId, row.entryJson] as const);
    const beforeReconnect = projected(firstControl);
    assert.deepEqual(beforeReconnect.map((row) => row[2]), ["announce-implement", "implement", "synthesize-final"]);
    assert.equal(new Set(beforeReconnect.map((row) => row[0])).size, 3);
    assert.match(beforeReconnect[0]?.[4] ?? "", /"turn:announcement"/u);
    assert.match(beforeReconnect[0]?.[4] ?? "", /"mentions":\["You"\]/u);

    firstSubscription.close();
    firstSubscription = undefined;
    firstControl.disconnect();
    secondControl = await connectSpacetimeControlPlaneFromEnv();
    assert.ok(secondControl);
    secondSubscription = secondControl.subscribeRosterRoomState(workspaceId, roomId, runId);
    await secondSubscription.ready;
    assert.deepEqual(projected(secondControl), beforeReconnect);
  } finally {
    firstSubscription?.close();
    secondSubscription?.close();
    firstControl.disconnect();
    secondControl?.disconnect();
  }
});

test("Coding viewer access expires, revokes, and never crosses exact runs", {
  skip: !enabled,
  timeout: 20_000,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = process.env.ROSTER_WORKSPACE_ID ?? `verification/coding-viewer/${suffix}`;
  const owner = await connectSpacetimeControlPlaneFromEnv();
  assert.ok(owner);
  let viewer: SpacetimeControlPlane | undefined;
  let reconnected: SpacetimeControlPlane | undefined;
  let roomSubscription: { readonly isActive: () => boolean; readonly unsubscribe: () => void } | undefined;
  let reconnectSubscription: { readonly isActive: () => boolean; readonly unsubscribe: () => void } | undefined;
  const initialize = async (runId: string, roomId: string): Promise<void> => {
    const streamId = `agents/coding-agent/runs/${runId}`;
    await owner.ensureEventStream({ workspaceId, streamId, kind: "coding" });
    await owner.initializeRosterExecution({
      workspaceId,
      runId,
      receiptStreamId: streamId,
      policy: recoveryPolicy,
      room: { id: roomId, roomKey: runId, kind: "coding", title: "Viewer access verification" },
      nodes: [{
        id: "coordinator",
        name: "Roster, Collaboration Facilitator",
        capabilities: ["coordinate"],
        runtime: { kind: "roster-native" },
      }],
      runtimeBindings: [{
        bindingId: `binding-${runId}`,
        nodeId: "coordinator",
        runtime: { kind: "roster-native" },
        epoch: 1,
        topologyVersion: "coding.recovery.topology.v1",
      }],
      seedTasks: [recoveryTask({
        taskId: `coordinate-${runId}`,
        nodeId: "coordinator",
        capability: "coordinate",
        objective: "Keep the exact viewer test run available",
      })],
      initialContextFrontier: {
        contextVersion: "coding.viewer.context.v1",
        frontierVersion: "coding.recovery.frontier.v1",
        topologyVersion: "coding.recovery.topology.v1",
        catalogVersion: "coding.recovery.catalog.v1",
        bindingVersion: "1",
      },
      idempotencyKey: `coding-viewer-${runId}`,
    });
  };
  try {
    await owner.ensureWorkspace(workspaceId, "Coding viewer access verification");
    const runA = `coding-viewer-a-${suffix}`;
    const runB = `coding-viewer-b-${suffix}`;
    await initialize(runA, `room-viewer-a-${suffix}`);
    await initialize(runB, `room-viewer-b-${suffix}`);

    viewer = await SpacetimeControlPlane.connect({
      ...owner.config,
      token: undefined,
      tokenPath: undefined,
    });
    const firstSecret = `viewer-first-${suffix}`;
    const replacementSecret = `viewer-replacement-${suffix}`;
    await owner.createViewerCapability({
      runId: runA,
      capabilityId: `viewer-first-${suffix}`,
      capabilityHash: sha256(firstSecret),
      maxUses: 4,
      ttlSeconds: 60,
    });
    await owner.createViewerCapability({
      runId: runA,
      capabilityId: `viewer-replacement-${suffix}`,
      capabilityHash: sha256(replacementSecret),
      maxUses: 4,
      ttlSeconds: 60,
    });
    await viewer.joinCanvasRun({ runId: runA, capabilityHash: sha256(firstSecret) });
    await assert.rejects(
      viewer.joinCanvasRun({ runId: runB, capabilityHash: sha256(firstSecret) }),
      /invalid/,
    );
    await new Promise<void>((resolve, reject) => {
      roomSubscription = viewer!.connection.subscriptionBuilder()
        .onApplied(() => resolve())
        .onError((_ctx, error) => reject(error))
        .subscribe(["SELECT * FROM my_coding_rooms_window"]);
    });
    const visibleRunIds = () => [...viewer!.connection.db.myCodingRoomsWindow.iter()]
      .map((row) => row.activeRunId)
      .sort();
    assert.deepEqual(visibleRunIds(), [runA]);

    const privateTerminalReason = [
      "git reset --hard private-branch",
      "Bearer private-viewer-token",
      "providerSession=private-session",
      "toolInput={private:true}",
      "reasoning=private-chain",
    ].join(" | ");
    let executionSubscription: { readonly isActive: () => boolean; readonly unsubscribe: () => void } | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        executionSubscription = viewer!.connection.subscriptionBuilder()
          .onApplied(() => resolve())
          .onError((_ctx, error) => reject(error))
          .subscribe(["SELECT * FROM my_coding_execution_summaries_window"]);
      });
      await owner.cancelRosterExecution(runA, privateTerminalReason);
      const publicExecution = () => [...viewer!.connection.db.myCodingExecutionSummariesWindow.iter()]
        .find((row) => row.runId === runA);
      await waitFor(() => publicExecution()?.status === "canceled", "viewer execution DTO must update");
      assert.equal(publicExecution()?.terminalReason, "run-canceled");
      const publicJson = JSON.stringify(publicExecution(), (_key, value) =>
        typeof value === "bigint" ? value.toString() : value);
      assert.doesNotMatch(publicJson, /git reset|Bearer|providerSession|toolInput|reasoning|private-/u);
      const rendered = codingRunPresentation(publicExecution());
      assert.equal(rendered.summary, "The run was stopped and its accepted work was preserved.");
      assert.doesNotMatch(JSON.stringify(rendered), /git reset|Bearer|providerSession|toolInput|reasoning|private-/u);
    } finally {
      if (executionSubscription?.isActive()) executionSubscription.unsubscribe();
    }

    await viewer.joinCanvasRun({ runId: runA, capabilityHash: sha256(replacementSecret) });
    await owner.revokeViewerCapability({ runId: runA, capabilityId: `viewer-first-${suffix}` });
    await waitFor(() => visibleRunIds().includes(runA), "a second exact grant must preserve current run access");
    await owner.revokeViewerCapability({ runId: runA, capabilityId: `viewer-replacement-${suffix}` });
    await waitFor(() => visibleRunIds().length === 0, "revoking the current grant must remove viewer access");

    const expiringSecret = `viewer-expiring-${suffix}`;
    await owner.createViewerCapability({
      runId: runA,
      capabilityId: `viewer-expiring-${suffix}`,
      capabilityHash: sha256(expiringSecret),
      maxUses: 4,
      ttlSeconds: 1,
    });
    await viewer.joinCanvasRun({ runId: runA, capabilityHash: sha256(expiringSecret) });
    await waitFor(() => visibleRunIds().includes(runA), "a fresh exact grant must restore only run A");
    await waitFor(() => visibleRunIds().length === 0, "TTL expiry must remove the redeemed viewer membership", 5_000);
    await assert.rejects(
      viewer.joinCanvasRun({ runId: runA, capabilityHash: sha256(expiringSecret) }),
      /expired/,
    );

    const viewerToken = viewer.auth.token;
    roomSubscription.unsubscribe();
    roomSubscription = undefined;
    viewer.disconnect();
    viewer = undefined;
    reconnected = await SpacetimeControlPlane.connect({
      ...owner.config,
      token: viewerToken,
      tokenPath: undefined,
    });
    await new Promise<void>((resolve, reject) => {
      reconnectSubscription = reconnected!.connection.subscriptionBuilder()
        .onApplied(() => resolve())
        .onError((_ctx, error) => reject(error))
        .subscribe(["SELECT * FROM my_coding_rooms_window"]);
    });
    assert.deepEqual([...reconnected.connection.db.myCodingRoomsWindow.iter()], []);
  } finally {
    if (roomSubscription?.isActive()) roomSubscription.unsubscribe();
    if (reconnectSubscription?.isActive()) reconnectSubscription.unsubscribe();
    viewer?.disconnect();
    reconnected?.disconnect();
    owner.disconnect();
  }
});

test("viewer capability cleanup preserves independently granted run membership", {
  skip: !enabled,
  timeout: 20_000,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = process.env.ROSTER_WORKSPACE_ID ?? `verification/viewer-provenance/${suffix}`;
  const owner = await connectSpacetimeControlPlaneFromEnv();
  assert.ok(owner);
  let viewer: SpacetimeControlPlane | undefined;
  let canvasSubscription: { readonly isActive: () => boolean; readonly unsubscribe: () => void } | undefined;
  try {
    await owner.ensureWorkspace(workspaceId, "Viewer membership provenance verification");
    const delegatedRunId = `canvas-delegated-viewer-${suffix}`;
    await owner.createCanvasRun({
      workspaceId,
      runId: delegatedRunId,
      requestId: `canvas-delegated-viewer-${suffix}`,
      prompt: "Verify explicit run-member provenance",
      desiredAgents: 3,
      maxInflight: 1,
      budgetMicros: 1_000_000n,
    });

    viewer = await SpacetimeControlPlane.connect({
      ...owner.config,
      token: undefined,
      tokenPath: undefined,
    });
    await owner.connection.reducers.addRunMember({
      runId: delegatedRunId,
      member: viewer.auth.identity,
      role: "viewer",
    });
    await new Promise<void>((resolve, reject) => {
      canvasSubscription = viewer!.connection.subscriptionBuilder()
        .onApplied(() => resolve())
        .onError((_ctx, error) => reject(error))
        .subscribe(["SELECT * FROM my_canvas_run_ui"]);
    });
    const visibleCanvasRuns = () => [...viewer!.connection.db.myCanvasRunUi.iter()]
      .map((row) => row.id)
      .sort();
    assert.deepEqual(visibleCanvasRuns(), [delegatedRunId]);

    const delegatedSecret = `delegated-viewer-${suffix}`;
    await owner.createViewerCapability({
      runId: delegatedRunId,
      capabilityId: `delegated-viewer-${suffix}`,
      capabilityHash: sha256(delegatedSecret),
      maxUses: 2,
      ttlSeconds: 60,
    });
    await viewer.joinCanvasRun({ runId: delegatedRunId, capabilityHash: sha256(delegatedSecret) });
    await owner.revokeViewerCapability({
      runId: delegatedRunId,
      capabilityId: `delegated-viewer-${suffix}`,
    });
    await waitFor(
      () => visibleCanvasRuns().includes(delegatedRunId),
      "revoking temporary access must preserve addRunMember provenance",
    );

    const canvasRunId = `canvas-durable-viewer-${suffix}`;
    await owner.createCanvasRun({
      workspaceId,
      runId: canvasRunId,
      requestId: `canvas-viewer-provenance-${suffix}`,
      prompt: "Verify durable workspace viewer provenance",
      desiredAgents: 3,
      maxInflight: 1,
      budgetMicros: 1_000_000n,
    });
    await owner.connection.reducers.addWorkspaceMember({
      workspaceId,
      member: viewer.auth.identity,
      role: "viewer",
    });
    await viewer.connection.reducers.joinCanvasWorkspaceRun({ workspaceId, runId: canvasRunId });
    await waitFor(() => visibleCanvasRuns().includes(canvasRunId), "workspace-linked Canvas run must be visible");
    assert.deepEqual(visibleCanvasRuns(), [delegatedRunId, canvasRunId].sort());

    const expiringSecret = `workspace-viewer-expiring-${suffix}`;
    await owner.createViewerCapability({
      runId: canvasRunId,
      capabilityId: `workspace-viewer-expiring-${suffix}`,
      capabilityHash: sha256(expiringSecret),
      maxUses: 2,
      ttlSeconds: 1,
    });
    await viewer.joinCanvasRun({ runId: canvasRunId, capabilityHash: sha256(expiringSecret) });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await waitFor(
      () => visibleCanvasRuns().includes(canvasRunId),
      "expiring temporary access must preserve joinCanvasWorkspaceRun provenance",
    );
  } finally {
    if (canvasSubscription?.isActive()) canvasSubscription.unsubscribe();
    viewer?.disconnect();
    owner.disconnect();
  }
});

test("Coding task recovery resumes from the durable task lease under a replacement job fence", {
  skip: !enabled,
  timeout: 20_000,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = `verification/coding-recovery/${suffix}`;
  const runId = `coding-recovery-${suffix}`;
  const streamId = `agents/coding-agent/runs/${runId}`;
  const jobId = `job-${suffix}`;
  const firstControl = await connectSpacetimeControlPlaneFromEnv();
  assert.ok(firstControl);
  let firstQueue: Awaited<ReturnType<typeof createSpacetimeJobQueue>> | undefined;
  let firstExecution: ReturnType<typeof firstControl.subscribeRosterExecution> | undefined;
  let secondControl: Awaited<ReturnType<typeof connectSpacetimeControlPlaneFromEnv>> | undefined;
  let secondQueue: Awaited<ReturnType<typeof createSpacetimeJobQueue>> | undefined;
  let secondExecution: ReturnType<typeof firstControl.subscribeRosterExecution> | undefined;
  try {
    await firstControl.ensureWorkspace(workspaceId, "Coding recovery verification");
    await firstControl.ensureEventStream({
      workspaceId,
      streamId,
      kind: "coding",
    });
    firstQueue = await createSpacetimeJobQueue({ control: firstControl, workspaceId });
    await firstQueue.enqueue({
      requestId: `request-${suffix}`,
      jobId,
      agentId: "coding-agent",
      payload: { kind: "coding-agent.run", runId, runStream: streamId },
      maxAttempts: 4,
    });
    const firstLease = await firstQueue.leaseNext({ workerId: "coding-worker-one", leaseMs: 1_000 });
    assert.ok(firstLease?.leaseFence);
    firstExecution = firstControl.subscribeRosterExecution(runId);
    await firstExecution.ready;
    await firstControl.ensureRosterExecution({
      runId,
      kind: "coding",
      workspaceId,
      receiptStreamId: streamId,
      policy: recoveryPolicy,
    });
    const implementDefinition = recoveryTask({
      taskId: "implement",
      nodeId: "implementation-node",
      capability: "implement",
      objective: "Implement the bounded change",
    });
    await firstControl.enqueueRosterTask({ runId, definition: implementDefinition });
    await firstControl.claimRosterTask({ runId, taskId: "implement", leaseMs: 5_000 });
    const firstTask = firstControl.rosterSnapshot(runId).tasks.find((task) =>
      task.runId === runId && task.taskId === "implement");
    assert.ok(firstTask);
    const firstTaskFence = firstTask.leaseFence;
    await firstControl.startRosterTask({
      runId,
      taskId: "implement",
      fence: firstTaskFence,
      contextManifest: createTaskContextManifest({
        runId,
        definition: implementDefinition,
        attempt: firstTask.attempt,
        fence: Number(firstTaskFence),
        executionGrant: recoveryExecutionGrant({
          runId,
          definition: implementDefinition,
          attempt: firstTask.attempt,
          fence: Number(firstTaskFence),
        }),
      }),
    });

    // Simulate a process disappearing after task start but before a trusted
    // accepted outcome. The task lease, not a receipt inference, owns recovery.
    firstExecution.close();
    firstExecution = undefined;
    firstQueue.close();
    firstQueue = undefined;
    firstControl.disconnect();

    secondControl = await connectSpacetimeControlPlaneFromEnv();
    assert.ok(secondControl);
    secondQueue = await createSpacetimeJobQueue({ control: secondControl, workspaceId });
    const deadline = Date.now() + 7_000;
    let recovered: Awaited<ReturnType<typeof secondQueue.leaseNext>> = undefined;
    while (!recovered && Date.now() < deadline) {
      recovered = await secondQueue.leaseNext({ workerId: "coding-worker-two", leaseMs: 2_000 });
      if (!recovered) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(recovered?.leaseFence);
    assert.ok(BigInt(recovered.leaseFence) > BigInt(firstLease.leaseFence));
    secondExecution = secondControl.subscribeRosterExecution(runId);
    await secondExecution.ready;
    await secondControl.ensureRosterExecution({
      runId,
      kind: "coding",
      workspaceId,
      receiptStreamId: streamId,
      policy: recoveryPolicy,
    });

    const taskDeadline = Date.now() + 7_000;
    let replacementFence: bigint | undefined;
    while (!replacementFence && Date.now() < taskDeadline) {
      await secondControl.claimRosterTask({
        runId,
        taskId: "implement",
        leaseMs: 5_000,
      }).catch(() => undefined);
      replacementFence = secondControl.rosterSnapshot(runId).tasks.find((task) =>
        task.taskId === "implement" && task.status === "leased")?.leaseFence;
      if (!replacementFence) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(replacementFence);
    assert.ok(replacementFence > firstTaskFence);
    await assert.rejects(secondControl.acceptRosterTaskOutcome({
      runId,
      taskId: "implement",
      fence: firstTaskFence,
      outcome: recoveryOutcome(runId, implementDefinition, 1, "f".repeat(64)),
    }), /active lease|stale lease fence/);
    const replacementTask = secondControl.rosterSnapshot(runId).tasks.find((task) =>
      task.taskId === "implement");
    assert.ok(replacementTask);
    await secondControl.startRosterTask({
      runId,
      taskId: "implement",
      fence: replacementFence,
      contextManifest: createTaskContextManifest({
        runId,
        definition: implementDefinition,
        attempt: replacementTask.attempt,
        fence: Number(replacementFence),
        executionGrant: recoveryExecutionGrant({
          runId,
          definition: implementDefinition,
          attempt: replacementTask.attempt,
          fence: Number(replacementFence),
        }),
      }),
    });
    await secondControl.acceptRosterTaskOutcome({
      runId,
      taskId: "implement",
      fence: replacementFence,
      outcome: recoveryOutcome(
        runId,
        implementDefinition,
        replacementTask.attempt,
        hashCanonical({ implementation: "accepted" }),
      ),
    });

    const reviewDefinition = recoveryTask({
      taskId: "review",
      nodeId: "review-node",
      capability: "review",
      objective: "Review the durable implementation",
      dependencies: [{ taskId: "implement", condition: "accepted" }],
    });
    await secondControl.enqueueRosterTask({ runId, definition: reviewDefinition });
    await secondControl.claimRosterTask({ runId, taskId: "review", leaseMs: 5_000 });
    assert.equal(secondControl.rosterSnapshot(runId).tasks.find((task) =>
      task.runId === runId && task.taskId === "review")?.status, "leased");
  } finally {
    firstExecution?.close();
    secondExecution?.close();
    firstQueue?.close();
    secondQueue?.close();
    firstControl.disconnect();
    secondControl?.disconnect();
  }
});

test("durable continuation settlement and execution finalization agree end to end", {
  skip: !enabled,
  timeout: 20_000,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = `verification/coding-finalization/${suffix}`;
  const runId = `coding-finalization-${suffix}`;
  const streamId = `agents/coding-agent/runs/${runId}`;
  const control = await connectSpacetimeControlPlaneFromEnv();
  assert.ok(control);
  const subscription = control.subscribeRosterExecution(runId);
  try {
    await subscription.ready;
    await control.ensureWorkspace(workspaceId, "Coding finalization verification");
    await control.ensureEventStream({ workspaceId, streamId, kind: "coding" });
    await control.ensureRosterExecution({
      runId,
      kind: "coding",
      workspaceId,
      receiptStreamId: streamId,
      policy: recoveryPolicy,
    });
    const noneTask = (input: {
      readonly taskId: string;
      readonly capability: string;
      readonly dependencies?: DynamicTaskDefinition["dependencies"];
      readonly parentTaskId?: string;
      readonly catalogVersion?: string;
    }) => {
      const { definitionHash: _definitionHash, schemaVersion: _schemaVersion, ...base } = recoveryTask({
        taskId: input.taskId,
        nodeId: `${input.capability}-node`,
        capability: input.capability,
        objective: `Verify ${input.taskId}`,
        dependencies: input.dependencies,
      });
      return createDynamicTaskDefinition({
        ...base,
        result: { mode: "none" as const },
        inputs: {
          ...base.inputs,
          catalogVersion: input.catalogVersion ?? base.inputs.catalogVersion,
        },
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      });
    };
    const root = noneTask({ taskId: "coordinate", capability: "coordinate" });
    const child = noneTask({
      taskId: "implement",
      capability: "implement",
      parentTaskId: root.taskId,
      catalogVersion: "coding.recovery.catalog.v2",
    });
    const continuation = noneTask({
      taskId: "finalize",
      capability: "finalize",
      parentTaskId: root.taskId,
      dependencies: [{ taskId: child.taskId, condition: "accepted" }],
      catalogVersion: "coding.recovery.catalog.v2",
    });
    const review = noneTask({
      taskId: "review",
      capability: "review",
      dependencies: [{ taskId: root.taskId, condition: "accepted" }],
      catalogVersion: "coding.recovery.catalog.v2",
    });
    await control.enqueueRosterTask({ runId, definition: root });
    await control.enqueueRosterTask({ runId, definition: review });
    await control.claimRosterTask({ runId, taskId: root.taskId, leaseMs: 5_000 });
    const startAndRead = async (definition: DynamicTaskDefinition) => {
      const task = control.rosterSnapshot(runId).tasks.find((candidate) =>
        candidate.taskId === definition.taskId);
      assert.ok(task);
      const acceptedDependencyIds = definition.dependencies
        .map((dependency) => dependency.taskId)
        .filter((taskId) => control.rosterSnapshot(runId).tasks.some((candidate) =>
          candidate.taskId === taskId && candidate.status === "accepted"));
      await control.startRosterTask({
        runId,
        taskId: definition.taskId,
        fence: task.leaseFence,
        contextManifest: createTaskContextManifest({
          runId,
          definition,
          attempt: task.attempt,
          fence: Number(task.leaseFence),
          executionGrant: recoveryExecutionGrant({
            runId,
            definition,
            attempt: task.attempt,
            fence: Number(task.leaseFence),
          }),
          includedInputIds: [
            ...Object.keys(definition.inputs.inputVersions),
            ...acceptedDependencyIds,
          ],
        }),
      });
      return task;
    };
    const rootTask = await startAndRead(root);
    await control.expandAndDelegateRosterTask({
      runId,
      parentTaskId: root.taskId,
      fence: rootTask.leaseFence,
      expansionKey: `finalization-${suffix}`,
      children: [child],
      continuation,
    });
    assert.equal(control.rosterSnapshot(runId).tasks.find((task) =>
      task.taskId === root.taskId)?.status, "delegated");

    await control.claimRosterTask({ runId, taskId: child.taskId, leaseMs: 5_000 });
    const childTask = await startAndRead(child);
    await control.acceptRosterTaskOutcome({
      runId,
      taskId: child.taskId,
      fence: childTask.leaseFence,
      outcome: terminalOutcome(runId, child, childTask.attempt),
    });
    await control.claimRosterTask({ runId, taskId: continuation.taskId, leaseMs: 5_000 });
    const continuationTask = await startAndRead(continuation);
    await control.acceptRosterTaskOutcome({
      runId,
      taskId: continuation.taskId,
      fence: continuationTask.leaseFence,
      outcome: terminalOutcome(runId, continuation, continuationTask.attempt),
    });

    assert.equal(control.rosterSnapshot(runId).tasks.find((task) =>
      task.taskId === review.taskId)?.status, "ready");
    await control.claimRosterTask({ runId, taskId: review.taskId, leaseMs: 5_000 });
    const reviewTask = control.rosterSnapshot(runId).tasks.find((task) =>
      task.taskId === review.taskId);
    assert.ok(reviewTask);
    await control.startRosterTask({
      runId,
      taskId: review.taskId,
      fence: reviewTask.leaseFence,
      contextManifest: createTaskContextManifest({
        runId,
        definition: review,
        attempt: reviewTask.attempt,
        fence: Number(reviewTask.leaseFence),
        executionGrant: recoveryExecutionGrant({
          runId,
          definition: review,
          attempt: reviewTask.attempt,
          fence: Number(reviewTask.leaseFence),
        }),
        includedInputIds: [
          ...Object.keys(review.inputs.inputVersions),
          continuation.taskId,
        ],
      }),
    });
    await control.acceptRosterTaskOutcome({
      runId,
      taskId: review.taskId,
      fence: reviewTask.leaseFence,
      outcome: terminalOutcome(runId, review, reviewTask.attempt),
    });

    const settled = control.rosterSnapshot(runId);
    assert.equal(settled.tasks.find((task) => task.taskId === root.taskId)?.status, "skipped");
    assert.equal(settled.executions.find((execution) => execution.runId === runId)?.status, "quiescent");
    await control.finalizeRosterExecution({ runId, outcome: "completed" });
    assert.equal(control.rosterSnapshot(runId).executions.find((execution) =>
      execution.runId === runId)?.status, "completed");
  } finally {
    subscription.close();
    control.disconnect();
  }
});

test("same-identity Coding clients retain independent bounded timeline selections", {
  skip: !enabled,
  timeout: 120_000,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Reuse the verification workspace so the multi-run fixture tests membership
  // selection without consuming another identity-wide workspace allocation.
  const workspaceId = process.env.ROSTER_WORKSPACE_ID ?? `verification/coding-selected-head/${suffix}`;
  const foreignRunId = `aa-foreign-${suffix}`;
  const foreignRoomId = `room-${foreignRunId}`;
  const selectedRunId = `zz-selected-${suffix}`;
  const selectedRoomId = `room-${selectedRunId}`;
  const foreignSelectionId = `tab-a-${suffix}`;
  const selectedSelectionId = `tab-b-${suffix}`;
  const predecessorCleanupSelectionId = `cleanup-${suffix}`;
  const owner = await connectSpacetimeControlPlaneFromEnv();
  assert.ok(owner);
  let second: SpacetimeControlPlane | undefined;
  let reconnected: SpacetimeControlPlane | undefined;
  let aggregate: SpacetimeControlPlane | undefined;
  const subscriptions: Array<{ readonly isActive: () => boolean; readonly unsubscribe: () => void }> = [];

  const initialize = async (runId: string, roomId: string): Promise<void> => {
    const streamId = `agents/coding-agent/runs/${runId}`;
    const task = recoveryTask({
      taskId: `coordinate-${runId}`,
      nodeId: "coordinator",
      capability: "coordinate",
      objective: `Keep ${runId} active for exact selected-head verification`,
    });
    await owner.ensureEventStream({ workspaceId, streamId, kind: "coding" });
    await owner.initializeRosterExecution({
      workspaceId,
      runId,
      receiptStreamId: streamId,
      policy: recoveryPolicy,
      room: { id: roomId, roomKey: runId, kind: "coding", title: "Selected timeline verification" },
      nodes: [{
        id: "coordinator",
        name: "Roster, Collaboration Facilitator",
        capabilities: ["coordinate"],
        runtime: { kind: "roster-native" },
      }],
      runtimeBindings: [{
        bindingId: `binding-${runId}`,
        nodeId: "coordinator",
        runtime: { kind: "roster-native" },
        epoch: 1,
        topologyVersion: task.inputs.topologyVersion,
      }],
      seedTasks: [task],
      initialContextFrontier: {
        contextVersion: `context-${runId}`,
        frontierVersion: task.inputs.frontierVersion,
        topologyVersion: task.inputs.topologyVersion,
        catalogVersion: task.inputs.catalogVersion,
        bindingVersion: "1",
      },
      idempotencyKey: `selected-head-${runId}`,
    });
  };
  const append = async (runId: string, roomId: string, count: number): Promise<void> => {
    for (let index = 1; index <= count; index += 1) {
      await owner.connection.reducers.appendRosterRoomTimelineEntry({
        workspaceId,
        roomId,
        runId,
        entryId: `checkpoint-${runId}-${index.toString().padStart(4, "0")}`,
        kind: "checkpoint",
        taskId: "",
        nodeId: "",
        fence: 0n,
        entryJson: JSON.stringify({ type: "checkpoint", index }),
      });
    }
  };
  const subscribe = async (
    control: SpacetimeControlPlane,
    selectionId: string,
    roomId: string,
  ) => new Promise<{
    readonly isActive: () => boolean;
    readonly unsubscribe: () => void;
  }>((resolve, reject) => {
    let subscription: { readonly isActive: () => boolean; readonly unsubscribe: () => void };
    subscription = control.connection.subscriptionBuilder()
      .onApplied(() => resolve(subscription))
      .onError((_ctx, error) => reject(error))
      .subscribe([
        `SELECT * FROM my_coding_room_timeline_window WHERE selection_id = '${selectionId}' AND room_id = '${roomId}'`,
        `SELECT * FROM my_coding_room_timeline_page WHERE selection_id = '${selectionId}' AND room_id = '${roomId}'`,
        "SELECT * FROM my_coding_room_timeline",
      ]);
  });
  const ordered = (rows: Iterable<{
    readonly id: string;
    readonly runId: string;
    readonly roomId: string;
    readonly seq: bigint;
  }>) => [...rows].sort((left, right) =>
    left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : left.id.localeCompare(right.id));
  const assertSelectedHead = (
    control: SpacetimeControlPlane,
    selectionId: string,
    runId: string,
    selectedRoom: string,
    latestSeq: bigint,
  ) => {
    const head = ordered(control.connection.db.myCodingRoomTimelineWindow.iter());
    assert.equal(head.length, 256);
    assert.ok(head.every((row) => row.selectionId === selectionId
      && row.runId === runId && row.roomId === selectedRoom));
    assert.deepEqual(head.map((row) => row.seq),
      Array.from({ length: 256 }, (_value, index) => latestSeq - 255n + BigInt(index)));
    assert.equal(new Set(head.map((row) => row.id)).size, head.length);
    assert.equal(new Set(head.map((row) => row.selectionRowId)).size, head.length);
    return head;
  };
  const privateSql = async (sql: string): Promise<string> => {
    const uri = process.env.SPACETIMEDB_URI;
    const database = process.env.SPACETIMEDB_DATABASE;
    assert.ok(uri && database);
    const result = await execFileAsync("spacetime", [
      "sql", "--server", uri, "--no-config", database, sql,
    ], { encoding: "utf8", maxBuffer: 1_000_000 });
    return result.stdout;
  };
  const privateSelectionRows = async (selectionId: string): Promise<{
    readonly requestId: string;
    readonly requestRows: number;
    readonly expirationRows: number;
    readonly expiresAtMicros?: bigint;
  }> => {
    const memberKey = owner.auth.identity.toHexString();
    const requestId = `${memberKey.length}:${memberKey}${selectionId}`;
    const [requestOutput, expirationOutput, expiryOutput] = await Promise.all([
      privateSql(`SELECT id FROM coding_room_timeline_page_request WHERE id = '${requestId}'`),
      privateSql(`SELECT request_id FROM coding_room_timeline_selection_expiration WHERE request_id = '${requestId}'`),
      privateSql(`SELECT expires_at_micros FROM coding_room_timeline_selection_expiration WHERE request_id = '${requestId}'`),
    ]);
    const quotedRequestId = `"${requestId}"`;
    const expiryMatch = expiryOutput.match(/\b\d{13,}\b/u);
    return {
      requestId,
      requestRows: requestOutput.split(quotedRequestId).length - 1,
      expirationRows: expirationOutput.split(quotedRequestId).length - 1,
      ...(expiryMatch ? { expiresAtMicros: BigInt(expiryMatch[0]) } : {}),
    };
  };

  try {
    await owner.ensureWorkspace(workspaceId, "Coding exact selected-head verification");
    await initialize(foreignRunId, foreignRoomId);
    await initialize(selectedRunId, selectedRoomId);
    await append(foreignRunId, foreignRoomId, 400);
    await append(selectedRunId, selectedRoomId, 400);
    second = await connectSpacetimeControlPlaneFromEnv();
    assert.ok(second);

    await owner.connection.reducers.selectCodingRoomTimelinePage({
      runId: foreignRunId,
      roomId: foreignRoomId,
      beforeSeq: 0n,
      selectionId: foreignSelectionId,
      predecessorSelectionId: "",
      ttlSeconds: 3_600n,
    });
    await second.connection.reducers.selectCodingRoomTimelinePage({
      runId: selectedRunId,
      roomId: selectedRoomId,
      beforeSeq: 0n,
      selectionId: selectedSelectionId,
      predecessorSelectionId: "",
      ttlSeconds: 3_600n,
    });
    subscriptions.push(await subscribe(owner, foreignSelectionId, foreignRoomId));
    subscriptions.push(await subscribe(second, selectedSelectionId, selectedRoomId));
    const foreignHead = assertSelectedHead(owner, foreignSelectionId, foreignRunId, foreignRoomId, 401n);
    const selectedHead = assertSelectedHead(second, selectedSelectionId, selectedRunId, selectedRoomId, 401n);
    const publicRows = [...owner.connection.db.myCodingRoomTimeline.iter()];
    assert.ok(publicRows.length <= 256, "unfiltered public timeline must remain hard bounded");
    assert.ok(publicRows.every((row) => row.runId === foreignRunId || row.runId === selectedRunId));

    await owner.connection.reducers.selectCodingRoomTimelinePage({
      runId: foreignRunId,
      roomId: foreignRoomId,
      beforeSeq: foreignHead[0]!.seq,
      selectionId: foreignSelectionId,
      predecessorSelectionId: "",
      ttlSeconds: 3_600n,
    });
    await second.connection.reducers.selectCodingRoomTimelinePage({
      runId: selectedRunId,
      roomId: selectedRoomId,
      beforeSeq: selectedHead[0]!.seq,
      selectionId: selectedSelectionId,
      predecessorSelectionId: "",
      ttlSeconds: 3_600n,
    });
    await waitFor(
      () => [...owner.connection.db.myCodingRoomTimelinePage.iter()].length === 64,
      "first tab historical page did not arrive",
    );
    await waitFor(
      () => [...second!.connection.db.myCodingRoomTimelinePage.iter()].length === 64,
      "second tab historical page did not arrive",
    );
    const foreignPage = ordered(owner.connection.db.myCodingRoomTimelinePage.iter());
    const selectedPage = ordered(second.connection.db.myCodingRoomTimelinePage.iter());
    assert.deepEqual(foreignPage.map((row) => row.seq),
      Array.from({ length: 64 }, (_value, index) => BigInt(index + 82)));
    assert.deepEqual(selectedPage.map((row) => row.seq), foreignPage.map((row) => row.seq));
    assert.ok(foreignPage.every((row) => row.selectionId === foreignSelectionId));
    assert.ok(selectedPage.every((row) => row.selectionId === selectedSelectionId));

    await owner.connection.reducers.appendRosterRoomTimelineEntry({
      workspaceId,
      roomId: foreignRoomId,
      runId: foreignRunId,
      entryId: `late-${foreignRunId}`,
      kind: "checkpoint",
      taskId: "",
      nodeId: "",
      fence: 0n,
      entryJson: JSON.stringify({ type: "checkpoint", late: true }),
    });
    await owner.connection.reducers.appendRosterRoomTimelineEntry({
      workspaceId,
      roomId: selectedRoomId,
      runId: selectedRunId,
      entryId: `late-${selectedRunId}`,
      kind: "checkpoint",
      taskId: "",
      nodeId: "",
      fence: 0n,
      entryJson: JSON.stringify({ type: "checkpoint", late: true }),
    });
    await waitFor(() => ordered(owner.connection.db.myCodingRoomTimelineWindow.iter()).at(-1)?.seq === 402n,
      "first tab did not receive its later row");
    await waitFor(() => ordered(second!.connection.db.myCodingRoomTimelineWindow.iter()).at(-1)?.seq === 402n,
      "second tab did not receive its later row");
    assertSelectedHead(owner, foreignSelectionId, foreignRunId, foreignRoomId, 402n);
    assertSelectedHead(second, selectedSelectionId, selectedRunId, selectedRoomId, 402n);

    subscriptions[1]?.unsubscribe();
    subscriptions.splice(1, 1);
    second.disconnect();
    second = undefined;
    reconnected = await connectSpacetimeControlPlaneFromEnv();
    assert.ok(reconnected);
    await reconnected.connection.reducers.selectCodingRoomTimelinePage({
      runId: selectedRunId,
      roomId: selectedRoomId,
      beforeSeq: 0n,
      selectionId: selectedSelectionId,
      predecessorSelectionId: "",
      ttlSeconds: 3_600n,
    });
    subscriptions.push(await subscribe(reconnected, selectedSelectionId, selectedRoomId));
    const reconnectHead = assertSelectedHead(
      reconnected, selectedSelectionId, selectedRunId, selectedRoomId, 402n,
    );
    assertSelectedHead(owner, foreignSelectionId, foreignRunId, foreignRoomId, 402n);
    await reconnected.connection.reducers.selectCodingRoomTimelinePage({
      runId: selectedRunId,
      roomId: selectedRoomId,
      beforeSeq: selectedHead[0]!.seq,
      selectionId: selectedSelectionId,
      predecessorSelectionId: "",
      ttlSeconds: 3_600n,
    });
    await waitFor(
      () => [...reconnected!.connection.db.myCodingRoomTimelinePage.iter()].length === 64,
      "reconnected selected historical page did not arrive",
    );
    const reconnectPage = ordered(reconnected.connection.db.myCodingRoomTimelinePage.iter());
    assert.deepEqual(reconnectPage.map((row) => row.id), selectedPage.map((row) => row.id));
    assert.equal(new Set([...reconnectHead, ...reconnectPage].map((row) => row.id)).size, 320);

    // A CLI watcher refreshes this same selection ID across transport
    // generations, including when an earlier acknowledgement arrives late.
    for (let index = 0; index < 999; index += 1) {
      await owner.connection.reducers.selectCodingRoomTimelinePage({
        runId: foreignRunId,
        roomId: foreignRoomId,
        beforeSeq: index % 2 === 0 ? 0n : foreignHead[0]!.seq,
        selectionId: foreignSelectionId,
        predecessorSelectionId: "",
        ttlSeconds: 3_600n,
      });
    }
    const finalRefreshStartedMicros = BigInt(Date.now()) * 1_000n;
    await owner.connection.reducers.selectCodingRoomTimelinePage({
      runId: foreignRunId,
      roomId: foreignRoomId,
      beforeSeq: foreignHead[0]!.seq,
      selectionId: foreignSelectionId,
      predecessorSelectionId: "",
      ttlSeconds: 3n,
    });
    const finalRefreshCompletedMicros = BigInt(Date.now()) * 1_000n;
    const stressedSelection = await privateSelectionRows(foreignSelectionId);
    assert.equal(stressedSelection.requestRows, 1, "1,000 refresh/page calls retain one request row");
    assert.equal(stressedSelection.expirationRows, 1, "1,000 refresh/page calls retain one live expiry row");
    assert.ok(stressedSelection.expiresAtMicros);
    assert.ok(stressedSelection.expiresAtMicros >= finalRefreshStartedMicros + 3_000_000n);
    assert.ok(stressedSelection.expiresAtMicros <= finalRefreshCompletedMicros + 3_250_000n);

    const cleanupDeadline = Date.now() + 8_000;
    let expiredSelection = stressedSelection;
    while ((expiredSelection.requestRows !== 0 || expiredSelection.expirationRows !== 0)
      && Date.now() < cleanupDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expiredSelection = await privateSelectionRows(foreignSelectionId);
    }
    assert.equal(expiredSelection.requestRows, 0, "the final scheduled expiry removes the request row");
    assert.equal(expiredSelection.expirationRows, 0, "the final scheduled expiry consumes its only timer");

    await owner.connection.reducers.selectCodingRoomTimelinePage({
      runId: foreignRunId,
      roomId: foreignRoomId,
      beforeSeq: 0n,
      selectionId: predecessorCleanupSelectionId,
      predecessorSelectionId: "",
      ttlSeconds: 3_600n,
    });
    await owner.connection.reducers.selectCodingRoomTimelinePage({
      runId: foreignRunId,
      roomId: foreignRoomId,
      beforeSeq: 0n,
      selectionId: foreignSelectionId,
      predecessorSelectionId: predecessorCleanupSelectionId,
      ttlSeconds: 3_600n,
    });
    const removedPredecessor = await privateSelectionRows(predecessorCleanupSelectionId);
    assert.equal(removedPredecessor.requestRows, 0, "replacement removes its predecessor request");
    assert.equal(removedPredecessor.expirationRows, 0, "replacement removes its predecessor timer");

    for (let index = 0; index < 6; index += 1) {
      await owner.connection.reducers.selectCodingRoomTimelinePage({
        runId: foreignRunId,
        roomId: foreignRoomId,
        beforeSeq: 0n,
        selectionId: `bounded-${index}-${suffix}`,
        predecessorSelectionId: "",
        ttlSeconds: 3_600n,
      });
    }
    await assert.rejects(owner.connection.reducers.selectCodingRoomTimelinePage({
      runId: foreignRunId,
      roomId: foreignRoomId,
      beforeSeq: 0n,
      selectionId: `overflow-${suffix}`,
      predecessorSelectionId: "",
      ttlSeconds: 3_600n,
    }), /selection limit is 8/u);
    aggregate = await connectSpacetimeControlPlaneFromEnv();
    assert.ok(aggregate);
    subscriptions.push(await new Promise((resolve, reject) => {
      let subscription: { readonly isActive: () => boolean; readonly unsubscribe: () => void };
      subscription = aggregate!.connection.subscriptionBuilder()
        .onApplied(() => resolve(subscription))
        .onError((_ctx, error) => reject(error))
        .subscribe(["SELECT * FROM my_coding_room_timeline_window"]);
    }));
    const aggregateRows = [...aggregate.connection.db.myCodingRoomTimelineWindow.iter()];
    assert.equal(aggregateRows.length, 8 * 256, "identity-wide selected heads remain hard bounded");
    assert.equal(new Set(aggregateRows.map((row) => row.selectionRowId)).size, aggregateRows.length);
    const memberKey = owner.auth.identity.toHexString();
    const requestIdPrefix = `"${memberKey.length}:${memberKey}`;
    const [identityRequests, identityExpirations] = await Promise.all([
      privateSql("SELECT id FROM coding_room_timeline_page_request"),
      privateSql("SELECT request_id FROM coding_room_timeline_selection_expiration"),
    ]);
    assert.equal(identityRequests.split(requestIdPrefix).length - 1, 8,
      "the identity has at most eight selected-head request rows");
    assert.equal(identityExpirations.split(requestIdPrefix).length - 1, 8,
      "the identity has exactly one scheduled expiry per bounded selection");
  } finally {
    for (const subscription of subscriptions) if (subscription.isActive()) subscription.unsubscribe();
    owner.disconnect();
    second?.disconnect();
    reconnected?.disconnect();
    aggregate?.disconnect();
  }
});

test("a chat wake-up committed at the terminal job boundary is superseded, not stranded", {
  skip: !enabled,
  timeout: 20_000,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = `verification/coding-terminal-chat/${suffix}`;
  const jobId = `coding-terminal-chat-${suffix}`;
  const control = await connectSpacetimeControlPlaneFromEnv();
  assert.ok(control);
  let queue: Awaited<ReturnType<typeof createSpacetimeJobQueue>> | undefined;
  try {
    await control.ensureWorkspace(workspaceId, "Coding terminal chat verification");
    queue = await createSpacetimeJobQueue({ control, workspaceId });
    await queue.enqueue({
      requestId: `request-${suffix}`,
      jobId,
      agentId: "coding-agent",
      payload: { kind: "coding-agent.run", runId: `run-${suffix}` },
      maxAttempts: 2,
    });
    const lease = await queue.leaseNext({ workerId: "terminal-chat-worker", leaseMs: 5_000 });
    assert.ok(lease?.leaseFence);
    const completed = await queue.complete(
      jobId,
      "terminal-chat-worker",
      { status: "completed" },
      lease.leaseFence,
    );
    assert.equal(completed?.status, "completed");
    const command = await queue.queueCommand({
      commandId: `terminal-command-${suffix}`,
      jobId,
      command: "steer",
      payload: { messageId: `message-${suffix}`, problem: "One last room note" },
      by: "test",
    });
    assert.ok(command?.consumedAt);
    assert.match(command?.consumedBy ?? "", /^job_terminal_/);
  } finally {
    queue?.close();
    control.disconnect();
  }
});
