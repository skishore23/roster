import assert from "node:assert/strict";
import test from "node:test";

import { hashCanonical } from "../../src/core/canonical.ts";
import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  DynamicTaskDispatcher,
  createDefaultDynamicTaskAcceptanceRegistry,
  DynamicTaskHandlerRegistry,
  InMemoryTaskGraphStore,
  createAcceptedTaskOutcome,
  createDynamicTaskDefinition,
  defaultTaskResultContract,
  taskGraphExpansionHash,
  validateDynamicTaskDefinition,
} from "../../src/engine/orchestration/task-graph.ts";
import {
  InMemoryTaskGraphControl,
  taskGraphTask,
} from "../../src/engine/orchestration/task-graph-control.ts";
import {
  ROSTER_DATA_REFERENCE_VERSION,
  type DataReference,
  type DynamicTaskDefinition,
  type RunExecutionPolicy,
  type TaskDependency,
  type TaskJoinPolicy,
  type TaskResultContract,
} from "../../src/engine/platform/protocol.ts";
import { createTaskExecutionGrant } from "../../src/engine/platform/execution-grant.ts";

const POLICY: RunExecutionPolicy = {
  maxTasks: 32,
  maxDepth: 4,
  maxFanout: 8,
  maxInflight: 1,
  maxReady: 32,
  maxBlocked: 32,
  maxAttempts: 3,
  maxContextBytes: 64_000,
  maxCostMicros: 1_000_000,
  maxTokens: 100_000,
  maxWallTimeMs: 10_000,
};

type DefinitionOptions = {
  readonly semanticKey?: string;
  readonly handler?: string;
  readonly dependencies?: ReadonlyArray<TaskDependency>;
  readonly join?: TaskJoinPolicy;
  readonly result?: TaskResultContract;
  readonly parentTaskId?: string;
  readonly retryAttempts?: number;
  readonly objective?: string;
  readonly dataReferences?: ReadonlyArray<DataReference>;
};

const definition = (
  taskId: string,
  options: DefinitionOptions = {},
): DynamicTaskDefinition => createDynamicTaskDefinition({
  taskId,
  semanticKey: options.semanticKey ?? `semantic:${taskId}`,
  nodeId: "coordinator",
  capability: "coordinate",
  objective: options.objective ?? `Complete ${taskId}`,
  handler: { kind: options.handler ?? "text", version: "1" },
  acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
  result: options.result ?? defaultTaskResultContract(),
  dependencies: options.dependencies ?? [],
  join: options.join ?? { kind: "all-success" },
  inputs: {
    inputVersions: { target: "target-v1" },
    dataReferences: options.dataReferences ?? [],
    frontierVersion: "frontier-v1",
    topologyVersion: "topology-v1",
    catalogVersion: "catalog-v1",
  },
  runtimeBindingEpoch: 0,
  retry: {
    maxAttempts: options.retryAttempts ?? 2,
    initialBackoffMs: 0,
    maximumBackoffMs: 0,
  },
  timeoutMs: 1_000,
  sideEffect: "pure",
  estimatedCostMicros: 10,
  ...(options.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
});

test("task inputs reject path-shaped artifact identities before durable admission", () => {
  assert.throws(
    () => validateDynamicTaskDefinition(definition("unsafe-reference", {
      dataReferences: [{
        schemaVersion: ROSTER_DATA_REFERENCE_VERSION,
        referenceId: "data_0123456789abcdef0123456789abcdef",
        contentHash: "content-hash",
        mediaType: "text/plain",
        byteLength: 1,
        storage: "artifact",
        artifactId: "roster-data/unsafe/blob",
      }],
    })),
    /artifact data reference.*contains unsafe characters/,
  );
});

const outcome = (
  task: DynamicTaskDefinition,
  attempt: number,
  value = task.taskId,
  runId = "unit-run",
) => createAcceptedTaskOutcome({
  runId,
  taskId: task.taskId,
  nodeId: task.nodeId,
  attempt,
  definitionHash: task.definitionHash,
  inputVersions: task.inputs.inputVersions,
  frontierVersion: task.inputs.frontierVersion,
  topologyVersion: task.inputs.topologyVersion,
  catalogVersion: task.inputs.catalogVersion,
  acceptancePolicyId: task.acceptance.policyId,
  acceptancePolicyVersion: task.acceptance.policyVersion,
  artifacts: task.result.mode === "none" ? [] : [{
    artifactId: `artifact:${task.taskId}:${attempt}`,
    outputKey: task.result.outputKey,
    kind: task.result.mode,
    contentHash: hashCanonical(value),
    mediaType: task.result.mode === "json" ? "application/json" : "text/plain",
    byteLength: Buffer.byteLength(value),
    storage: "inline",
  }],
});

const acceptTask = (store: InMemoryTaskGraphStore, taskId: string): void => {
  const lease = store.lease(taskId, "test-worker");
  store.start(lease);
  store.accept(lease, outcome(lease.definition, lease.attempt));
};

const failTask = (store: InMemoryTaskGraphStore, taskId: string): void => {
  const lease = store.lease(taskId, "test-worker");
  store.start(lease);
  store.fail(lease, `${taskId} failed`, false);
};

test("dynamic task definitions have deterministic identities and natural-text defaults", () => {
  const base = definition("deterministic");
  const {
    definitionHash: _definitionHash,
    schemaVersion: _schemaVersion,
    ...definitionInput
  } = base;
  const first = createDynamicTaskDefinition({
    ...definitionInput,
    dependencies: [
      { taskId: "dependency-b", condition: "accepted" },
      { taskId: "dependency-a", condition: "accepted" },
    ],
    inputs: {
      ...definitionInput.inputs,
      inputVersions: { z: "3", a: "1" },
    },
  });
  const {
    definitionHash: _firstHash,
    schemaVersion: _firstSchema,
    ...firstInput
  } = first;
  const second = createDynamicTaskDefinition({
    ...firstInput,
    dependencies: [...first.dependencies].reverse(),
    inputs: {
      ...first.inputs,
      inputVersions: { a: "1", z: "3" },
    },
  });

  assert.equal(first.definitionHash, second.definitionHash);
  assert.deepEqual(defaultTaskResultContract("answer"), { mode: "text", outputKey: "answer" });
  assert.throws(
    () => validateDynamicTaskDefinition({ ...first, objective: "changed after hashing" }),
    /invalid definition hash/,
  );
});

test("the in-memory control conforms to idempotent initialization, fenced claims, and cancellation", async () => {
  const seed = definition("controlled");
  const control = new InMemoryTaskGraphControl();
  const initial = await control.initialize({
    runId: "controlled-run",
    policy: POLICY,
    seedTasks: [seed],
  });
  assert.equal(taskGraphTask(initial, seed.taskId)?.status, "ready");
  assert.deepEqual(
    await control.initialize({
      runId: "controlled-run",
      policy: POLICY,
      seedTasks: [seed],
    }),
    initial,
  );
  const admitted = definition("admitted");
  assert.equal((await control.enqueue(admitted)).status, "ready");
  assert.equal((await control.enqueue(admitted)).definition.definitionHash, admitted.definitionHash);
  await assert.rejects(
    control.enqueue(definition("admitted", { objective: "changed after admission" })),
    /changed after admission/,
  );
  await assert.rejects(
    control.enqueue(definition("semantic-duplicate", { semanticKey: admitted.semanticKey })),
    /duplicates semantic work/,
  );
  await assert.rejects(
    control.enqueue(definition("not-a-root", { parentTaskId: seed.taskId })),
    /must not name a parent/,
  );

  const lease = await control.claim({ taskId: seed.taskId, owner: "worker-one" });
  assert.ok(lease);
  await control.start(lease);
  await control.heartbeat(lease);
  await control.cancel({
    taskId: seed.taskId,
    reason: "operator canceled the bounded task",
    lease,
  });
  assert.equal(taskGraphTask(await control.snapshot(), seed.taskId)?.status, "canceled");
  await assert.rejects(control.heartbeat(lease), /stale lease fence/);
  await assert.rejects(
    control.initialize({
      runId: "different-run",
      policy: POLICY,
      seedTasks: [seed],
    }),
    /already initialized/,
  );

  const bounded = new InMemoryTaskGraphControl();
  await bounded.initialize({
    runId: "bounded-admission-run",
    policy: { ...POLICY, maxTasks: 1, maxReady: 1, maxBlocked: 1 },
    seedTasks: [definition("only-task")],
  });
  await assert.rejects(
    bounded.enqueue(definition("over-bound")),
    /maxTasks=1/,
  );
  assert.deepEqual(
    (await bounded.snapshot()).tasks.map((record) => record.definition.taskId),
    ["only-task"],
  );
});

test("accepted data references must match artifact hash, media type, and byte length", async () => {
  const seed = definition("reference-match");
  const control = new InMemoryTaskGraphControl();
  await control.initialize({
    runId: "reference-match-run",
    policy: POLICY,
    seedTasks: [seed],
  });
  const lease = await control.claim({ taskId: seed.taskId, owner: "worker" });
  assert.ok(lease);
  await control.start(lease);
  const accepted = outcome(seed, lease.attempt, "natural text", "reference-match-run");
  const artifact = accepted.artifacts[0]!;
  const store = new InMemoryDataReferenceStore();
  const reference = await store.put({
    value: "natural text",
    mediaType: "text/plain",
  });
  assert.equal(reference.byteLength, artifact.byteLength);
  await assert.rejects(
    control.accept({
      lease,
      outcome: accepted,
      dataReferences: [{
        artifactId: artifact.artifactId,
        reference: { ...reference, byteLength: reference.byteLength + 1 },
      }],
    }),
    /does not match artifact/,
  );
  await control.accept({
    lease,
    outcome: accepted,
    dataReferences: [{ artifactId: artifact.artifactId, reference }],
  });
  assert.equal(taskGraphTask(await control.snapshot(), seed.taskId)?.status, "accepted");
});

test("structured results are opt-in and validated only at the acceptance seam", async () => {
  const structured = definition("structured", {
    handler: "structured",
    retryAttempts: 1,
    result: {
      mode: "json",
      outputKey: "answer",
      schema: {
        type: "object",
        required: ["answer"],
        additionalProperties: false,
        properties: { answer: { type: "string" } },
      },
    },
  });
  const control = new InMemoryTaskGraphControl();
  await control.initialize({ runId: "structured-run", policy: POLICY, seedTasks: [structured] });
  const dataReferences = new InMemoryDataReferenceStore();
  const handlers = new DynamicTaskHandlerRegistry();
  handlers.register({ kind: "structured", version: "1" }, async () => ({ answer: 42 }));

  const quiescence = await new DynamicTaskDispatcher({
    runId: "structured-run",
    control,
    handlers,
    dataReferences,
  }).dispatchUntilQuiescent();
  const snapshot = await control.snapshot();

  assert.equal(quiescence.quiescent, true);
  assert.equal(taskGraphTask(snapshot, "structured")?.status, "failed");
  assert.match(taskGraphTask(snapshot, "structured")?.error ?? "", /JSON result violates its schema/);
});

test("structured summaries travel with accepted data references for transactional presentation", async () => {
  class CapturingControl extends InMemoryTaskGraphControl {
    presentationText = "";

    override async accept(
      input: Parameters<InMemoryTaskGraphControl["accept"]>[0],
    ) {
      this.presentationText = input.dataReferences?.[0]?.presentationText ?? "";
      return super.accept(input);
    }
  }

  const task = definition("peer-proposal", {
    handler: "structured",
    retryAttempts: 1,
    result: {
      mode: "json",
      outputKey: "collaboration_proposal_quality",
      schema: {
        type: "object",
        required: ["summary"],
        additionalProperties: false,
        properties: { summary: { type: "string" } },
      },
    },
  });
  const control = new CapturingControl();
  await control.initialize({ runId: "peer-proposal-run", policy: POLICY, seedTasks: [task] });
  const handlers = new DynamicTaskHandlerRegistry();
  handlers.register({ kind: "structured", version: "1" }, async () => ({
    summary: "Kai, keep the wording concise and validate the README diff.",
  }));
  await new DynamicTaskDispatcher({
    runId: "peer-proposal-run",
    control,
    handlers,
    dataReferences: new InMemoryDataReferenceStore(),
  }).dispatchUntilQuiescent();

  assert.equal(
    control.presentationText,
    "Kai, keep the wording concise and validate the README diff.",
  );
});

test("declared output envelopes expose their authored summary for transactional presentation", async () => {
  class CapturingControl extends InMemoryTaskGraphControl {
    presentationText = "";

    override async accept(
      input: Parameters<InMemoryTaskGraphControl["accept"]>[0],
    ) {
      this.presentationText = input.dataReferences?.[0]?.presentationText ?? "";
      return super.accept(input);
    }
  }

  const outputKey = "collaboration_response_implementation";
  const task = definition("peer-response", {
    handler: "structured",
    retryAttempts: 1,
    result: {
      mode: "json",
      outputKey,
      schema: {
        type: "object",
        required: [outputKey],
        additionalProperties: false,
        properties: {
          [outputKey]: {
            type: "object",
            required: ["summary"],
            additionalProperties: false,
            properties: { summary: { type: "string" } },
          },
        },
      },
    },
  });
  const control = new CapturingControl();
  await control.initialize({ runId: "peer-response-run", policy: POLICY, seedTasks: [task] });
  const handlers = new DynamicTaskHandlerRegistry();
  handlers.register({ kind: "structured", version: "1" }, async () => ({
    [outputKey]: {
      summary: "Mira, I agree with that wording and will keep validation README-only.",
    },
  }));
  await new DynamicTaskDispatcher({
    runId: "peer-response-run",
    control,
    handlers,
    dataReferences: new InMemoryDataReferenceStore(),
  }).dispatchUntilQuiescent();

  assert.equal(
    control.presentationText,
    "Mira, I agree with that wording and will keep validation README-only.",
  );
});

test("the dispatcher heartbeats the active fenced lease while a handler is running", async () => {
  class CountingControl extends InMemoryTaskGraphControl {
    heartbeats = 0;

    override async heartbeat(
      lease: Parameters<InMemoryTaskGraphControl["heartbeat"]>[0],
    ): Promise<void> {
      this.heartbeats += 1;
      await super.heartbeat(lease);
    }
  }

  const task = definition("heartbeat-task");
  const control = new CountingControl();
  await control.initialize({ runId: "heartbeat-run", policy: POLICY, seedTasks: [task] });
  const handlers = new DynamicTaskHandlerRegistry();
  handlers.register({ kind: "text", version: "1" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 12));
    return "heartbeating work completed";
  });
  await new DynamicTaskDispatcher({
    runId: "heartbeat-run",
    control,
    handlers,
    dataReferences: new InMemoryDataReferenceStore(),
    heartbeatMs: 2,
  }).dispatchUntilQuiescent();

  assert.ok(control.heartbeats >= 1);
  assert.equal(taskGraphTask(await control.snapshot(), task.taskId)?.status, "accepted");
});

test("a heartbeat tolerates an externally expanded parent lease retiring into its continuation", async () => {
  const root = definition("external-expansion-root", {
    handler: "external-expander",
    result: { mode: "none" },
  });
  const child = definition("external-expansion-child", {
    handler: "external-child",
    parentTaskId: root.taskId,
  });
  const continuation = definition("external-expansion-continuation", {
    handler: "external-continuation",
    parentTaskId: root.taskId,
    dependencies: [{ taskId: child.taskId, condition: "accepted" }],
  });
  const control = new InMemoryTaskGraphControl();
  await control.initialize({
    runId: "external-expansion-run",
    policy: POLICY,
    seedTasks: [root],
  });
  const handlers = new DynamicTaskHandlerRegistry();
  handlers.register({ kind: "external-expander", version: "1" }, async ({ lease }) => {
    await control.expand({
      parentTaskId: root.taskId,
      expansionKey: "external-consultation",
      definitions: [child, continuation],
      continuationTaskId: continuation.taskId,
      owner: lease.owner,
      fence: lease.fence,
    });
    await new Promise((resolve) => setTimeout(resolve, 12));
  });
  handlers.register({ kind: "external-child", version: "1" }, async () => "peer response");
  handlers.register(
    { kind: "external-continuation", version: "1" },
    async () => "resumed response",
  );

  await new DynamicTaskDispatcher({
    runId: "external-expansion-run",
    control,
    handlers,
    dataReferences: new InMemoryDataReferenceStore(),
    heartbeatMs: 2,
  }).dispatchUntilQuiescent();

  const snapshot = await control.snapshot();
  assert.equal(taskGraphTask(snapshot, root.taskId)?.status, "skipped");
  assert.equal(taskGraphTask(snapshot, child.taskId)?.status, "accepted");
  assert.equal(taskGraphTask(snapshot, continuation.taskId)?.status, "accepted");
});

test("the async graph control releases an expanding parent and continuations resolve child bodies by reference", async () => {
  const root = definition("root", {
    handler: "supervisor",
    result: { mode: "none" },
  });
  const downstream = definition("downstream-after-continuation", {
    handler: "downstream",
    dependencies: [{ taskId: root.taskId, condition: "accepted" }],
  });
  const control = new InMemoryTaskGraphControl();
  await control.initialize({ runId: "continuation-run", policy: POLICY, seedTasks: [root, downstream] });
  const dataReferences = new InMemoryDataReferenceStore();
  const handlers = new DynamicTaskHandlerRegistry();
  let active = 0;
  let maximumActive = 0;

  handlers.register({ kind: "supervisor", version: "1" }, async ({ expand }) => {
    const left = definition("left", { handler: "leaf", parentTaskId: "root" });
    const right = definition("right", { handler: "leaf", parentTaskId: "root" });
    const continuation = definition("continuation", {
      handler: "continuation",
      parentTaskId: "root",
      dependencies: [
        { taskId: "right", condition: "accepted" },
        { taskId: "left", condition: "accepted" },
      ],
    });
    await expand({
      expansionKey: "decompose",
      definitions: [left, right, continuation],
      continuationTaskId: continuation.taskId,
    });
  });
  handlers.register({ kind: "leaf", version: "1" }, async ({ definition: task }) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    return `bounded result from ${task.taskId}`;
  });
  handlers.register({ kind: "continuation", version: "1" }, async ({
    dependencyOutcomes,
    dependencyDataReferences,
    readDataReference,
  }) => {
    assert.deepEqual(Object.keys(dependencyOutcomes).sort(), ["left", "right"]);
    assert.ok(dependencyOutcomes.left);
    assert.ok(dependencyOutcomes.right);
    assert.equal(dependencyDataReferences.left?.length, 1);
    assert.equal(dependencyDataReferences.right?.length, 1);
    const bodies = await Promise.all(
      ["left", "right"].map(async (taskId) =>
        readDataReference(dependencyDataReferences[taskId]![0]!.reference)),
    );
    assert.deepEqual(bodies, ["bounded result from left", "bounded result from right"]);
    return "joined result";
  });
  handlers.register({ kind: "downstream", version: "1" }, async ({
    dependencyOutcomes,
    dependencyDataReferences,
    readDataReference,
  }) => {
    assert.equal(dependencyOutcomes[root.taskId]?.taskId, "continuation");
    assert.equal(dependencyDataReferences[root.taskId]?.length, 1);
    assert.equal(
      await readDataReference(dependencyDataReferences[root.taskId]![0]!.reference),
      "joined result",
    );
    return "downstream consumed the resumed result";
  });

  const quiescence = await new DynamicTaskDispatcher({
    runId: "continuation-run",
    control,
    handlers,
    dataReferences,
  }).dispatchUntilQuiescent();
  const snapshot = await control.snapshot();

  assert.equal(quiescence.quiescent, true);
  assert.equal(quiescence.deadlocked, false);
  assert.equal(maximumActive, 1);
  assert.equal(taskGraphTask(snapshot, "root")?.status, "skipped");
  assert.equal(taskGraphTask(snapshot, "left")?.status, "accepted");
  assert.equal(taskGraphTask(snapshot, "right")?.status, "accepted");
  assert.equal(taskGraphTask(snapshot, "continuation")?.status, "accepted");
  assert.equal(taskGraphTask(snapshot, downstream.taskId)?.status, "accepted");
  assert.equal(taskGraphTask(snapshot, "root")?.leaseOwner, undefined);
  assert.equal(snapshot.outcomeDataReferences.length, 4);
  const restored = InMemoryTaskGraphStore.restore(snapshot);
  assert.equal(restored.task(root.taskId)?.status, "skipped");
  assert.equal(restored.task(downstream.taskId)?.status, "accepted");
});

test("the dispatcher rejects graph expansion that was not admitted by the task grant", async () => {
  const root = definition("ungranted-root", {
    handler: "ungranted-supervisor",
    result: { mode: "none" },
  });
  const control = new InMemoryTaskGraphControl();
  await control.initialize({ runId: "ungranted-run", policy: POLICY, seedTasks: [root] });
  const handlers = new DynamicTaskHandlerRegistry();
  handlers.register({ kind: "ungranted-supervisor", version: "1" }, async ({ expand }) => {
    await expand({
      expansionKey: "not-admitted",
      definitions: [
        definition("ungranted-child", {
          parentTaskId: root.taskId,
          result: { mode: "none" },
        }),
      ],
      continuationTaskId: "ungranted-child",
    });
  });

  await new DynamicTaskDispatcher({
    runId: "ungranted-run",
    control,
    handlers,
    dataReferences: new InMemoryDataReferenceStore(),
    createExecutionGrant: ({ definition: task, lease, policy }) =>
      createTaskExecutionGrant({
        runId: "ungranted-run",
        definition: task,
        attempt: lease.attempt,
        fence: lease.fence,
        policyVersion: "ungranted-policy.v1",
        policy,
        allowGraphExpansion: false,
      }),
  }).dispatchUntilQuiescent();

  const snapshot = await control.snapshot();
  assert.equal(taskGraphTask(snapshot, root.taskId)?.status, "failed");
  assert.match(
    taskGraphTask(snapshot, root.taskId)?.error ?? "",
    /does not authorize graph expansion/,
  );
  assert.deepEqual(snapshot.tasks.map(({ definition: task }) => task.taskId), [root.taskId]);
});

test("expansion is atomic, semantically deduplicated, and exactly idempotent across fences", () => {
  const root = definition("root", { result: { mode: "none" } });
  const store = new InMemoryTaskGraphStore(POLICY, [root]);
  const parentLease = store.lease("root", "worker-a");
  store.start(parentLease);
  const left = definition("left", { parentTaskId: "root" });
  const continuation = definition("continuation", {
    parentTaskId: "root",
    dependencies: [{ taskId: "left", condition: "accepted" }],
  });
  const expansionInput = {
    parentTaskId: "root",
    fence: parentLease.fence,
    owner: parentLease.owner,
    expansionKey: "first",
    definitions: [left, continuation],
    continuationTaskId: "continuation",
  } as const;
  const published = store.expand(expansionInput);

  const replayed = store.expand({
    ...expansionInput,
    owner: "worker-after-crash",
    fence: parentLease.fence + 100,
  });
  assert.deepEqual(replayed, published);
  assert.equal(store.tasks().length, 3);
  assert.throws(
    () => store.expand({
      ...expansionInput,
      owner: "worker-after-crash",
      fence: parentLease.fence + 101,
      definitions: [
        definition("left", { parentTaskId: "root", objective: "changed" }),
        continuation,
      ],
    }),
    /changed after publication/,
  );

  const atomicStore = new InMemoryTaskGraphStore(POLICY, [root]);
  const atomicLease = atomicStore.lease("root", "worker-a");
  atomicStore.start(atomicLease);
  assert.throws(
    () => atomicStore.expand({
      parentTaskId: "root",
      fence: atomicLease.fence,
      owner: atomicLease.owner,
      expansionKey: "duplicate-work",
      definitions: [
        definition("duplicate", {
          semanticKey: root.semanticKey,
          parentTaskId: "root",
        }),
        definition("duplicate-continuation", {
          parentTaskId: "root",
          dependencies: [{ taskId: "duplicate", condition: "accepted" }],
        }),
      ],
      continuationTaskId: "duplicate-continuation",
    }),
    /duplicates semantic work/,
  );
  assert.equal(atomicStore.tasks().length, 1);
  assert.equal(atomicStore.task("root")?.status, "running");
});

test("snapshot restore rejects incomplete, stale, and content-forged expansion proofs", () => {
  const root = definition("proof-root", { result: { mode: "none" } });
  const store = new InMemoryTaskGraphStore(POLICY, [root]);
  const lease = store.lease(root.taskId, "proof-worker");
  store.start(lease);
  const child = definition("proof-child", { parentTaskId: root.taskId });
  const continuation = definition("proof-continuation", {
    parentTaskId: root.taskId,
    dependencies: [{ taskId: child.taskId, condition: "accepted" }],
  });
  store.expand({
    parentTaskId: root.taskId,
    fence: lease.fence,
    owner: lease.owner,
    expansionKey: "proof-expansion",
    definitions: [child, continuation],
    continuationTaskId: continuation.taskId,
  });
  const snapshot = store.snapshot();
  const expansion = snapshot.expansions[0]!;

  assert.throws(
    () => InMemoryTaskGraphStore.restore({
      ...snapshot,
      expansions: [{ ...expansion, childTaskIds: [] }],
    }),
    /at least one child|changed child identity/,
  );
  assert.throws(
    () => InMemoryTaskGraphStore.restore({
      ...snapshot,
      expansions: [{ ...expansion, publishedFence: expansion.publishedFence + 1 }],
    }),
    /published fence|retired lease fence/,
  );

  const mutatedChild = { ...child, objective: "Mutated after durable publication" };
  assert.throws(
    () => InMemoryTaskGraphStore.restore({
      ...snapshot,
      tasks: snapshot.tasks.map((task) => task.definition.taskId === child.taskId
        ? { ...task, definition: mutatedChild }
        : task),
    }),
    /invalid definition hash/,
  );

  const forgedChild = { ...mutatedChild, definitionHash: "forged-definition-hash" };
  assert.throws(
    () => InMemoryTaskGraphStore.restore({
      ...snapshot,
      tasks: snapshot.tasks.map((task) => task.definition.taskId === child.taskId
        ? { ...task, definition: forgedChild }
        : task),
      expansions: [{
        ...expansion,
        expansionHash: taskGraphExpansionHash({
          parentTaskId: expansion.parentTaskId,
          expansionKey: expansion.expansionKey,
          continuationTaskId: expansion.continuationTaskId,
          definitions: [forgedChild, continuation],
        }),
      }],
    }),
    /invalid definition hash/,
  );
});

test("expanded parent cancellation remains structurally replayable after publication", () => {
  const root = definition("canceled-expansion-root", { result: { mode: "none" } });
  const store = new InMemoryTaskGraphStore(POLICY, [root]);
  const lease = store.lease(root.taskId, "cancel-worker");
  store.start(lease);
  const child = definition("canceled-expansion-child", { parentTaskId: root.taskId });
  const continuation = definition("canceled-expansion-continuation", {
    parentTaskId: root.taskId,
    dependencies: [{ taskId: child.taskId, condition: "accepted" }],
  });
  store.expand({
    parentTaskId: root.taskId,
    fence: lease.fence,
    owner: lease.owner,
    expansionKey: "canceled-expansion",
    definitions: [child, continuation],
    continuationTaskId: continuation.taskId,
  });
  store.cancel(root.taskId, "operator canceled the published expansion");
  const canceled = store.snapshot();
  assert.equal(canceled.tasks.find((task) => task.definition.taskId === root.taskId)?.status, "canceled");
  assert.equal(InMemoryTaskGraphStore.restore(canceled).task(root.taskId)?.status, "canceled");

  const budgetExhausted = {
    ...canceled,
    tasks: canceled.tasks.map((task) => task.definition.taskId === root.taskId
      ? { ...task, error: "execution budget exhausted after expansion publication" }
      : task),
  };
  assert.equal(
    InMemoryTaskGraphStore.restore(budgetExhausted).task(root.taskId)?.status,
    "canceled",
  );
});

test("expansion parent status stays canonical with its continuation lifecycle", () => {
  const root = definition("status-relation-root", { result: { mode: "none" } });
  const store = new InMemoryTaskGraphStore(POLICY, [root]);
  const lease = store.lease(root.taskId, "status-relation-worker");
  store.start(lease);
  const child = definition("status-relation-child", { parentTaskId: root.taskId });
  const continuation = definition("status-relation-continuation", {
    parentTaskId: root.taskId,
    dependencies: [{ taskId: child.taskId, condition: "accepted" }],
  });
  store.expand({
    parentTaskId: root.taskId,
    fence: lease.fence,
    owner: lease.owner,
    expansionKey: "status-relation-expansion",
    definitions: [child, continuation],
    continuationTaskId: continuation.taskId,
  });
  const waiting = store.snapshot();
  assert.equal(waiting.tasks.find((task) => task.definition.taskId === root.taskId)?.status, "waiting");
  assert.equal(
    InMemoryTaskGraphStore.restore(waiting).task(root.taskId)?.status,
    "waiting",
    "a nonterminal continuation keeps its expanded parent waiting",
  );

  const withStatuses = (
    parentStatus: "waiting" | "skipped",
    continuationStatus: "ready" | "accepted" | "failed" | "canceled" | "skipped",
  ) => ({
    ...waiting,
    tasks: waiting.tasks.map((task) => task.definition.taskId === root.taskId
      ? { ...task, status: parentStatus }
      : task.definition.taskId === continuation.taskId
        ? { ...task, status: continuationStatus }
        : task),
  });
  assert.throws(
    () => InMemoryTaskGraphStore.restore(withStatuses("skipped", "ready")),
    /continuation.*status|status.*continuation/,
  );
  for (const terminalStatus of ["accepted", "failed", "canceled", "skipped"] as const) {
    assert.throws(
      () => InMemoryTaskGraphStore.restore(withStatuses("waiting", terminalStatus)),
      /continuation.*status|status.*continuation/,
    );
  }

  const canceledStore = InMemoryTaskGraphStore.restore(waiting);
  canceledStore.cancel(root.taskId, "operator canceled while the continuation was pending");
  acceptTask(canceledStore, child.taskId);
  acceptTask(canceledStore, continuation.taskId);
  const canceledAfterSettlement = canceledStore.snapshot();
  assert.equal(
    canceledAfterSettlement.tasks.find((task) => task.definition.taskId === continuation.taskId)?.status,
    "accepted",
  );
  assert.equal(
    InMemoryTaskGraphStore.restore(canceledAfterSettlement).task(root.taskId)?.status,
    "canceled",
    "control-authorized cancellation remains valid after its continuation later settles",
  );

  acceptTask(store, child.taskId);
  acceptTask(store, continuation.taskId);
  const settled = store.snapshot();
  assert.equal(settled.tasks.find((task) => task.definition.taskId === root.taskId)?.status, "skipped");
  assert.equal(InMemoryTaskGraphStore.restore(settled).task(root.taskId)?.status, "skipped");
});

test("expansion pair identity is collision-safe for colon-containing IDs", () => {
  const leftParent = definition("pair:parent", { result: { mode: "none" } });
  const rightParent = definition("pair", { result: { mode: "none" } });
  const store = new InMemoryTaskGraphStore(POLICY, [leftParent, rightParent]);
  const publish = (parentTaskId: string, expansionKey: string, suffix: string) => {
    const lease = store.lease(parentTaskId, `worker-${suffix}`);
    store.start(lease);
    const child = definition(`pair-child-${suffix}`, { parentTaskId });
    const continuation = definition(`pair-continuation-${suffix}`, {
      parentTaskId,
      dependencies: [{ taskId: child.taskId, condition: "accepted" }],
    });
    store.expand({
      parentTaskId,
      fence: lease.fence,
      owner: lease.owner,
      expansionKey,
      definitions: [child, continuation],
      continuationTaskId: continuation.taskId,
    });
  };
  publish(leftParent.taskId, "key", "left");
  publish(rightParent.taskId, "parent:key", "right");
  const snapshot = store.snapshot();
  assert.equal(snapshot.expansions.length, 2);
  assert.equal(InMemoryTaskGraphStore.restore(snapshot).snapshot().expansions.length, 2);
  assert.throws(
    () => InMemoryTaskGraphStore.restore({
      ...snapshot,
      expansions: [...snapshot.expansions, snapshot.expansions[0]!],
    }),
    /repeats expansion/,
  );
});

test("join policies distinguish success, terminality, any success, and quorum", () => {
  const allSuccess = new InMemoryTaskGraphStore(POLICY, [
    definition("success-a"),
    definition("success-b", { retryAttempts: 1 }),
    definition("all-success", {
      dependencies: [
        { taskId: "success-a", condition: "accepted" },
        { taskId: "success-b", condition: "accepted" },
      ],
      join: { kind: "all-success" },
    }),
    definition("after-all-success", {
      dependencies: [{ taskId: "all-success", condition: "accepted" }],
    }),
  ]);
  acceptTask(allSuccess, "success-a");
  assert.equal(allSuccess.task("all-success")?.status, "pending");
  const unacceptedDraft = allSuccess.lease("success-b", "test-worker");
  allSuccess.start(unacceptedDraft);
  assert.equal(allSuccess.task("all-success")?.status, "pending");
  allSuccess.fail(unacceptedDraft, "draft was rejected", false);
  assert.equal(allSuccess.task("all-success")?.status, "skipped");
  assert.equal(allSuccess.task("after-all-success")?.status, "skipped");

  const allTerminal = new InMemoryTaskGraphStore(POLICY, [
    definition("terminal-a"),
    definition("terminal-b", { retryAttempts: 1 }),
    definition("all-terminal", {
      dependencies: [
        { taskId: "terminal-a", condition: "terminal" },
        { taskId: "terminal-b", condition: "terminal" },
      ],
      join: { kind: "all-terminal" },
    }),
  ]);
  acceptTask(allTerminal, "terminal-a");
  failTask(allTerminal, "terminal-b");
  assert.equal(allTerminal.task("all-terminal")?.status, "ready");

  const anySuccess = new InMemoryTaskGraphStore(POLICY, [
    definition("any-a"),
    definition("any-b"),
    definition("any-success", {
      dependencies: [
        { taskId: "any-a", condition: "accepted" },
        { taskId: "any-b", condition: "accepted" },
      ],
      join: { kind: "any-success" },
    }),
  ]);
  acceptTask(anySuccess, "any-a");
  assert.equal(anySuccess.task("any-success")?.status, "ready");

  const noSuccess = new InMemoryTaskGraphStore(POLICY, [
    definition("none-a"),
    definition("none-b"),
    definition("no-success", {
      dependencies: [
        { taskId: "none-a", condition: "accepted" },
        { taskId: "none-b", condition: "accepted" },
      ],
      join: { kind: "any-success" },
    }),
  ]);
  noSuccess.cancel("none-a", "canceled");
  assert.equal(noSuccess.task("no-success")?.status, "pending");
  noSuccess.cancel("none-b", "canceled");
  assert.equal(noSuccess.task("no-success")?.status, "skipped");

  const quorum = new InMemoryTaskGraphStore(POLICY, [
    definition("quorum-a"),
    definition("quorum-b"),
    definition("quorum-c"),
    definition("quorum-join", {
      dependencies: [
        { taskId: "quorum-a", condition: "accepted" },
        { taskId: "quorum-b", condition: "accepted" },
        { taskId: "quorum-c", condition: "accepted" },
      ],
      join: { kind: "quorum", count: 2 },
    }),
  ]);
  acceptTask(quorum, "quorum-a");
  quorum.cancel("quorum-b", "not needed");
  quorum.cancel("quorum-c", "not needed");
  assert.equal(quorum.task("quorum-join")?.status, "skipped");
});

test("snapshot replay recovers interrupted work, fences stale workers, and deduplicates acceptance", () => {
  const original = new InMemoryTaskGraphStore(POLICY, [definition("crash-task")]);
  const interrupted = original.lease("crash-task", "crashed-worker");
  original.start(interrupted);

  const restored = InMemoryTaskGraphStore.restore(original.snapshot());
  assert.equal(restored.recoverInterruptedLeases(), 1);
  assert.equal(restored.task("crash-task")?.status, "ready");

  const next = restored.lease("crash-task", "replacement-worker");
  restored.start(next);
  assert.equal(next.attempt, 2);
  assert.ok(next.fence > interrupted.fence);
  assert.throws(
    () => restored.accept(interrupted, outcome(interrupted.definition, interrupted.attempt)),
    /stale lease fence/,
  );

  const accepted = outcome(next.definition, next.attempt);
  assert.equal(restored.accept(next, accepted).outcomeId, accepted.outcomeId);
  assert.equal(
    restored.accept({ ...next, owner: "replayed-worker", fence: next.fence + 10 }, accepted).outcomeId,
    accepted.outcomeId,
  );
  const replayed = InMemoryTaskGraphStore.restore(restored.snapshot());
  assert.equal(replayed.task("crash-task")?.status, "accepted");
  assert.equal(replayed.quiescence().deadlocked, false);
});

test("failed bounded expansion does not partially mutate the authoritative graph", () => {
  const bounded = new InMemoryTaskGraphStore({
    ...POLICY,
    maxTasks: 3,
    maxFanout: 2,
    maxReady: 3,
    maxBlocked: 3,
  }, [definition("bounded-root", { result: { mode: "none" } })]);
  const lease = bounded.lease("bounded-root", "worker");
  bounded.start(lease);

  assert.throws(
    () => bounded.expand({
      parentTaskId: "bounded-root",
      fence: lease.fence,
      owner: lease.owner,
      expansionKey: "too-large",
      definitions: [
        definition("bounded-a", { parentTaskId: "bounded-root" }),
        definition("bounded-b", { parentTaskId: "bounded-root" }),
        definition("bounded-continuation", {
          parentTaskId: "bounded-root",
          dependencies: [
            { taskId: "bounded-a", condition: "accepted" },
            { taskId: "bounded-b", condition: "accepted" },
          ],
        }),
      ],
      continuationTaskId: "bounded-continuation",
    }),
    /maxTasks=3/,
  );
  assert.equal(bounded.tasks().length, 1);
  assert.equal(bounded.task("bounded-root")?.status, "running");
});

for (const result of [{ mode: "none" as const }, defaultTaskResultContract()]) {
  test(`cancellation rejects late ${result.mode} output before acceptance`, async () => {
    const control = new InMemoryTaskGraphControl();
    const root = definition("interrupted", { result });
    await control.initialize({ runId: "interrupted-run", policy: POLICY, seedTasks: [root] });
    const abort = new AbortController();
    const handlers = new DynamicTaskHandlerRegistry();
    handlers.register(root.handler, async ({ signal }) => {
      abort.abort(new Error("operator canceled"));
      assert.equal(signal.aborted, true);
      return "late result";
    });
    await assert.rejects(new DynamicTaskDispatcher({
      runId: "interrupted-run", control, handlers, signal: abort.signal,
      dataReferences: new InMemoryDataReferenceStore(),
    }).dispatchUntilQuiescent(), /operator canceled/);
    const snapshot = await control.snapshot();
    assert.equal(snapshot.tasks[0]?.status, "failed");
    assert.equal(snapshot.tasks[0]?.outcome, undefined);
    assert.equal(snapshot.outcomeDataReferences.length, 0);
  });
}

test("cancellation during acceptance rejects admission even if the hook later returns", async () => {
  const control = new InMemoryTaskGraphControl();
  const root = definition("delayed-admission", { result: { mode: "none" } });
  await control.initialize({ runId: "admission-run", policy: POLICY, seedTasks: [root] });
  const abort = new AbortController();
  const handlers = new DynamicTaskHandlerRegistry();
  handlers.register(root.handler, async () => undefined);
  const acceptance = createDefaultDynamicTaskAcceptanceRegistry();
  const original = acceptance.resolve(root.acceptance);
  // Give this test an independent versioned acceptance policy.
  const { DynamicTaskAcceptanceRegistry } = await import("../../src/engine/orchestration/task-graph.ts");
  const delayed = new DynamicTaskAcceptanceRegistry();
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  delayed.register(root.acceptance, async (input) => {
    abort.abort(new Error("interrupted admission"));
    await completed;
    return original(input);
  });
  await assert.rejects(new DynamicTaskDispatcher({
    runId: "admission-run", control, handlers, acceptance: delayed, signal: abort.signal,
    dataReferences: new InMemoryDataReferenceStore(),
  }).dispatchUntilQuiescent(), /interrupted admission/);
  finish();
  await Promise.resolve();
  assert.equal((await control.snapshot()).tasks[0]?.outcome, undefined);
});

test("in-memory retry backoff stays live until the next eligible attempt", async () => {
  const { definitionHash: _definitionHash, ...original } = definition("backoff");
  const root = createDynamicTaskDefinition({ ...original, retry: { maxAttempts: 2, initialBackoffMs: 30, maximumBackoffMs: 30 } });
  const control = new InMemoryTaskGraphControl();
  await control.initialize({ runId: "backoff-run", policy: POLICY, seedTasks: [root] });
  const handlers = new DynamicTaskHandlerRegistry();
  let firstFailureAt = 0;
  let attempts = 0;
  handlers.register(root.handler, async () => {
    attempts += 1;
    if (attempts === 1) { firstFailureAt = Date.now(); throw new Error("transient"); }
    assert.ok(Date.now() - firstFailureAt >= 30);
    return "recovered";
  });
  const result = await new DynamicTaskDispatcher({
    runId: "backoff-run", control, handlers, dataReferences: new InMemoryDataReferenceStore(),
  }).dispatchUntilQuiescent();
  assert.equal(result.deadlocked, false);
  assert.equal(attempts, 2);
  assert.equal((await control.snapshot()).tasks[0]?.status, "accepted");
});

test("retry snapshots preserve eligibility across restore and clear it on cancellation", async () => {
  const { VirtualClock } = await import("../../src/core/clock.ts");
  const clock = new VirtualClock(1_000);
  const { definitionHash: _definitionHash, ...original } = definition("restored-retry");
  const root = createDynamicTaskDefinition({ ...original, retry: { maxAttempts: 2, initialBackoffMs: 30, maximumBackoffMs: 30 } });
  const store = new InMemoryTaskGraphStore(POLICY, [root], clock);
  const lease = store.lease(root.taskId, "worker");
  store.start(lease);
  store.fail(lease, "transient", true);
  const snapshot = store.snapshot();
  assert.equal(snapshot.tasks[0]?.retryAt, 1_030);
  const resumed = InMemoryTaskGraphStore.restore(snapshot, clock);
  assert.equal(resumed.quiescence().deadlocked, false);
  assert.deepEqual(resumed.ready(), []);
  await clock.advanceBy(29);
  assert.deepEqual(resumed.ready(), []);
  await clock.advanceBy(1);
  assert.equal(resumed.leaseNext("replacement")?.attempt, 2);

  const canceled = InMemoryTaskGraphStore.restore(snapshot, new VirtualClock(1_000));
  canceled.cancel(root.taskId, "operator canceled");
  assert.equal(canceled.snapshot().tasks[0]?.retryAt, undefined);
  assert.equal(InMemoryTaskGraphStore.restore(canceled.snapshot(), clock).task(root.taskId)?.status, "canceled");
});
