import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID,
  CODING_WORKSPACE_READ_FUNCTION_ID,
  bindCodingWorkerFunctionProviders,
  createCodingWorkerFunctionDescriptors,
} from "../../src/domains/coding-workers.ts";
import { defineCodingAgentPlatform } from "../../src/domains/coding.ts";
import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import { RosterFunctionDirectory } from "../../src/engine/functions/function-directory.ts";
import { ROSTER_MEMORY_PROPOSE_FUNCTION_ID } from "../../src/engine/runtime/node-memory-plane.ts";
import { NodeRoomUpdateStore } from "../../src/engine/runtime/node-room-updates.ts";
import {
  ROSTER_CATALOG_INVOKE_FUNCTION_ID,
  ROSTER_CATALOG_SEARCH_FUNCTION_ID,
  createRosterFunctionExecutionPlane,
  type RosterFunctionActivity,
} from "../../src/engine/runtime/node-function-plane.ts";
import { ROSTER_WORKSPACE_PUBLISH_FUNCTION_ID } from "../../src/engine/platform/roster-platform.ts";

const ROOM_UPDATE_FUNCTION_ID = "coding::room.post-update";
const ROOM_UPDATE_SCOPE = "room:update";

const NODE = {
  id: "coding-worker",
  name: "Coding Worker",
  capabilities: ["workspace"],
  runtime: { kind: "roster-native" as const },
};

test("Coding discovers and composes repository workers without returning intermediate file contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-coding-workers-"));
  const outside = await mkdtemp(join(tmpdir(), "roster-coding-outside-"));
  const document = [
    "Title: Changelog",
    ...Array.from({ length: 240 }, (_, index) => `private implementation detail ${index}`),
    "Title: CLI reference",
  ].join("\n");
  await writeFile(join(root, "notes.txt"), document, "utf8");
  await writeFile(join(outside, "secret.txt"), "outside workspace", "utf8");
  await symlink(join(outside, "secret.txt"), join(root, "escaped.txt"));

  const directory = new RosterFunctionDirectory(createCodingWorkerFunctionDescriptors());
  const dispose = await bindCodingWorkerFunctionProviders({
    directory,
    workingDirectory: root,
  });
  const activities: RosterFunctionActivity[] = [];
  try {
    const plane = createRosterFunctionExecutionPlane({
      directory,
      access: () => ({
        functionGrants: directory.descriptors().map((descriptor) => descriptor.id),
        allowedEffects: ["read"],
      }),
      pipeline: {
        store: new InMemoryDataReferenceStore({
          maxEntries: 32,
          maxValueBytes: 32_000,
          maxTotalBytes: 128_000,
        }),
      },
      onActivity: async (activity) => {
        activities.push(activity);
      },
    });
    const task = {
      taskId: "inspect-doc",
      nodeId: NODE.id,
      capability: "workspace",
    };
    assert.deepEqual(plane.functionTools(NODE, task).map((tool) => tool.id), [
      ROSTER_CATALOG_SEARCH_FUNCTION_ID,
      ROSTER_CATALOG_INVOKE_FUNCTION_ID,
    ]);
    const invoke = plane.functionInvoker(NODE, task);
    const control = {
      executionId: "coding-worker-execution",
      runId: "coding-worker-run",
      nodeId: NODE.id,
      taskId: task.taskId,
    };
    const searched = await invoke({
      functionId: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
      value: { capabilities: ["workspace"], limit: 16 },
    }, control);
    assert.equal(searched.status, "completed");
    if (searched.status !== "completed") throw new Error("Expected catalog search to complete");
    const snapshot = searched.output as {
      readonly catalogVersion: string;
      readonly entries: ReadonlyArray<{
        readonly id: string;
        readonly version: string;
        readonly providers: ReadonlyArray<{ readonly providerId: string; readonly epoch: number }>;
      }>;
    };
    const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    const step = (stepId: string, functionId: string, input?: unknown) => {
      const entry = byId.get(functionId);
      const provider = entry?.providers[0];
      assert.ok(entry, `Missing ${functionId}`);
      assert.ok(provider, `Missing provider for ${functionId}`);
      return {
        stepId,
        functionId,
        functionVersion: entry.version,
        providerId: provider.providerId,
        providerEpoch: provider.epoch,
        ...(input !== undefined ? { input } : {}),
      };
    };
    const result = await invoke({
      functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
      value: {
        operation: "pipeline",
        pipelineId: "coding-title-extraction",
        catalogVersion: snapshot.catalogVersion,
        initialValue: { path: "notes.txt" },
        steps: [
          step("read", "coding::workspace.read"),
          step("text", "coding::json.get", {
            value: { $pipeline: "value" },
            pointer: "/text",
          }),
          step("split", "coding::text.split", {
            value: { $pipeline: "value" },
            separator: "\n",
          }),
          step("filter", "coding::text.filter", {
            values: { $pipeline: "value" },
            includes: "Title:",
          }),
          step("join", "coding::text.join", {
            values: { $pipeline: "value" },
            separator: ", ",
          }),
        ],
        finalProjection: { maxPreviewBytes: 256 },
      },
    }, control);
    assert.equal(result.status, "completed");
    if (result.status !== "completed") throw new Error("Expected pipeline to complete");
    const pipeline = result.output as {
      readonly preview: { readonly text: string };
      readonly receipts: ReadonlyArray<unknown>;
    };
    assert.equal(pipeline.preview.text, "Title: Changelog, Title: CLI reference");
    assert.equal(pipeline.receipts.length, 5);
    assert.deepEqual(activities.map((activity) => activity.operation), [
      "catalog.search",
      "pipeline.execute",
    ]);
    assert.doesNotMatch(JSON.stringify(activities), /private implementation detail/);

    await assert.rejects(() => directory.invoke({
      node: NODE,
      functionId: CODING_WORKSPACE_READ_FUNCTION_ID,
      value: { path: "escaped.txt" },
      access: {
        functionGrants: [CODING_WORKSPACE_READ_FUNCTION_ID],
        allowedEffects: ["read"],
      },
    }), /escapes the authorized repository root/);
  } finally {
    dispose();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Coding declares the bounded provider-neutral room update contract", () => {
  const descriptor = createCodingWorkerFunctionDescriptors().find((candidate) =>
    candidate.id === ROOM_UPDATE_FUNCTION_ID);

  assert.ok(descriptor, `Missing ${ROOM_UPDATE_FUNCTION_ID}`);
  assert.equal(descriptor.id, ROOM_UPDATE_FUNCTION_ID);
  assert.deepEqual(descriptor.effects, ["write"]);
  assert.deepEqual(descriptor.requiredScopes, [ROOM_UPDATE_SCOPE]);
  assert.equal(descriptor.idempotency, "supported");
  assert.deepEqual(descriptor.metadata, { "roster.executionProjection": "direct" });
});

test("Coding derives room recipients only from direct task dependencies", async () => {
  const { codingRoomUpdateRecipientPolicy } = await import("../../src/domains/coding-room-updates.ts");
  const tasks = [
    {
      id: "plan",
      nodeId: "planner-node",
      needs: ["request"],
      provides: ["plan-output"],
    },
    {
      id: "build",
      nodeId: "builder-node",
      needs: ["plan-output"],
      provides: ["build-output"],
    },
    {
      id: "review",
      nodeId: "reviewer-node",
      needs: ["build-output"],
      provides: ["review-output"],
    },
  ] as const;

  const buildPolicy = codingRoomUpdateRecipientPolicy(tasks, "build", "human");
  assert.deepEqual(buildPolicy, {
    upstreamNodeIds: ["planner-node"],
    downstreamNodeIds: ["reviewer-node"],
    humanNodeId: "human",
  });
  assert.ok(Object.isFrozen(buildPolicy.upstreamNodeIds));
  assert.ok(Object.isFrozen(buildPolicy.downstreamNodeIds));
  assert.deepEqual(codingRoomUpdateRecipientPolicy(tasks, "review", "human"), {
    upstreamNodeIds: ["builder-node"],
    downstreamNodeIds: [],
    humanNodeId: "human",
  });
  assert.throws(
    () => codingRoomUpdateRecipientPolicy(tasks, "review", "human", "builder-node"),
    /task review is assigned to reviewer-node, not builder-node/u,
  );
  assert.throws(
    () => codingRoomUpdateRecipientPolicy(tasks, "missing", "human"),
    /missing/u,
  );
  assert.throws(
    () => codingRoomUpdateRecipientPolicy([
      ...tasks,
      { id: "unassigned", nodeId: "", needs: ["review-output"], provides: ["final"] },
    ], "review", "human"),
    /assignment/u,
  );
});

test("Coding room updates use the fenced node and current task recipient policy", async () => {
  const { codingRoomUpdateRecipientPolicy } = await import("../../src/domains/coding-room-updates.ts");
  const tasks = [
    { id: "plan-1", nodeId: "planner-node", needs: ["request"], provides: ["plan"] },
    { id: "build-1", nodeId: "kai", needs: ["plan"], provides: ["build"] },
    { id: "review-1", nodeId: "reviewer-node", needs: ["build"], provides: ["review"] },
  ] as const;
  const roomUpdates = new NodeRoomUpdateStore({
    now: () => "2026-08-26T20:00:00.000Z",
  });
  const policyTaskIds: string[] = [];
  const directory = new RosterFunctionDirectory(createCodingWorkerFunctionDescriptors());
  const dispose = await bindCodingWorkerFunctionProviders({
    directory,
    workingDirectory: process.cwd(),
    roomUpdateProvider: {
      roomUpdates,
      recipientPolicyForTask: (taskId, nodeId) => {
        policyTaskIds.push(taskId);
        return codingRoomUpdateRecipientPolicy(tasks, taskId, "human", nodeId);
      },
    },
  });
  const access = {
    functionGrants: [ROOM_UPDATE_FUNCTION_ID],
    scopes: [ROOM_UPDATE_SCOPE],
    allowedEffects: ["write" as const],
  };
  const roomNode = {
    id: "kai",
    name: "Kai",
    capabilities: ["implement"],
    runtime: { kind: "roster-native" as const },
  };
  const roomTask = {
    taskId: "build-1",
    nodeId: "kai",
    capability: "implement",
  };
  const plane = createRosterFunctionExecutionPlane({ directory, access: () => access });
  assert.ok(plane.functionTools(roomNode, roomTask).some((tool) => tool.id === ROOM_UPDATE_FUNCTION_ID));
  const invokeProjected = plane.functionInvoker(roomNode, roomTask);
  const invoke = (
    value: Record<string, unknown>,
    metadata: Record<string, string> = {
      roster_run_id: "run-1",
      roster_task_id: "build-1",
      roster_execution_id: "execution-1",
    },
  ) => directory.invoke({
    node: roomNode,
    functionId: ROOM_UPDATE_FUNCTION_ID,
    value,
    access,
    metadata,
  });

  try {
    const first = await invokeProjected({
      functionId: ROOM_UPDATE_FUNCTION_ID,
      value: {
        updateKey: "started",
        text: "I have the accepted plan and I’m tracing the streaming path now.",
        intent: "acknowledgement",
        recipientNodeIds: ["planner-node", "human"],
      },
    }, {
      executionId: "execution-1",
      runId: "run-1",
      nodeId: roomNode.id,
      taskId: roomTask.taskId,
    });
    assert.equal(first.status, "completed");
    if (first.status !== "completed") throw new Error("Expected a completed room update");
    const stored = roomUpdates.list("run-1")[0];
    assert.deepEqual(first.output, {
      updateId: stored?.updateId,
      state: "visible",
    });
    assert.equal(stored?.nodeId, "kai");
    assert.equal(stored?.runId, "run-1");
    assert.equal(stored?.taskId, "build-1");
    assert.equal(stored?.executionId, "execution-1");

    const multibyteText = "é".repeat(420);
    await invoke({
      updateKey: "started",
      text: multibyteText,
      intent: "progress",
      recipientNodeIds: ["reviewer-node"],
    });
    assert.equal(roomUpdates.list("run-1")[0]?.text, multibyteText);

    await assert.rejects(() => invoke({
      updateKey: "spoofed",
      text: "This input must not choose its author.",
      intent: "progress",
      recipientNodeIds: ["reviewer-node"],
      nodeId: "reviewer-node",
    }), /input violates its JSON Schema/u);
    await assert.rejects(() => invoke({
      updateKey: "unauthorized",
      text: "This recipient is outside the task graph.",
      intent: "progress",
      recipientNodeIds: ["outsider"],
    }), /recipient/u);
    await assert.rejects(() => invoke({
      updateKey: "missing-task",
      text: "This invocation is missing its task fence.",
      intent: "progress",
      recipientNodeIds: ["reviewer-node"],
    }, {
      roster_run_id: "run-1",
      roster_execution_id: "execution-1",
    }), /roster_task_id/u);
    await assert.rejects(() => invoke({
      updateKey: "missing-run",
      text: "This invocation is missing its run fence.",
      intent: "progress",
      recipientNodeIds: ["reviewer-node"],
    }, {
      roster_task_id: "build-1",
      roster_execution_id: "execution-1",
    }), /roster_run_id/u);
    await assert.rejects(() => invoke({
      updateKey: "missing-execution",
      text: "This invocation is missing its execution fence.",
      intent: "progress",
      recipientNodeIds: ["reviewer-node"],
    }, {
      roster_run_id: "run-1",
      roster_task_id: "build-1",
    }), /roster_execution_id/u);
    await assert.rejects(() => invoke({
      updateKey: "wrong-task",
      text: "This invocation is bound to another task.",
      intent: "progress",
      recipientNodeIds: ["reviewer-node"],
    }, {
      roster_run_id: "run-1",
      roster_task_id: "review-1",
      roster_execution_id: "execution-1",
    }), /task review-1 is assigned to reviewer-node, not kai/u);

    const invokeInitial = (recipientNodeIds: string[]) => directory.invoke({
      node: {
        id: "planner-node",
        name: "Planner",
        capabilities: ["propose"],
        runtime: { kind: "roster-native" },
      },
      functionId: ROOM_UPDATE_FUNCTION_ID,
      value: {
        updateKey: "started",
        text: "I’m mapping the accepted request now.",
        intent: "progress",
        recipientNodeIds,
      },
      access,
      metadata: {
        roster_run_id: "run-1",
        roster_task_id: "plan-1",
        roster_execution_id: "execution-plan-1",
      },
    });
    await invokeInitial([]);
    await invokeInitial(["human"]);

    await assert.rejects(() => invoke({
      updateKey: "ack",
      text: "The downstream reviewer cannot receive an acknowledgement.",
      intent: "acknowledgement",
      recipientNodeIds: ["reviewer-node"],
    }), /acknowledgement recipient/u);
    await assert.rejects(() => invoke({
      updateKey: "ack",
      text: "An acknowledgement must address an upstream participant or the human.",
      intent: "acknowledgement",
      recipientNodeIds: [],
    }), /acknowledgement recipients must not be empty/u);
    await assert.rejects(() => invoke({
      updateKey: "ack",
      text: "This acknowledgement omits the human.",
      intent: "acknowledgement",
      recipientNodeIds: ["planner-node"],
    }), /must address every upstream participant and the human/u);
    await assert.rejects(() => invoke({
      updateKey: "ack",
      text: "This acknowledgement omits the upstream participant.",
      intent: "acknowledgement",
      recipientNodeIds: ["human"],
    }), /must address every upstream participant and the human/u);
    await invoke({
      updateKey: "ack",
      text: "Got it. I’m starting from the accepted plan.",
      intent: "acknowledgement",
      recipientNodeIds: ["planner-node", "human"],
    });
    await invoke({
      updateKey: "question",
      text: "Should the visible status retain the previous timestamp?",
      intent: "question",
      recipientNodeIds: ["planner-node", "reviewer-node", "human"],
    });
    await invoke({
      updateKey: "started",
      text: "The implementation is ready for downstream review.",
      intent: "progress",
      recipientNodeIds: ["planner-node", "reviewer-node", "human"],
    });
    assert.ok(policyTaskIds.length >= 6);
    assert.deepEqual([...new Set(policyTaskIds)], ["build-1", "review-1", "plan-1"]);
  } finally {
    dispose();
  }
});

test("Coding room updates abort while an asynchronous recipient policy is pending", async () => {
  const roomUpdates = new NodeRoomUpdateStore();
  const directory = new RosterFunctionDirectory(createCodingWorkerFunctionDescriptors());
  let policyStarted!: () => void;
  const started = new Promise<void>((resolve) => { policyStarted = resolve; });
  let releasePolicy!: () => void;
  const pendingPolicy = new Promise<{
    readonly upstreamNodeIds: ReadonlyArray<string>;
    readonly downstreamNodeIds: ReadonlyArray<string>;
    readonly humanNodeId: string;
  }>((resolve) => {
    releasePolicy = () => resolve({
      upstreamNodeIds: [],
      downstreamNodeIds: ["reviewer-node"],
      humanNodeId: "human",
    });
  });
  const dispose = await bindCodingWorkerFunctionProviders({
    directory,
    workingDirectory: process.cwd(),
    roomUpdateProvider: {
      roomUpdates,
      recipientPolicyForTask: async () => {
        policyStarted();
        return pendingPolicy;
      },
    },
  });
  const controller = new AbortController();
  try {
    const invocation = directory.invoke({
      node: {
        id: "kai",
        name: "Kai",
        capabilities: ["implement"],
        runtime: { kind: "roster-native" },
      },
      functionId: ROOM_UPDATE_FUNCTION_ID,
      value: {
        updateKey: "working",
        text: "This update must not survive a lost task fence.",
        intent: "progress",
        recipientNodeIds: ["reviewer-node"],
      },
      access: {
        functionGrants: [ROOM_UPDATE_FUNCTION_ID],
        scopes: [ROOM_UPDATE_SCOPE],
        allowedEffects: ["write"],
      },
      metadata: {
        roster_run_id: "run-aborted-policy",
        roster_task_id: "build-1",
        roster_execution_id: "execution-aborted-policy",
      },
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error("recipient policy task fence was replaced"));
    releasePolicy();
    await assert.rejects(invocation, /task fence was replaced/u);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(roomUpdates.list("run-aborted-policy"), []);
  } finally {
    await dispose();
  }
});

test("Coding grants room updates narrowly by model-backed task authority", () => {
  const worker = {
    id: "workspace.implementation",
    name: "Kai",
    capabilities: ["implement", "respond"],
    runtime: { kind: "roster-native" as const },
    metadata: {
      role: "worker",
      specialty: "implementation",
      repositoryReason: "Own the repository implementation.",
    },
  };
  const selection = {
    workspaceNodes: [worker],
    selectedNodeIds: [worker.id],
    primaryNodeId: worker.id,
    coordination: { reviewMode: "fast" as const, validationScope: "focused" as const },
  };
  const investigation = defineCodingAgentPlatform({
    ...selection,
    executionKind: "investigation",
  }, {
    objective: "Inspect the current room update path",
    runId: "room-update-investigation",
  });
  const mutation = defineCodingAgentPlatform(selection, {
    objective: "Implement the current room update path",
    runId: "room-update-mutation",
  });
  const investigationNode = investigation.definition.nodes.find((node) =>
    node.id !== investigation.definition.coordinatorId);
  const mutationNode = mutation.definition.nodes.find((node) =>
    node.id !== mutation.definition.coordinatorId);
  assert.ok(investigationNode);
  assert.ok(mutationNode);
  const task = (nodeId: string, capability: string) => ({
    taskId: `${capability}-task`,
    nodeId,
    capability,
  }) as Parameters<typeof investigation.access>[1];

  const investigationAccess = investigation.access(
    investigationNode,
    task(investigationNode.id, "investigate"),
  );
  assert.ok(investigationAccess.functionGrants?.includes(ROOM_UPDATE_FUNCTION_ID));
  assert.ok(investigationAccess.scopes?.includes(ROOM_UPDATE_SCOPE));
  assert.deepEqual(investigationAccess.allowedEffects, ["read", "write"]);
  assert.equal(investigationAccess.functionGrants?.includes(ROSTER_MEMORY_PROPOSE_FUNCTION_ID), false);
  assert.equal(
    investigationAccess.functionGrants?.includes(CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID),
    false,
  );
  assert.equal(investigationAccess.functionGrants?.includes(ROSTER_WORKSPACE_PUBLISH_FUNCTION_ID), false);
  const investigationWriteGrants = (investigation.definition.functions ?? [])
    .filter((descriptor) => descriptor.effects.includes("write"))
    .filter((descriptor) => investigationAccess.functionGrants?.includes(descriptor.id))
    .map((descriptor) => descriptor.id);
  assert.deepEqual(investigationWriteGrants, [ROOM_UPDATE_FUNCTION_ID]);

  const implementationAccess = mutation.access(
    mutationNode,
    task(mutationNode.id, "implement"),
  );
  assert.ok(implementationAccess.functionGrants?.includes(ROOM_UPDATE_FUNCTION_ID));
  assert.ok(implementationAccess.scopes?.includes(ROOM_UPDATE_SCOPE));

  const validationAccess = mutation.access(
    mutationNode,
    task(mutationNode.id, "validate"),
  );
  assert.deepEqual(validationAccess.functionGrants, []);
  assert.equal(validationAccess.scopes?.includes(ROOM_UPDATE_SCOPE) ?? false, false);

  const coordinator = mutation.registry.node(mutation.definition.coordinatorId);
  const coordinatorAccess = mutation.access(
    coordinator,
    task(coordinator.id, "coordinate"),
  );
  assert.equal(coordinatorAccess.functionGrants?.includes(ROOM_UPDATE_FUNCTION_ID), false);
  assert.equal(coordinatorAccess.scopes?.includes(ROOM_UPDATE_SCOPE) ?? false, false);

  const investigationCoordinator = investigation.registry.node(
    investigation.definition.coordinatorId,
  );
  const investigationCoordinatorAccess = investigation.access(
    investigationCoordinator,
    task(investigationCoordinator.id, "coordinate"),
  );
  assert.deepEqual(investigationCoordinatorAccess.allowedEffects, ["read"]);
  assert.equal(
    investigationCoordinatorAccess.functionGrants?.includes(ROOM_UPDATE_FUNCTION_ID),
    false,
  );
  assert.equal(
    investigationCoordinatorAccess.scopes?.includes(ROOM_UPDATE_SCOPE) ?? false,
    false,
  );
});
