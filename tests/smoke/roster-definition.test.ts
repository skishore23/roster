import assert from "node:assert/strict";
import test from "node:test";

import {
  attachA2A,
  attachClaude,
  attachCodex,
  attachCommand,
  attachCustomRuntime,
  attachHermes,
  attachNative,
  attachPi,
  defineRosterMember,
} from "../../src/engine/runtime/agent-attachment.ts";
import {
  attachRuntimePlacement,
  createRuntimePlacementBinding,
  defineRuntimePlacementPolicy,
  resolveRuntimePlacement,
} from "../../src/engine/runtime/runtime-placement.ts";

test("Roster members can attach to native, coding, command, A2A, and custom agents", () => {
  const attachments = [
    attachNative({ profile: "facilitator" }),
    attachCodex({ model: "gpt-5.6-sol", sandbox: "workspace-write" }),
    attachClaude({ model: "claude-opus", permissionMode: "plan" }),
    attachPi({ provider: "openai", model: "gpt-5.6", tools: ["read", "edit"] }),
    attachHermes({ provider: "openrouter", model: "nousresearch/hermes-4", yolo: true }),
    attachCommand({ command: ["custom-agent", "--stdio"] }),
    attachA2A({ endpoint: "https://agents.example.test/execute" }),
    attachCustomRuntime({ kind: "acme-agent", endpoint: "acme://agent/reviewer" }),
  ] as const;

  assert.deepEqual(
    attachments.map((attachment, index) => defineRosterMember({
      id: `member-${String(index)}`,
      name: `Member ${String(index)}`,
      role: index === 0 ? "facilitator" : "specialist",
      capabilities: ["collaborate"],
      attachment,
    }).runtime?.kind),
    [
      "roster-native",
      "codex-cli",
      "claude-code",
      "pi-agent",
      "hermes-agent",
      "shell",
      "a2a",
      "acme-agent",
    ],
  );

  const hermes = defineRosterMember({
    id: "hermes-reviewer",
    role: "reviewer",
    capabilities: ["review"],
    attachment: attachHermes({
      workingDirectory: "/workspace",
      provider: "openrouter",
      model: "nousresearch/hermes-4",
    }),
  });
  assert.equal(hermes.name, "Reviewer Agent");
  assert.deepEqual(hermes.runtime, {
    kind: "hermes-agent",
    metadata: {
      workingDirectory: "/workspace",
      provider: "openrouter",
      model: "nousresearch/hermes-4",
    },
  });
  assert.equal(hermes.metadata?.role, "reviewer");
});

test("Roster resolves reusable runtime placement without changing member identity", () => {
  const member = defineRosterMember({
    id: "builder",
    name: "Mira",
    role: "builder",
    capabilities: ["implement"],
    attachment: attachNative(),
  });
  const policy = defineRuntimePlacementPolicy({
    version: "workspace-placement-v1",
    profiles: [
      {
        id: "codex-write",
        label: "Codex workspace",
        access: ["workspace-write"],
        runtime: { kind: "codex-cli", metadata: { sandbox: "workspace-write" } },
      },
      {
        id: "hermes-review",
        label: "Hermes review",
        access: ["read-only"],
        runtime: { kind: "hermes-agent", metadata: { workingDirectory: "/workspace" } },
      },
    ],
    select: (context) => ({
      profileId: context.access === "workspace-write" ? "codex-write" : "hermes-review",
      reason: context.access === "workspace-write" ? "Mutation turn" : "Independent review",
    }),
  });
  const placement = resolveRuntimePlacement(policy, {
    rosterId: "placement-roster",
    rosterVersion: "1",
    runId: "run-1",
    node: member,
    capability: "implement",
    access: "workspace-write",
    workingDirectory: "/workspace",
  });
  assert.equal(placement.profileId, "codex-write");
  assert.equal(placement.policyVersion, "workspace-placement-v1");
  assert.equal(placement.rosterId, "placement-roster");
  assert.equal(placement.rosterVersion, "1");
  const placed = attachRuntimePlacement(member, placement);
  assert.equal(placed.id, member.id);
  assert.equal(placed.name, member.name);
  assert.deepEqual(placed.capabilities, member.capabilities);
  assert.equal(placed.runtime?.kind, "codex-cli");
  const binding = createRuntimePlacementBinding({
    node: member,
    placement,
    epoch: 1,
    topologyVersion: "topology-v1",
    sandboxId: "sandbox-1",
  });
  assert.deepEqual(binding.placement, {
    rosterId: "placement-roster",
    rosterVersion: "1",
    policyVersion: "workspace-placement-v1",
    profileId: "codex-write",
    reason: "Mutation turn",
  });
});

test("runtime placement rejects duplicate profiles", () => {
  assert.throws(() => defineRuntimePlacementPolicy({
    version: "duplicate-v1",
    profiles: [
      { id: "same", label: "One", access: ["read-only"], runtime: { kind: "hermes-agent" } },
      { id: "same", label: "Two", access: ["workspace-write"], runtime: { kind: "codex-cli" } },
    ],
    select: () => ({ profileId: "same", reason: "test" }),
  }), /Duplicate runtime profile same/);
});

import { defineTheoremRoster } from "../../src/domains/theorem.ts";
import { defineWriterRoster } from "../../src/domains/writer.ts";
import { defineCanvasRoster } from "../../src/domains/canvas.ts";
import {
  CodingReviewedSelectionUnavailableError,
  createCodingRoomControlIntent,
  defineCodingAgentPlatform,
  deriveCodingNodeDemands,
  deriveCodingValidationPlan,
  evaluateCodingConsensus,
  evaluateCodingInvestigationCompletion,
  evaluateFastCodingCompletion,
  previewCodingAgentGraph,
  resolveCodingReviewedSelection,
  verifyCodingFrontierEvidence,
  codingReviewMode,
  DEFAULT_CODING_AGENT_MODELS,
  runCodingAgent,
} from "../../src/domains/coding.ts";
import { hashCanonical } from "../../src/core/canonical.ts";
import {
  NODE_EXECUTION_SCHEMA_VERSION,
  NodeRuntimeRegistry,
} from "../../src/engine/runtime/node-runtime.ts";
import { NodeRoomUpdateStore } from "../../src/engine/runtime/node-room-updates.ts";
import {
  InMemoryTaskGraphControl,
  type TaskGraphControl,
} from "../../src/engine/orchestration/task-graph-control.ts";
import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import {
  createRosterTaskContext,
  SharedWorkspaceLedger,
} from "../../src/engine/workspace/shared-workspace.ts";
import {
  ROSTER_CONSULT_FUNCTION_ID,
  type RosterPlatformExecutionOptions,
} from "../../src/engine/platform/roster-platform.ts";
import { reviewCodingWorkspaceSnapshot } from "../../src/domains/coding-workspace.ts";
import { CODING_CHANGE_FRONTIER_FUNCTION_ID } from "../../src/domains/coding-change-frontier.ts";

const assertAuthoredFinalReportContract = (
  contract: unknown,
  outputKey = "final_report",
): void => {
  const result = contract as {
    readonly mode?: unknown;
    readonly outputKey?: unknown;
    readonly schema?: {
      readonly required?: ReadonlyArray<string>;
      readonly additionalProperties?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
    };
  };
  assert.equal(result.mode, "json");
  assert.equal(result.outputKey, outputKey);
  assert.deepEqual(result.schema?.required, [outputKey]);
  assert.equal(result.schema?.additionalProperties, false);
  assert.deepEqual(Object.keys(result.schema?.properties ?? {}), [outputKey]);
  const report = result.schema?.properties?.[outputKey] as {
    readonly type?: unknown;
    readonly required?: ReadonlyArray<string>;
    readonly additionalProperties?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  assert.equal(report.type, "object");
  assert.deepEqual(report.required, ["summary"]);
  assert.equal(report.additionalProperties, true);
  assert.deepEqual(report.properties?.summary, {
    type: "string",
    minLength: 1,
    maxLength: 1_600,
  });
  assert.deepEqual(Object.keys(report.properties ?? {}), ["summary"]);
};

const codingProfile = reviewCodingWorkspaceSnapshot({
  repositoryRoot: "/repo",
  files: [
    "package.json",
    "src/server.ts",
    "src/views/app.tsx",
    "spacetimedb/src/lib.ts",
    "docs/README.md",
  ],
  manifests: [{
    path: "package.json",
    content: JSON.stringify({ dependencies: { react: "1.0.0" } }),
  }],
  reviewedAt: 10,
});

test("reviewed coding selection fails closed when a saved reviewer was not selected", () => {
  const nodes = [
    {
      id: "human.operator",
      name: "Human",
      capabilities: ["respond"],
      runtime: { kind: "roster-native" },
      metadata: { participantKind: "human" },
    },
    {
      id: "workspace.primary",
      name: "Primary",
      capabilities: ["implement", "review"],
      runtime: { kind: "roster-native" },
      metadata: { role: "worker" },
    },
    {
      id: "workspace.reviewer-z",
      name: "Reviewer Z",
      capabilities: ["review"],
      runtime: { kind: "roster-native" },
      metadata: { role: "supervisor" },
    },
    {
      id: "workspace.reviewer-a",
      name: "Reviewer A",
      capabilities: ["respond"],
      runtime: { kind: "roster-native" },
      metadata: { role: "supervisor" },
    },
    {
      id: "workspace.worker",
      name: "Worker",
      capabilities: ["implement"],
      runtime: { kind: "roster-native" },
      metadata: { role: "worker" },
    },
  ] as const;
  const input = {
    nodes,
    selectedNodeIds: ["workspace.primary"],
    primaryNodeId: "workspace.primary",
    reviewMode: "reviewed" as const,
  };

  assert.throws(
    () => resolveCodingReviewedSelection(input),
    CodingReviewedSelectionUnavailableError,
  );
  assert.throws(
    () => resolveCodingReviewedSelection({ ...input, nodes: [...nodes].reverse() }),
    CodingReviewedSelectionUnavailableError,
  );
});

test("reviewed coding selection preserves fast and explicit saved selections", () => {
  const nodes = [
    {
      id: "workspace.primary",
      name: "Primary",
      capabilities: ["implement", "review"],
      runtime: { kind: "roster-native" },
      metadata: { role: "worker" },
    },
    {
      id: "workspace.reviewer-b",
      name: "Reviewer B",
      capabilities: ["review"],
      runtime: { kind: "roster-native" },
      metadata: { role: "supervisor" },
    },
    {
      id: "workspace.reviewer-a",
      name: "Reviewer A",
      capabilities: ["respond"],
      runtime: { kind: "roster-native" },
      metadata: { role: "supervisor" },
    },
  ] as const;

  assert.deepEqual(resolveCodingReviewedSelection({
    nodes,
    selectedNodeIds: ["workspace.primary", "workspace.primary"],
    primaryNodeId: "workspace.primary",
    reviewMode: "fast",
  }), { selectedNodeIds: ["workspace.primary"] });
  assert.deepEqual(resolveCodingReviewedSelection({
    nodes,
    selectedNodeIds: ["workspace.primary", "workspace.reviewer-b", "workspace.reviewer-a"],
    primaryNodeId: "workspace.primary",
    reviewMode: "reviewed",
  }), {
    selectedNodeIds: ["workspace.primary", "workspace.reviewer-b", "workspace.reviewer-a"],
    reviewerNodeId: "workspace.reviewer-b",
  });
});

test("reviewed coding selection fails closed without a saved independent reviewer", () => {
  const primary = {
    id: "workspace.primary",
    name: "Primary",
    capabilities: ["implement", "review"],
    runtime: { kind: "roster-native" },
    metadata: { role: "worker" },
  } as const;

  assert.throws(() => resolveCodingReviewedSelection({
    nodes: [primary],
    selectedNodeIds: [primary.id],
    primaryNodeId: primary.id,
    reviewMode: "reviewed",
  }), CodingReviewedSelectionUnavailableError);
});

const codingSelection = (
  nodes: typeof codingProfile.nodes,
  reviewMode: "fast" | "reviewed",
  validationScope: "focused" | "repository-wide",
  selectedNodeIds?: ReadonlyArray<string>,
) => {
  const primary = nodes.find((node) => node.capabilities.includes("implement"));
  assert.ok(primary);
  const selected = selectedNodeIds ?? [
    primary.id,
    ...(reviewMode === "reviewed"
      ? nodes.filter((node) => node.capabilities.includes("review")).slice(0, 1).map((node) => node.id)
      : []),
  ];
  return {
    workspaceNodes: nodes,
    selectedNodeIds: selected,
    primaryNodeId: primary.id,
    coordination: { reviewMode, validationScope } as const,
  };
};

type CodingPreviewOptions = Omit<
  Parameters<typeof previewCodingAgentGraph>[0],
  "objective" | "runId"
>;

const codingPreviewHarness = (options: CodingPreviewOptions) => ({
  plan: async (input: { readonly objective: string; readonly runId: string }) =>
    previewCodingAgentGraph({ ...options, ...input }),
});

const codingExecutionPlanes = (runId: string) => {
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
        const snapshot = await taskGraph.snapshot();
        const record = snapshot.tasks.find((candidate) =>
          candidate.definition.taskId === definition.taskId);
        if (
          !record
          || (record.status !== "leased" && record.status !== "running")
          || record.leaseFence !== lease.fence
        ) throw new Error(`Task ${definition.taskId} no longer owns its workspace fence`);
      },
    },
  });
  return { taskGraph, dataReferences, createTaskContext, ledger, roomUpdates };
};

type CodingTestEnvelope = Parameters<NonNullable<
  import("../../src/engine/runtime/node-runtime.ts").NodeRuntimeAdapter["executeEnvelope"]
>>[0];

const completeCodingAnnouncement = (envelope: CodingTestEnvelope) => {
  if (envelope.task.capability !== "room") return undefined;
  const outputKey = envelope.resultContract.mode === "json"
    ? (envelope.resultContract.schema as { readonly required?: ReadonlyArray<string> }).required?.[0]
    : undefined;
  assert.ok(outputKey);
  return {
    schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
    status: "completed" as const,
    output: {
      [outputKey]: { summary: "I’m starting my bounded contribution now." },
    },
  };
};

test("Theorem exposes a node-only domain registry without plan compiler surfaces", () => {
  const domain = defineTheoremRoster(4, 16);
  assert.equal(domain.registry.pack.id, domain.pack.id);
  assert.equal(domain.registry.node(domain.pack.coordinatorId).id, "orchestrator");
  assert.equal("compilePlan" in domain, false);
  assert.equal("platform" in domain, false);
});

test("Writer and Canvas expose node-only domain registries without planner surfaces", () => {
  const domains = [
    defineWriterRoster(4, 16),
    defineCanvasRoster(4, [], 16),
  ];
  for (const domain of domains) {
    assert.equal(domain.registry.pack.id, domain.pack.id);
    assert.equal(domain.registry.node(domain.pack.coordinatorId).id, domain.pack.coordinatorId);
    assert.equal("compilePlan" in domain, false);
    assert.equal("plan" in domain, false);
  }
});

test("Coding uses a longer configurable run window without removing its hard wall-time bound", () => {
  const selection = codingSelection(codingProfile.nodes, "fast", "focused");
  const input = { objective: "Exercise a long bounded coding run", runId: "coding-long-window" };
  const defaultPlatform = defineCodingAgentPlatform(selection, input);
  const extendedPlatform = defineCodingAgentPlatform({
    ...selection,
    maxWallTimeMs: 12 * 60 * 60_000,
  }, input);
  const cappedPlatform = defineCodingAgentPlatform({
    ...selection,
    maxWallTimeMs: 48 * 60 * 60_000,
  }, input);

  assert.equal(defaultPlatform.definition.policy.maxWallTimeMs, 8 * 60 * 60_000);
  assert.equal(extendedPlatform.definition.policy.maxWallTimeMs, 12 * 60 * 60_000);
  assert.equal(cappedPlatform.definition.policy.maxWallTimeMs, 24 * 60 * 60_000);
  assert.equal(extendedPlatform.definition.policy.maxTasks, 48);
  assert.equal(extendedPlatform.definition.policy.maxAttempts, 2);
  assert.equal(extendedPlatform.definition.policy.maxTokens, 2_000_000);
});

test("coding agent dynamically expands and certifies a bounded runtime population", async () => {
  const repositoryWideSelection = codingSelection(
    codingProfile.nodes,
    "reviewed",
    "repository-wide",
    ["workspace.implementation", "workspace.quality"],
  );
  const codingOptions = {
    workingDirectory: "/tmp/repository",
    reviewPolicy: "reviewed",
    ...repositoryWideSelection,
  } as const;
  const roster = codingPreviewHarness(codingOptions);
  const compiled = await roster.plan({ objective: "Add a health check", runId: "coding-preview" });
  const platform = defineCodingAgentPlatform(
    codingOptions,
    { objective: "Add a health check", runId: "coding-preview" },
  );
  assert.equal(platform.definition.nodes[0]?.id, "coordinator");
  assert.equal(platform.definition.nodes.length, compiled.nodes.length);
  const proposalTaskIds = compiled.tasks.filter((task) => task.capability === "propose").map((task) => task.id);
  const reviewTask = compiled.tasks.find((task) => task.capability === "review");
  const certifyTask = compiled.tasks.find((task) => task.capability === "certify");
  const resolutionTask = compiled.tasks.find((task) => task.capability === "resolve");
  assert.equal(proposalTaskIds.length, 2);
  assert.ok(reviewTask);
  assert.ok(certifyTask);
  assert.ok(compiled.tasks.every((task) => task.context.capability === task.capability));
  assert.equal(compiled.tasks.find((task) => task.capability === "propose")?.context.changeFrontier, "none");
  assert.equal(compiled.tasks.find((task) => task.capability === "implement")?.context.changeFrontier, "optional");
  assert.equal(reviewTask.context.changeFrontier, "required");
  assert.ok(reviewTask.context.available.includes("objective"));
  assert.ok(reviewTask.context.available.includes("implementation-report"));
  assert.equal(certifyTask.context.changeFrontier, "required");
  assert.match(resolutionTask?.objective ?? "", /copy each id exactly/);
  const responses = compiled.tasks.filter((task) => task.capability === "respond");
  assert.equal(responses.length, 1);
  assert.ok(proposalTaskIds.every((taskId) => responses[0]!.needs.some((outputKey) =>
    compiled.tasks.find((task) => task.id === taskId)?.provides.includes(outputKey))));
  assert.ok(proposalTaskIds.every((taskId) => compiled.topologicalOrder.indexOf(taskId) < compiled.topologicalOrder.indexOf("resolve-collaboration")));
  assert.ok(compiled.topologicalOrder.indexOf("resolve-collaboration") < compiled.topologicalOrder.indexOf("implement"));
  assert.equal(compiled.maxParallel, 4);
  const plannedWorker = compiled.nodes.find((node) => node.metadata?.role === "worker");
  const plannedSupervisors = compiled.nodes.filter((node) => node.metadata?.role === "supervisor");
  assert.equal(plannedWorker?.runtime?.kind, "pi-agent");
  assert.equal(plannedWorker?.runtime?.metadata?.model, DEFAULT_CODING_AGENT_MODELS.piWorker);
  assert.ok(Array.isArray(plannedWorker?.runtime?.metadata?.extensions));
  assert.ok((plannedWorker?.runtime?.metadata?.extensions as ReadonlyArray<string>).some((extensionPath) =>
    extensionPath.endsWith("/node_modules/@cortexkit/aft-pi/dist/index.js")));
  assert.equal(plannedSupervisors.length, 1);
  assert.ok(plannedSupervisors.every((node) => node.runtime?.kind === "codex-cli"));
  assert.ok(plannedSupervisors.every((node) => node.runtime?.metadata?.model === DEFAULT_CODING_AGENT_MODELS.reviewer));
  assert.ok(plannedSupervisors.every((node) => node.runtime?.metadata?.reasoningEffort === "high"));
  assert.ok(plannedSupervisors.every((node) => node.runtime?.metadata?.sandbox === "read-only"));
  assert.ok(compiled.nodes.filter((node) => node.id !== "coordinator").every((node) => node.parentId === undefined));
  const resolutionReviewer = compiled.nodes.find((node) => node.metadata?.collaborationRole === "temporary-resolver");
  assert.equal(resolutionReviewer?.name, "Resolution Reviewer");
  assert.equal(resolutionReviewer?.metadata?.displayRole, "Run-scoped conflict review");
  assert.equal(resolutionReviewer?.metadata?.authority, "conflict-scoped");
  assert.notEqual(resolutionReviewer?.id, "coding.resolution-peer");
  const allSelected = codingSelection(
    codingProfile.nodes,
    "reviewed",
    "repository-wide",
    codingProfile.nodes.map((node) => node.id),
  );
  assert.equal(deriveCodingNodeDemands({
    ...allSelected,
    maxSupervisors: 2,
  }).length, 3, "one worker plus two explicitly selected supervisors must respect the configured population bound");
  const bounded = await codingPreviewHarness({
    maxNodes: 4,
    maxSupervisors: 2,
    ...allSelected,
  }).plan({
    objective: "Change OAuth API permissions, database schema, documentation, and performance",
    runId: "bounded-coding-preview",
  });
  assert.equal(bounded.nodes.length, 4, "coordinator plus three run-specific nodes must fit maxNodes=4");
  assert.equal(bounded.tasks.filter((task) => task.capability !== "room").length, 10,
    "the bounded reviewed graph includes a peer reply, shared validation, and one final synthesis task");
  assert.equal(bounded.tasks.filter((task) => task.capability === "room").length, 6);

  const calls: string[] = [];
  const timeouts: number[] = [];
  const runtimes = new NodeRuntimeRegistry([
    {
      kind: "pi-agent",
      executeEnvelope: async (envelope) => {
        calls.push(envelope.task.taskId);
        if (envelope.task.capability === "room") {
          if (envelope.grant.functionAccess.functionGrants.length > 0
            || envelope.grant.functionAccess.allowedEffects.length > 0
            || envelope.surface.tools.length > 0
            || envelope.surface.codeMode !== undefined) {
            throw new Error(`room grant mismatch for ${envelope.task.taskId}: grants=${envelope.grant.functionAccess.functionGrants.join(",")} effects=${envelope.grant.functionAccess.allowedEffects.join(",")} tools=${envelope.surface.tools.map((tool) => tool.id).join(",")}`);
          }
        }
        timeouts.push(envelope.timeoutMs ?? 0);
        const announcement = completeCodingAnnouncement(envelope);
        if (announcement) return announcement;
        if (envelope.task.capability === "remediate") {
          assertAuthoredFinalReportContract(envelope.resultContract);
        }
        assert.ok(envelope.grant.functionAccess.functionGrants.includes(ROSTER_CONSULT_FUNCTION_ID));
        const peerInput = envelope.input as {
          readonly eligiblePeers?: ReadonlyArray<{
            readonly nodeId: string;
            readonly capabilities: ReadonlyArray<string>;
          }>;
        };
        assert.ok(peerInput.eligiblePeers?.every((peer) =>
          peer.nodeId !== envelope.node.id && peer.capabilities.includes("respond")));
        const required = envelope.resultContract.mode === "json"
          ? (envelope.resultContract.schema as { readonly required?: ReadonlyArray<string> }).required ?? []
          : [];
        const outputKey = required[0];
        assert.ok(outputKey);
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: envelope.task.capability === "propose"
            ? { [outputKey]: {
                status: "proposal",
                summary: "Keep the health check bounded.",
                recommendations: [{
                  subjectId: "implementation-approach",
                  recommendation: "Add one bounded route",
                  rationale: "The existing server owns routes.",
                  evidence: ["src/server.ts"],
                  confidence: 0.9,
                }],
                questions: [],
              } }
            : envelope.task.capability === "respond"
              ? { [outputKey]: {
                  status: "response",
                  summary: "I agree; I will keep the implementation bounded.",
                  answers: [],
                  openQuestions: [],
                } }
            : envelope.task.capability === "synthesize"
              ? { [outputKey]: {
                  status: "completed",
                  summary: "I added the bounded health check and its targeted validation passed.",
                  frontierHash: "frontier-1",
                } }
            : envelope.task.taskId === "implement"
              ? { implementation_report: { changed: ["health.ts"], tests: ["health.test.ts"] } }
              : { final_report: {
                  status: "verified",
                  summary: "I reconciled the review and retained the bounded implementation.",
                  validation: ["targeted health check"],
                  frontierHash: "frontier-1",
                } },
        };
      },
    },
    {
      kind: "codex-cli",
      executeEnvelope: async (envelope) => {
        calls.push(envelope.task.taskId);
        timeouts.push(envelope.timeoutMs ?? 0);
        const announcement = completeCodingAnnouncement(envelope);
        if (announcement) return announcement;
        assert.ok(envelope.grant.functionAccess.functionGrants.includes(ROSTER_CONSULT_FUNCTION_ID));
        const peerInput = envelope.input as {
          readonly eligiblePeers?: ReadonlyArray<{
            readonly nodeId: string;
            readonly capabilities: ReadonlyArray<string>;
          }>;
        };
        assert.ok(peerInput.eligiblePeers?.every((peer) =>
          peer.nodeId !== envelope.node.id && peer.capabilities.includes("respond")));
        const required = envelope.resultContract.mode === "json"
          ? (envelope.resultContract.schema as { readonly required?: ReadonlyArray<string> }).required ?? []
          : [];
        const outputKey = required[0];
        assert.ok(outputKey);
        const certifying = envelope.task.capability === "certify";
        const dependencyInput = envelope.input as {
          readonly dependencies?: Readonly<Record<string, {
            readonly dataReferences?: ReadonlyArray<unknown>;
          }>>;
        };
        if (certifying) {
          assert.ok(Object.values(dependencyInput.dependencies ?? {})
            .some((dependency) => (dependency.dataReferences?.length ?? 0) > 0));
        }
        if (envelope.task.capability === "review") {
          assert.ok(Object.values(dependencyInput.dependencies ?? {})
            .some((dependency) => (dependency.dataReferences?.length ?? 0) > 0));
        }
        const value = envelope.task.capability === "propose"
          ? {
              status: "proposal",
              summary: "Keep the health check bounded.",
              recommendations: [{
                subjectId: "implementation-approach",
                recommendation: "Add one bounded route",
                rationale: "A narrow route minimizes regression risk.",
                evidence: ["tests/health.test.ts"],
                confidence: 0.9,
              }],
              questions: [],
            }
          : envelope.task.capability === "respond"
            ? {
                status: "response",
                summary: "Repository evidence answers the peer question.",
                answers: [{
                  subjectId: "implementation-approach",
                  response: "A bounded route matches the existing server.",
                  rationale: "Both peers cited the route boundary.",
                  evidence: ["src/server.ts"],
                  confidence: 0.9,
                }],
                openQuestions: [],
              }
          : envelope.task.capability === "resolve"
            ? {
                status: "aligned",
                summary: "The peers agree on a bounded route.",
                decisions: [{
                  subjectId: "implementation-approach",
                  resolution: "Add one bounded route",
                  rationale: "Both specialties selected it.",
                  evidence: ["src/server.ts"],
                }],
                unresolved: [],
              }
            : certifying
              ? { verdict: "approve", frontierHash: "frontier-1", summary: "approved", evidence: [] }
              : { findings: ["Add a failure-path assertion"] };
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: { [outputKey]: value },
        };
      },
    },
  ]);
  const executionPlanes = codingExecutionPlanes("coding-smoke");
  Object.defineProperty(executionPlanes.taskGraph, "durability", { value: "durable" });
  Object.defineProperty(executionPlanes.dataReferences, "durability", { value: "durable" });
  Object.assign(executionPlanes.createTaskContext, { durability: "durable" as const });
  const execution = await runCodingAgent({
    runId: "coding-smoke",
    objective: "Add a health check",
    workingDirectory: "/tmp/repository",
    ...codingSelection(
      codingProfile.nodes,
      "reviewed",
      "focused",
      ["workspace.implementation", "workspace.quality"],
    ),
    nodeRuntimes: runtimes,
    ...executionPlanes,
  });

  assert.deepEqual(calls.filter((taskId) => !taskId.startsWith("announce-")).map((taskId) => taskId
    .replace(/^propose-.+$/, "propose")
    .replace(/^respond-.+$/, "respond")
    .replace(/^review-.+$/, "review")
    .replace(/^certify-.+$/, "certify")
    .replace(/^synthesize-final.*$/, "synthesize")), [
    "propose",
    "respond",
    "implement",
    "review",
    "remediate",
    "certify",
    "synthesize",
  ]);
  assert.deepEqual(
    timeouts.filter((_, index) => !calls[index]!.startsWith("announce-")),
    [420_000, 420_000, 1_200_000, 1_200_000, 1_200_000, 300_000, 300_000],
  );
  assert.ok(timeouts.filter((_, index) => calls[index]!.startsWith("announce-")).every((timeout) => timeout === 60_000));
  assert.equal(
    execution.status,
    "completed",
    execution.snapshot.tasks.map((task) => `${task.definition.taskId}:${task.status}:${task.error ?? ""}`).join(" | "),
  );
  assert.match(execution.outputs.final_report ?? "", /verified/);
  assert.equal(
    execution.snapshot.tasks.find((task) =>
      task.definition.capability === "remediate")?.outcome?.artifacts[0]?.presentationText,
    "I reconciled the review and retained the bounded implementation.",
  );
  assert.equal(execution.snapshot.expansions.length, 3);
  assert.equal(execution.snapshot.tasks.find((task) =>
    task.definition.taskId === "coding-coordinate")?.status, "skipped");
  assert.equal(execution.snapshot.tasks.find((task) =>
    task.definition.taskId === "coding-review-gate")?.status, "skipped");
  assert.equal(execution.snapshot.tasks.find((task) =>
    task.definition.taskId === "coding-finalize")?.status, "skipped");
  assert.equal(execution.snapshot.tasks.find((task) =>
    task.definition.taskId === "coding-complete")?.status, "accepted");
  for (const record of execution.snapshot.tasks.filter((task) =>
    task.definition.capability !== "coordinate")) {
    const contextReference = record.definition.inputs.dataReferences.find((reference) =>
      reference.metadata?.outputKey === "coding_task_context");
    assert.ok(contextReference, `Missing durable context policy for ${record.definition.taskId}`);
    assert.equal(
      record.definition.inputs.inputVersions.codingTaskContext,
      contextReference.contentHash,
    );
    const context = await executionPlanes.dataReferences.read(contextReference) as {
      readonly capability: string;
      readonly available: ReadonlyArray<string>;
    };
    assert.equal(context.capability, record.definition.capability);
    assert.ok(context.available.length > 1);
  }
  const implementationRecord = execution.snapshot.tasks.find((task) =>
    task.definition.capability === "implement");
  const reviewRecord = execution.snapshot.tasks.find((task) =>
    task.definition.capability === "review");
  assert.ok(implementationRecord);
  assert.ok(reviewRecord);
  const implementationNode = platform.definition.nodes.find((node) =>
    node.id === implementationRecord.definition.nodeId);
  const reviewNode = platform.definition.nodes.find((node) =>
    node.id === reviewRecord.definition.nodeId);
  assert.ok(implementationNode);
  assert.ok(reviewNode);
  assert.ok(platform.definition.access?.(
    implementationNode,
    implementationRecord.definition,
  ).functionGrants?.includes(CODING_CHANGE_FRONTIER_FUNCTION_ID));
  assert.ok(platform.definition.access?.(
    reviewNode,
    reviewRecord.definition,
  ).functionGrants?.includes(CODING_CHANGE_FRONTIER_FUNCTION_ID));
  assert.equal(platform.definition.access?.(
    reviewNode,
    { ...reviewRecord.definition, capability: "propose" },
  ).functionGrants?.includes(CODING_CHANGE_FRONTIER_FUNCTION_ID), false);
});

test("coding agent resumes a partial durable task graph without repeating accepted model work", async () => {
  const calls: string[] = [];
  const runtimes = new NodeRuntimeRegistry([
    {
      kind: "pi-agent",
      executeEnvelope: async (envelope) => {
        calls.push(envelope.task.taskId);
        const announcement = completeCodingAnnouncement(envelope);
        if (announcement) return announcement;
        if (envelope.task.capability === "synthesize") {
          return {
            schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
            status: "completed",
            output: { coding_final_answer: {
              status: "completed",
              summary: "I recovered and certified the current health-check frontier.",
              frontierHash: "frontier-recovered",
            } },
          };
        }
        const outputKey = envelope.resultContract.mode === "json"
          ? (envelope.resultContract.schema as { readonly required?: ReadonlyArray<string> }).required?.[0]
          : undefined;
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: envelope.task.capability === "respond" && outputKey
            ? { [outputKey]: {
                status: "response",
                summary: "I agree; I will keep the implementation bounded.",
                answers: [],
                openQuestions: [],
              } }
            : envelope.task.taskId === "implement"
            ? { implementation_report: { changed: ["health.ts"], tests: ["health.test.ts"] } }
            : { final_report: {
                status: "verified",
                summary: "I recovered the review remediation without repeating accepted work.",
                validation: ["targeted health check"],
                frontierHash: "frontier-recovered",
              } },
        };
      },
    },
    {
      kind: "codex-cli",
      executeEnvelope: async (envelope) => {
        calls.push(envelope.task.taskId);
        const announcement = completeCodingAnnouncement(envelope);
        if (announcement) return announcement;
        const outputKey = envelope.resultContract.mode === "json"
          ? (envelope.resultContract.schema as { readonly required?: ReadonlyArray<string> }).required?.[0]
          : undefined;
        assert.ok(outputKey);
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: {
            [outputKey]: envelope.task.capability === "certify"
              ? { verdict: "approve", frontierHash: "frontier-recovered", summary: "approved", evidence: [] }
              : envelope.task.capability === "respond"
                ? { status: "response", summary: "I agree with the proposed direction.", answers: [], openQuestions: [] }
                : { findings: [] },
          },
        };
      },
    },
  ]);
  const selection = codingSelection(
    codingProfile.nodes,
    "reviewed",
    "focused",
    ["workspace.implementation", "workspace.quality"],
  );
  const planes = codingExecutionPlanes("coding-durable-resume");
  let crash = true;
  const crashingTaskGraph = new Proxy(planes.taskGraph, {
    get(target, property, receiver) {
      if (property === "accept") {
        return async (accepted: Parameters<TaskGraphControl["accept"]>[0]) => {
          const outcome = await target.accept(accepted);
          if (crash && accepted.lease.taskId === "implement") {
            crash = false;
            throw new Error("simulated coordinator crash");
          }
          return outcome;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TaskGraphControl;

  await assert.rejects(runCodingAgent({
    runId: "coding-durable-resume",
    objective: "Add a health check",
    workingDirectory: "/tmp/repository",
    ...selection,
    nodeRuntimes: runtimes,
    ...planes,
    taskGraph: crashingTaskGraph,
  }), /simulated coordinator crash/);
  assert.deepEqual(calls.filter((taskId) => !taskId.startsWith("announce-")).map((taskId) => taskId
    .replace(/^propose-.+$/, "propose")
    .replace(/^respond-.+$/, "respond")), [
    "propose",
    "respond",
    "implement",
  ]);
  assert.equal((await planes.taskGraph.snapshot()).tasks.find((record) =>
    record.definition.taskId === "implement")?.status, "accepted");

  const callsBeforeRecovery = calls.length;
  const recovered = await runCodingAgent({
    runId: "coding-durable-resume",
    objective: "Add a health check",
    workingDirectory: "/tmp/repository",
    ...selection,
    nodeRuntimes: runtimes,
    ...planes,
  });

  assert.equal(calls.filter((taskId) => taskId === "implement").length, 1);
  assert.deepEqual(calls.slice(callsBeforeRecovery)
    .filter((taskId) => !taskId.startsWith("announce-"))
    .map((taskId) => taskId
    .replace(/^review-.+$/, "review")
    .replace(/^certify-.+$/, "certify")), ["review", "remediate", "certify", "synthesize-final"]);
  assert.equal(recovered.status, "completed");
});

test("coding specialist dependencies become artifact prerequisites in the compiled task DAG", async () => {
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo",
    files: ["src/api/routes.ts", "src/data/schema.ts", "tests/api.test.ts"],
    manifests: [],
    reviewedAt: 10,
  });
  const nodes = profile.nodes.map((node) => node.id === "workspace.quality"
    ? { ...node, metadata: { ...(node.metadata ?? {}), dependsOnNodeIds: ["workspace.data"] } }
    : node.id === "workspace.data"
      ? { ...node, metadata: { ...(node.metadata ?? {}), dependsOnNodeIds: ["workspace.api"] } }
      : node);
  const roster = codingPreviewHarness({
    workspaceNodes: nodes,
    selectedNodeIds: ["workspace.implementation", "workspace.api", "workspace.data", "workspace.quality"],
    primaryNodeId: "workspace.implementation",
    coordination: { reviewMode: "reviewed", validationScope: "repository-wide" },
    reviewPolicy: "reviewed",
  });

  const compiled = await roster.plan({ objective: "Change the API contract and backing schema", runId: "coding-dag" });
  const qualityReview = compiled.tasks.find((task) => task.capability === "review" && task.nodeId === "workspace.quality");
  const dataReview = compiled.tasks.find((task) => task.capability === "review" && task.nodeId === "workspace.data");
  const dataResponse = compiled.tasks.find((task) => task.capability === "respond" && task.nodeId === "workspace.data");
  const apiResponse = compiled.tasks.find((task) => task.capability === "respond" && task.nodeId === "workspace.api");
  assert.ok(qualityReview);
  assert.ok(dataReview);
  assert.ok(dataResponse, "the saved quality → data dependency should create one bounded peer response task");
  assert.ok(apiResponse, "the saved data → API dependency should let the mutation peer answer before editing");
  assert.ok(dataResponse.needs.includes(apiResponse.provides[0]!));
  assert.ok(compiled.topologicalOrder.indexOf(apiResponse.id) < compiled.topologicalOrder.indexOf(dataResponse.id));
  assert.ok(compiled.topologicalOrder.indexOf(dataResponse.id) < compiled.topologicalOrder.indexOf("resolve-collaboration"));
  assert.ok(qualityReview.needs.includes("implementation_report"));
  assert.ok(qualityReview.needs.includes(dataReview.provides[0]!));
  assert.equal(qualityReview.needs.filter((need) => need.startsWith("room_announcement_")).length, 1);
  assert.ok(compiled.topologicalOrder.indexOf(dataReview.id) < compiled.topologicalOrder.indexOf(qualityReview.id));
  const certifications = compiled.tasks.filter((task) => task.capability === "certify");
  assert.deepEqual(certifications.map((task) => task.nodeId), ["workspace.quality"]);
  assert.ok(certifications[0]?.needs.includes("final_report"));
});

test("auto policy lets the focused specialist shape direction before implementation and review", async () => {
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo",
    files: ["package.json", "package-lock.json", "src/views/notifications.tsx"],
    manifests: [{
      path: "package.json",
      content: JSON.stringify({
        scripts: { lint: "next lint", build: "next build" },
        dependencies: { react: "1.0.0" },
      }),
    }],
    reviewedAt: 10,
  });
  const implementation = profile.nodes.find((node) => node.capabilities.includes("implement"));
  const ui = profile.nodes.find((node) => node.metadata?.specialty === "ui");
  assert.ok(implementation);
  assert.ok(ui);
  const roster = codingPreviewHarness({
    workspaceNodes: [implementation, ui],
    selectedNodeIds: [implementation.id, ui.id],
    primaryNodeId: implementation.id,
    coordination: { reviewMode: "reviewed", validationScope: "focused" },
    reviewPolicy: "auto",
    repositoryExecutionProfile: profile.executionProfile,
  });

  const compiled = await roster.plan({
    objective: "Fix notification banner visibility after notifications are enabled",
    runId: "coding-focused-ui",
  });

  assert.equal(compiled.version, "3.0.0-compact-reviewed");
  assert.deepEqual(compiled.tasks.filter((task) => task.capability !== "room").map((task) => task.capability), [
    "propose",
    "respond",
    "implement",
    "review",
    "remediate",
    "certify",
    "synthesize",
  ]);
  assert.deepEqual(compiled.nodes.filter((node) => node.id !== "coordinator").map((node) => node.id), [implementation.id, ui.id]);
  assert.equal(compiled.tasks.some((task) => task.capability === "propose"), true);
  assert.equal(compiled.tasks.some((task) => task.capability === "resolve"), false);
  assert.equal(compiled.tasks.some((task) => task.capability === "validate"), false);
  assert.match(compiled.tasks.find((task) => task.capability === "propose")?.objective ?? "", /before files are changed/);
  const proposal = compiled.tasks.find((task) => task.capability === "propose");
  const response = compiled.tasks.find((task) => task.capability === "respond");
  const implement = compiled.tasks.find((task) => task.capability === "implement");
  const review = compiled.tasks.find((task) => task.capability === "review");
  const remediate = compiled.tasks.find((task) => task.capability === "remediate");
  const certify = compiled.tasks.find((task) => task.capability === "certify");
  assert.ok(proposal && response && implement && review && remediate && certify);
  assert.ok(compiled.topologicalOrder.indexOf(proposal.id) < compiled.topologicalOrder.indexOf(response.id));
  assert.ok(compiled.topologicalOrder.indexOf(response.id) < compiled.topologicalOrder.indexOf(implement.id));
  assert.ok(response.needs.includes(proposal.provides[0]!));
  assert.equal(response.needs.filter((need) => need.startsWith("room_announcement_")).length, 1);
  assert.ok(implement.needs.includes(response.provides[0]!));
  assert.match(proposal.objective ?? "", /direct, natural first-person conversational reply/);
  assert.match(response.objective ?? "", /direct, natural first-person conversational reply/);
  assert.match(implement.objective ?? "", /files actually needed/);
  assert.match(implement.objective ?? "", /Keep the content-addressed toolchain evidence files unchanged.*package\.json/);
  assert.match(remediate.objective ?? "", /A dependency, script, lockfile, or toolchain change requires/);
  assert.match(review.objective ?? "", /actual Git task delta/);
  assert.match(implement.objective ?? "", /git add -A/);
  assert.match(remediate.objective ?? "", /git add -A/);
  assert.match(certify.objective ?? "", /final_report\.frontierHash/);
  assert.match(certify.objective ?? "", /Inspect the actual worktree delta with read-only commands/);
  assert.match(certify.objective ?? "", /Do not run `git add`/);
  assert.doesNotMatch(certify.objective ?? "", /Before returning, run `git add/);
});

test("coding collaboration keys derive from logical node identity, not specialty", async () => {
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo",
    files: ["src/server.ts", "tests/api-a.test.ts", "tests/api-b.test.ts"],
    manifests: [],
    reviewedAt: 10,
  });
  const quality = profile.nodes.find((node) => node.metadata?.specialty === "quality");
  const implementation = profile.nodes.find((node) => node.capabilities.includes("implement"));
  assert.ok(quality);
  assert.ok(implementation);
  const secondQuality = {
    ...quality,
    id: "workspace.quality.contracts",
    name: "Contract Test Peer",
  };
  const roster = codingPreviewHarness({
    workspaceNodes: [implementation, quality, secondQuality],
    selectedNodeIds: [implementation.id, quality.id, secondQuality.id],
    primaryNodeId: implementation.id,
    coordination: { reviewMode: "reviewed", validationScope: "repository-wide" },
    reviewPolicy: "reviewed",
  });
  const compiled = await roster.plan({ objective: "Add a public API with compatibility tests", runId: "coding-duplicate-specialty" });
  const proposalOutputs = compiled.tasks
    .filter((task) => task.capability === "propose")
    .flatMap((task) => task.provides);
  assert.equal(proposalOutputs.length, 3);
  assert.equal(new Set(proposalOutputs).size, 3);
  assert.equal(compiled.tasks.filter((task) => task.capability === "review").length, 2);
  assert.equal(compiled.tasks.filter((task) => task.capability === "certify").length, 2,
    "independent review branches must still endorse the frontier independently");
});

test("accepted skill coordination drives review mode and user policy may only upgrade it", () => {
  const fast = { reviewMode: "fast", validationScope: "focused" } as const;
  const reviewed = { reviewMode: "reviewed", validationScope: "repository-wide" } as const;
  assert.equal(codingReviewMode(fast, "fast"), "fast");
  assert.equal(codingReviewMode(fast, "auto"), "fast");
  assert.equal(codingReviewMode(fast, "reviewed"), "reviewed");
  assert.equal(codingReviewMode(reviewed, "fast"), "reviewed",
    "an explicit fast preference cannot downgrade a reviewed skill decision");
  assert.equal(codingReviewMode(reviewed, "auto"), "reviewed");
});

test("deriveCodingValidationPlan consumes the accepted typed scope without interpreting objective text", () => {
  const worker = { id: "workspace.implementation", name: "Kai", capabilities: ["implement"], metadata: { role: "worker" } };
  const supervisor = (specialty: string) => ({
    id: `workspace.${specialty}`,
    name: specialty,
    capabilities: ["review"],
    metadata: { role: "supervisor", specialty },
  });

  const fastPath = deriveCodingValidationPlan(
    { reviewMode: "fast", validationScope: "focused" },
    [worker],
  );
  assert.equal(fastPath.scope, "focused");
  assert.equal(fastPath.crossBoundary, false);

  const lowRiskReviewed = deriveCodingValidationPlan(
    { reviewMode: "reviewed", validationScope: "focused" },
    [worker, supervisor("quality")],
  );
  assert.equal(lowRiskReviewed.scope, "focused", "reviewed mode alone does not force repository-wide validation");
  assert.equal(lowRiskReviewed.crossBoundary, false);

  const repositoryWide = deriveCodingValidationPlan(
    { reviewMode: "reviewed", validationScope: "repository-wide" },
    [worker, supervisor("security")],
  );
  assert.equal(repositoryWide.scope, "repository-wide");
  assert.match(repositoryWide.rationale, /accepted coordination skill/);

  const multiSurface = deriveCodingValidationPlan(
    { reviewMode: "reviewed", validationScope: "repository-wide" },
    [worker, supervisor("api"), supervisor("data")],
  );
  assert.equal(multiSurface.scope, "repository-wide");
  assert.equal(multiSurface.changedSurfaces, 2);
  assert.match(multiSurface.rationale, /2 review specialties/);
});

test("repository-wide plans add exactly one host-bound validate-repository task and every independent terminal certification shares and validates its report", async () => {
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo",
    files: ["src/auth/login.ts", "src/data/schema.ts"],
    manifests: [],
    reviewedAt: 10,
  });
  const implementation = profile.nodes.find((node) => node.capabilities.includes("implement"));
  const supervisors = profile.nodes.filter((node) => node.metadata?.role === "supervisor");
  assert.ok(implementation);
  assert.ok(supervisors.length >= 2, "security and data files must select at least two independent specialists");
  const roster = codingPreviewHarness({
    workspaceNodes: profile.nodes,
    selectedNodeIds: profile.nodes.map((node) => node.id),
    primaryNodeId: implementation.id,
    coordination: { reviewMode: "reviewed", validationScope: "repository-wide" },
    reviewPolicy: "reviewed",
  });
  const compiled = await roster.plan({
    objective: "Harden the login token flow and the persistence schema",
    runId: "coding-shared-repository-validation",
  });

  const validateTasks = compiled.tasks.filter((task) => task.capability === "validate");
  assert.equal(validateTasks.length, 1, "exactly one bounded pre-certification validation task must exist");
  const validateTask = validateTasks[0]!;
  assert.equal(validateTask.nodeId, implementation.id, "validation must preserve the logical mutation-node identity");
  assert.deepEqual(validateTask.needs, ["final_report"], "validation runs only after remediation");
  assert.deepEqual(validateTask.provides, ["repository_validation_report"]);
  assert.match(validateTask.objective ?? "", /allowlisted lockfile-backed repository toolchain exactly once/);
  assert.match(validateTask.objective ?? "", /bounded non-model host command runtime/);
  assert.match(validateTask.objective ?? "", /trusted host worker owns staging and frontier hashing/);
  assert.doesNotMatch(validateTask.objective ?? "", /Before returning, run `git add/);

  const certifications = compiled.tasks.filter((task) => task.capability === "certify");
  assert.ok(certifications.length > 1, "independent specialists must still certify independently");
  for (const cert of certifications) {
    assert.ok(cert.needs.includes("final_report"));
    assert.ok(cert.needs.includes("repository_validation_report"),
      "every terminal certification must depend on the single shared report");
    assert.match(cert.objective ?? "", /Consume repository_validation_report/);
    assert.match(cert.objective ?? "", /do not rerun it yourself/);
    assert.match(cert.objective ?? "", /none of you owns it exclusively/);
    assert.match(cert.objective ?? "", /repository_validation_report\.frontierHash/);
    assert.match(cert.objective ?? "", /Do not run `git add`/);
    assert.doesNotMatch(cert.objective ?? "", /Before returning, run `git add/);
  }

  const remediate = compiled.tasks.find((task) => task.capability === "remediate");
  assert.match(remediate?.objective ?? "", /Do not run the full repository toolchain gate yourself here/);
  const reviews = compiled.tasks.filter((task) => task.capability === "review");
  for (const review of reviews) {
    assert.doesNotMatch(review.objective ?? "", /Consume repository_validation_report/);
    assert.match(review.objective ?? "", /do not run the full repository toolchain gate in this review/);
  }
});

test("focused reviewed plans add no repository_validation_report or validate task, and certifications stay scoped to the delta", async () => {
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo",
    files: ["src/views/widget.tsx"],
    manifests: [],
    reviewedAt: 10,
  });
  const implementation = profile.nodes.find((node) => node.capabilities.includes("implement"));
  const quality = profile.nodes.find((node) => node.metadata?.specialty === "quality");
  assert.ok(implementation);
  assert.ok(quality);
  const roster = codingPreviewHarness({
    workspaceNodes: [implementation, quality],
    selectedNodeIds: [implementation.id, quality.id],
    primaryNodeId: implementation.id,
    coordination: { reviewMode: "reviewed", validationScope: "focused" },
    reviewPolicy: "auto",
  });
  const compiled = await roster.plan({ objective: "Add a JSON health endpoint", runId: "coding-focused-no-gate" });
  assert.equal(compiled.topologicalOrder.includes("validate-repository"), false);
  assert.equal(compiled.tasks.some((task) => task.capability === "validate"), false);
  assert.equal(compiled.tasks.some((task) => task.provides.includes("repository_validation_report")), false);
  const certifications = compiled.tasks.filter((task) => task.capability === "certify");
  assert.ok(certifications.length >= 1);
  for (const cert of certifications) {
    assert.deepEqual(cert.needs, ["final_report"]);
    assert.match(cert.objective ?? "", /Validation scope: focused/);
    assert.doesNotMatch(cert.objective ?? "", /repository_validation_report/);
    assert.match(cert.objective ?? "", /final_report\.frontierHash/);
    assert.match(cert.objective ?? "", /Do not run `git add`/);
  }
});

test("evaluateCodingConsensus requires the shared repository validation report to pass and match the certified frontier", () => {
  const certificationKeys = ["collaboration_endorsement_a", "collaboration_endorsement_b"];
  const baseOutputs = {
    collaboration_resolution: JSON.stringify({ status: "aligned", summary: "Peers agree", decisions: [], unresolved: [] }),
    collaboration_endorsement_a: JSON.stringify({ verdict: "approve", frontierHash: "frontier-1" }),
    collaboration_endorsement_b: JSON.stringify({ verdict: "approve", frontierHash: "frontier-1" }),
  };

  assert.deepEqual(
    evaluateCodingConsensus(baseOutputs, certificationKeys, "repository_validation_report"),
    { done: false, blocked: "Repository-wide validation report is missing or invalid" },
  );

  const substitutedCommandOutputs = {
    ...baseOutputs,
    repository_validation_report: JSON.stringify({
      status: "passed",
      command: "npm test",
      evidence: "tests passed",
      frontierHash: "frontier-1",
    }),
  };
  assert.deepEqual(
    evaluateCodingConsensus(substitutedCommandOutputs, certificationKeys, "repository_validation_report"),
    { done: false, blocked: "Repository-wide validation report is missing or invalid" },
    "a different command cannot satisfy the authoritative full-suite gate",
  );

  const failedReportOutputs = {
    ...baseOutputs,
    repository_validation_report: JSON.stringify({
      status: "failed",
      command: "npm run verify",
      checks: ["npm run lint", "npm run build"],
      summary: "At least one repository verification command failed.",
      evidence: "exitCodes=0,1; frontierStable=true",
      frontierHash: "frontier-1",
    }),
  };
  assert.deepEqual(
    evaluateCodingConsensus(failedReportOutputs, certificationKeys, "repository_validation_report"),
    {
      done: false,
      blocked: "Repository-wide validation did not pass: At least one repository verification command failed.; checks=npm run lint, npm run build; exitCodes=0,1; frontierStable=true",
    },
  );

  const mismatchedFrontierOutputs = {
    ...baseOutputs,
    repository_validation_report: JSON.stringify({ status: "passed", command: "npm run verify", evidence: "all checks passed", frontierHash: "frontier-2" }),
  };
  assert.deepEqual(
    evaluateCodingConsensus(mismatchedFrontierOutputs, certificationKeys, "repository_validation_report"),
    { done: false, blocked: "Peers endorsed different Git diff frontiers" },
  );

  const passingOutputs = {
    ...baseOutputs,
    repository_validation_report: JSON.stringify({ status: "passed", command: "npm run verify", evidence: "all checks passed", frontierHash: "frontier-1" }),
  };
  assert.deepEqual(
    evaluateCodingConsensus(passingOutputs, certificationKeys, "repository_validation_report"),
    { done: true },
  );

  const pythonToolchainOutputs = {
    ...baseOutputs,
    repository_validation_report: JSON.stringify({
      status: "passed",
      command: "roster repository toolchain",
      checks: ["uv run --frozen --all-extras python -m pytest"],
      evidence: "all Python checks passed",
      frontierHash: "frontier-1",
    }),
  };
  assert.deepEqual(
    evaluateCodingConsensus(pythonToolchainOutputs, certificationKeys, "repository_validation_report"),
    { done: true },
  );

  assert.deepEqual(evaluateCodingConsensus(baseOutputs, certificationKeys), { done: true },
    "omitting validationReportKey preserves the focused-plan behavior with no full gate");
});

test("trusted Git frontier evidence must match Roster's immutable prepared tree", () => {
  const trusted = "a".repeat(64);
  const outputs = {
    final_report: JSON.stringify({ status: "verified", frontierHash: trusted }),
    repository_validation_report: JSON.stringify({
      status: "passed",
      command: "npm run verify",
      evidence: "all checks passed",
      frontierHash: trusted,
    }),
    collaboration_endorsement_quality: JSON.stringify({ verdict: "approve", frontierHash: trusted }),
  };
  assert.deepEqual(verifyCodingFrontierEvidence(outputs, trusted), { valid: true });
  assert.deepEqual(
    verifyCodingFrontierEvidence({
      ...outputs,
      collaboration_endorsement_quality: JSON.stringify({
        verdict: "approve",
        frontierHash: "b".repeat(64),
      }),
    }, trusted),
    {
      valid: false,
      reason: "collaboration_endorsement_quality does not certify Roster's exact Git frontier",
    },
  );
  assert.deepEqual(
    verifyCodingFrontierEvidence({}, trusted),
    { valid: false, reason: "final_report is missing valid Git frontier evidence" },
  );
});

test("dependency-routed discussion stays within the reviewed plan budget", async () => {
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo",
    files: [
      "src/server.ts",
      "src/views/app.tsx",
      "src/api/routes.ts",
      "spacetimedb/src/index.ts",
      "infra/deploy.ts",
      "docs/README.md",
      "tests/smoke/app.test.ts",
    ],
    manifests: [],
    reviewedAt: 10,
  });
  const nodes = profile.nodes.map((node, index, all) => {
    const dependency = all[index + 1];
    return dependency
      ? { ...node, metadata: { ...(node.metadata ?? {}), dependsOnNodeIds: [dependency.id] } }
      : node;
  });
  const primary = nodes.find((node) => node.capabilities.includes("implement"));
  assert.ok(primary);
  const options = {
    maxNodes: 12,
    maxSupervisors: 6,
    workspaceNodes: nodes,
    selectedNodeIds: nodes.map((node) => node.id),
    primaryNodeId: primary.id,
    coordination: { reviewMode: "reviewed", validationScope: "repository-wide" },
    reviewPolicy: "reviewed",
  } as const;
  const input = { objective: "Change the public API, persistence, runtime, UI, docs, and tests", runId: "coding-bounded-discussion" };
  const compiled = await codingPreviewHarness(options).plan(input);
  const platform = defineCodingAgentPlatform(options, input);
  const initialReviewedTasks = compiled.tasks.filter((task) =>
    !["remediate", "validate", "certify", "synthesize"].includes(task.capability));
  assert.ok(compiled.nodes.length <= 8);
  assert.ok(compiled.tasks.filter((task) => task.capability !== "room").length <= 24);
  assert.ok(initialReviewedTasks.length + 1 <= platform.definition.policy.maxFanout);
  assert.equal(
    compiled.tasks.filter((task) => task.capability === "room").length,
    compiled.tasks.filter((task) => ["propose", "respond", "resolve", "implement", "investigate", "review"].includes(task.capability)).length,
  );
});

test("coding agent fast path uses one worker and accepts structured frontier evidence", async () => {
  const fastSelection = codingSelection(codingProfile.nodes, "fast", "focused");
  assert.equal(codingReviewMode(fastSelection.coordination, "auto"), "fast");
  assert.deepEqual(evaluateFastCodingCompletion({
    final_report: JSON.stringify({ status: "verified", frontierHash: "frontier-fast" }),
  }), { done: true });
  assert.equal(deriveCodingNodeDemands(fastSelection).length, 1);

  const roster = codingPreviewHarness({ workingDirectory: "/tmp/repository", ...fastSelection });
  const compiled = await roster.plan({ objective: "Fix README typo", runId: "coding-fast-preview" });
  assert.equal(compiled.target?.id, "coding-change");
  assert.equal(compiled.target?.objective, "Fix README typo");
  assert.match(compiled.target?.acceptanceCriteria.join(" ") ?? "", /Focused validation evidence/);
  assert.deepEqual(compiled.topologicalOrder, ["announce-implement", "implement", "synthesize-final"]);
  assert.equal(compiled.nodes.filter((node) => node.metadata?.role === "worker").length, 1);
  assert.equal(compiled.nodes.filter((node) => node.metadata?.role === "supervisor").length, 0);
  assert.equal(
    compiled.nodes.find((node) => node.metadata?.role === "worker")?.runtime?.metadata?.model,
    DEFAULT_CODING_AGENT_MODELS.piWorker,
  );

  const openAiProviderRoster = codingPreviewHarness({
    workingDirectory: "/tmp/repository",
    workerRuntime: "pi-agent",
    piProvider: "openai-codex",
    ...fastSelection,
  });
  const openAiProviderPlan = await openAiProviderRoster.plan({ objective: "Fix README typo", runId: "coding-openai-preview" });
  const openAiProviderWorker = openAiProviderPlan.nodes.find((node) => node.metadata?.role === "worker");
  assert.equal(openAiProviderWorker?.runtime?.metadata?.provider, "openai-codex");
  assert.equal(openAiProviderWorker?.runtime?.metadata?.model, "gpt-5.6-luna");

  const explicitProviderRoster = codingPreviewHarness({
    workingDirectory: "/tmp/repository",
    workerRuntime: "pi-agent",
    piProvider: "anthropic",
    ...fastSelection,
  });
  const explicitProviderPlan = await explicitProviderRoster.plan({ objective: "Fix README typo", runId: "coding-explicit-provider-preview" });
  const explicitProviderWorker = explicitProviderPlan.nodes.find((node) => node.metadata?.role === "worker");
  assert.equal(explicitProviderWorker?.runtime?.metadata?.provider, "anthropic");
  assert.equal(explicitProviderWorker?.runtime?.metadata?.model, undefined);

  const calls: string[] = [];
  const runtimes = new NodeRuntimeRegistry([{
    kind: "pi-agent",
    executeEnvelope: async (envelope) => {
      calls.push(envelope.task.taskId);
      const announcement = completeCodingAnnouncement(envelope);
      if (announcement) return announcement;
      if (envelope.task.capability === "synthesize") {
        assertAuthoredFinalReportContract(envelope.resultContract, "coding_final_answer");
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: {
            coding_final_answer: {
              status: "completed",
              summary: "I fixed the README typo and validated the focused change.",
              frontierHash: "frontier-fast",
            },
          },
        };
      }
      assertAuthoredFinalReportContract(envelope.resultContract);
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: {
          final_report: {
            status: "verified",
            summary: "The mutation frontier is ready for final synthesis.",
            changedFiles: ["README.md"],
            validation: ["targeted docs check"],
            frontierHash: "frontier-fast",
          },
        },
      };
    },
  }]);
  const executionPlanes = codingExecutionPlanes("coding-fast-smoke");
  executionPlanes.roomUpdates.post({
    runId: "coding-fast-smoke",
    taskId: "implement",
    executionId: "coding-fast-room-update",
    nodeId: fastSelection.primaryNodeId,
  }, {
    updateKey: "working",
    text: "I’m applying the bounded README change.",
    intent: "progress",
    recipientNodeIds: ["human.operator"],
  });
  const execution = await runCodingAgent({
    runId: "coding-fast-smoke",
    objective: "Fix README typo",
    workingDirectory: "/tmp/repository",
    ...fastSelection,
    nodeRuntimes: runtimes,
    ...executionPlanes,
  });

  assert.deepEqual(calls, ["announce-implement", "implement", "synthesize-final"]);
  assert.equal(execution.status, "completed");
  assert.match(execution.outputs.final_report ?? "", /frontier-fast/);
  assert.match(execution.outputs.coding_result ?? "", /I fixed the README typo and validated the focused change/u);
  assert.equal(execution.snapshot.tasks.find((task) =>
    task.definition.taskId === "implement")?.outcome?.artifacts[0]?.outputKey, "final_report");
  assert.equal(
    execution.snapshot.tasks.find((task) =>
      task.definition.taskId === "implement")?.outcome?.artifacts[0]?.presentationText,
    "The mutation frontier is ready for final synthesis.",
  );
  assert.equal(
    execution.snapshot.tasks.find((task) =>
      task.definition.taskId === "synthesize-final")?.outcome?.artifacts[0]?.presentationText,
    "I fixed the README typo and validated the focused change.",
  );
  assert.equal(
    execution.snapshot.tasks.find((task) =>
      task.definition.result.mode !== "none"
      && task.definition.result.outputKey === "coding_result")?.outcome?.artifacts[0]?.presentationText,
    undefined,
    "the native certification seal must not duplicate the model-authored answer",
  );
  assert.equal(execution.snapshot.expansions.length, 2);
  assert.equal(executionPlanes.roomUpdates.list("coding-fast-smoke")[0]?.settled, true);
});

test("coding finalization follows reverse-lexical repeated-key continuations and authors one final answer", async () => {
  const suffix = (intentId: string): string => hashCanonical([intentId]).slice(0, 10);
  let firstIntentId = "";
  let secondIntentId = "";
  for (let first = 0; first < 100 && !firstIntentId; first += 1) {
    for (let second = 100; second < 200; second += 1) {
      const left = `follow-up-${String(first)}`;
      const right = `follow-up-${String(second)}`;
      if (suffix(right).localeCompare(suffix(left)) < 0) {
        firstIntentId = left;
        secondIntentId = right;
        break;
      }
    }
  }
  assert.ok(firstIntentId && secondIntentId);
  assert.ok(suffix(secondIntentId).localeCompare(suffix(firstIntentId)) < 0);
  const workspaceId = "workspace-follow-up";
  const roomId = "room-follow-up";
  const runId = "coding-follow-up-frontier";
  const firstIntent = createCodingRoomControlIntent({
    workspaceId,
    roomId,
    intentId: firstIntentId,
    kind: "follow-up",
    text: "Include the first bounded follow-up.",
    createdAtMs: 1,
  });
  const secondIntent = createCodingRoomControlIntent({
    workspaceId,
    roomId,
    intentId: secondIntentId,
    kind: "follow-up",
    text: "Replace it with the second certified follow-up.",
    createdAtMs: 2,
  });
  let finalizerBoundaries = 0;
  const consumed: string[] = [];
  const calls: string[] = [];
  const runtimes = new NodeRuntimeRegistry([{
    kind: "pi-agent",
    executeEnvelope: async (envelope) => {
      calls.push(envelope.task.taskId);
      const announcement = completeCodingAnnouncement(envelope);
      if (announcement) return announcement;
      if (envelope.task.capability === "synthesize") {
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: {
            coding_final_answer: {
              status: "completed",
              summary: "I incorporated both follow-ups and certified the second continuation.",
              frontierHash: "frontier-second-follow-up",
            },
          },
        };
      }
      const selected = envelope.task.objective.includes(secondIntentId)
        ? { summary: "Second continuation.", frontierHash: "frontier-second-follow-up" }
        : envelope.task.objective.includes(firstIntentId)
          ? { summary: "First continuation.", frontierHash: "frontier-first-follow-up" }
          : { summary: "Original frontier.", frontierHash: "frontier-original" };
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: {
          final_report: {
            status: "verified",
            summary: selected.summary,
            changedFiles: ["README.md"],
            validation: ["focused follow-up check"],
            frontierHash: selected.frontierHash,
          },
        },
      };
    },
  }]);
  const execution = await runCodingAgent({
    runId,
    objective: "Apply a focused change with bounded follow-ups",
    workingDirectory: "/tmp/repository",
    ...codingSelection(codingProfile.nodes, "fast", "focused"),
    nodeRuntimes: runtimes,
    ...codingExecutionPlanes(runId),
    roomControlIntents: {
      workspaceId,
      roomId,
      authority: {
        pending: async () => {
          finalizerBoundaries += 1;
          return finalizerBoundaries === 1
            ? [firstIntent]
            : finalizerBoundaries === 2 ? [secondIntent] : [];
        },
        consume: async (input) => { consumed.push(input.intentId); },
      },
    },
  });

  assert.equal(execution.status, "completed");
  assert.deepEqual(consumed, [firstIntentId, secondIntentId]);
  assert.equal(calls.filter((taskId) => taskId.startsWith("implement")).length, 3);
  assert.equal(calls.filter((taskId) => taskId.startsWith("synthesize-final")).length, 1);
  const firstContinuation = execution.snapshot.tasks.find((task) =>
    task.definition.objective.includes(firstIntentId));
  const secondContinuation = execution.snapshot.tasks.find((task) =>
    task.definition.objective.includes(secondIntentId));
  assert.ok(firstContinuation && secondContinuation);
  assert.deepEqual(secondContinuation.definition.dependencies, [{
    taskId: firstContinuation.definition.taskId,
    condition: "accepted",
  }], "each follow-up must continue the previously accepted mutation frontier");
  assert.equal(JSON.parse(execution.outputs.final_report ?? "{}").frontierHash, "frontier-second-follow-up");
  const finalResult = JSON.parse(execution.outputs.coding_result ?? "{}") as {
    readonly finalAnswer?: string;
    readonly sourceTaskId?: string;
    readonly certifiedFrontierHash?: string;
  };
  assert.equal(finalResult.finalAnswer, "I incorporated both follow-ups and certified the second continuation.");
  assert.equal(finalResult.certifiedFrontierHash, "frontier-second-follow-up");
  assert.equal(finalResult.sourceTaskId, `synthesize-final-followup-${suffix(secondIntentId)}`);
});

test("coding finalization fails closed when the model omits its human-addressed summary", async () => {
  const calls: string[] = [];
  const execution = await runCodingAgent({
    runId: "coding-missing-final-summary",
    objective: "Apply a focused change without accepting a scripted fallback",
    workingDirectory: "/tmp/repository",
    ...codingSelection(codingProfile.nodes, "fast", "focused"),
    nodeRuntimes: new NodeRuntimeRegistry([{
      kind: "pi-agent",
      executeEnvelope: async (envelope) => {
        calls.push(envelope.task.taskId);
        const announcement = completeCodingAnnouncement(envelope);
        if (announcement) return announcement;
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: envelope.task.capability === "synthesize"
            ? { coding_final_answer: {
                status: "completed",
                frontierHash: "frontier-without-summary",
              } }
            : { final_report: {
                status: "verified",
                summary: "The mutation frontier is verified.",
                frontierHash: "frontier-without-summary",
              } },
        };
      },
    }]),
    ...codingExecutionPlanes("coding-missing-final-summary"),
  });

  assert.equal(execution.status, "failed");
  assert.deepEqual(calls.slice(0, 2), ["announce-implement", "implement"]);
  assert.ok(calls.slice(2).every((taskId) => taskId === "synthesize-final"));
  assert.equal(execution.outputs.coding_result, undefined);
  assert.notEqual(execution.snapshot.tasks.find((task) =>
    task.definition.taskId === "coding-complete")?.status, "accepted");
});

test("coding room updates remain visible through a retry and settle only at terminal success", async () => {
  const selection = codingSelection(codingProfile.nodes, "fast", "focused");
  const runId = "coding-room-update-retry";
  const executionPlanes = codingExecutionPlanes(runId);
  executionPlanes.roomUpdates.post({
    runId,
    taskId: "implement",
    executionId: "coding-room-update-retry-attempt",
    nodeId: selection.primaryNodeId,
  }, {
    updateKey: "working",
    text: "I’m retaining this progress update across the retry.",
    intent: "progress",
    recipientNodeIds: ["human.operator"],
  });
  let attempts = 0;
  const runtimes = new NodeRuntimeRegistry([{
    kind: "pi-agent",
    executeEnvelope: async (envelope) => {
      const announcement = completeCodingAnnouncement(envelope);
      if (announcement) return announcement;
      if (envelope.task.capability === "synthesize") {
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: { coding_final_answer: {
            status: "completed",
            summary: "I completed the focused README change after one retry.",
            frontierHash: "frontier-retry",
          } },
        };
      }
      attempts += 1;
      assert.equal(executionPlanes.roomUpdates.list(runId)[0]?.settled, false);
      if (attempts === 1) {
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "failed",
          error: "transient provider interruption",
          retryable: true,
        };
      }
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: {
          final_report: {
            status: "verified",
            summary: "The retry completed the focused change.",
            changedFiles: ["README.md"],
            validation: ["focused retry check"],
            frontierHash: "frontier-retry",
          },
        },
      };
    },
  }]);

  const execution = await runCodingAgent({
    runId,
    objective: "Retry a focused README change",
    workingDirectory: "/tmp/repository",
    ...selection,
    nodeRuntimes: runtimes,
    ...executionPlanes,
  });

  assert.equal(attempts, 2);
  assert.equal(execution.status, "completed");
  assert.equal(executionPlanes.roomUpdates.list(runId)[0]?.settled, true);
});

test("coding accepts graph-authored announcements without requiring a room function call", async () => {
  const runId = "coding-room-update-required";
  const calls: string[] = [];
  const executionPlanes = codingExecutionPlanes(runId);
  const execution = await runCodingAgent({
    runId,
    objective: "Apply a focused README change",
    workingDirectory: "/tmp/repository",
    ...codingSelection(codingProfile.nodes, "fast", "focused"),
    nodeRuntimes: new NodeRuntimeRegistry([{
      kind: "pi-agent",
      executeEnvelope: async (envelope) => {
        calls.push(envelope.task.taskId);
        const outputKey = envelope.resultContract.mode === "json"
          ? (envelope.resultContract.schema as { readonly required?: ReadonlyArray<string> }).required?.[0]
          : undefined;
        assert.ok(outputKey);
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: envelope.task.capability === "room"
            ? { [outputKey]: { summary: "I’m starting the focused README change now." } }
            : envelope.task.capability === "synthesize"
              ? { coding_final_answer: {
                  status: "completed",
                  summary: "The focused README change is ready.",
                  frontierHash: "frontier-without-authored-start",
                } }
              : { final_report: {
                  status: "verified",
                  summary: "The focused change is ready.",
                  changedFiles: ["README.md"],
                  validation: ["targeted docs check"],
                  frontierHash: "frontier-without-authored-start",
                } },
        };
      },
    }]),
    ...executionPlanes,
  });

  assert.equal(execution.status, "completed");
  assert.ok(calls.indexOf("announce-implement") < calls.indexOf("implement"));
  assert.deepEqual(executionPlanes.roomUpdates.list(runId), []);
});

test("coding blocks substantive work when its model-authored announcement fails", async () => {
  const runId = "coding-room-announcement-failure";
  let substantiveStarted = false;
  const execution = await runCodingAgent({
    runId,
    objective: "Apply a focused README change",
    workingDirectory: "/tmp/repository",
    ...codingSelection(codingProfile.nodes, "fast", "focused"),
    nodeRuntimes: new NodeRuntimeRegistry([{
      kind: "pi-agent",
      executeEnvelope: async (envelope) => {
        if (envelope.task.capability === "room") {
          return {
            schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
            status: "failed",
            error: "announcement model unavailable",
          };
        }
        substantiveStarted = true;
        throw new Error("substantive work must not start");
      },
    }]),
    ...codingExecutionPlanes(runId),
  });

  assert.equal(execution.status, "failed");
  assert.equal(substantiveStarted, false);
  assert.match(
    execution.snapshot.tasks.map((task) => task.error ?? "").join(" | "),
    /announcement model unavailable/u,
  );
});

test("coding investigation fans out read-only evidence work and synthesizes a final answer", async () => {
  const primary = codingProfile.nodes.find((node) => node.capabilities.includes("implement"));
  const reviewers = codingProfile.nodes.filter((node) => node.capabilities.includes("review")).slice(0, 2);
  assert.ok(primary);
  assert.ok(reviewers.length > 0);
  const selection = {
    workspaceNodes: codingProfile.nodes,
    selectedNodeIds: [primary.id, ...reviewers.map((node) => node.id)],
    primaryNodeId: primary.id,
    coordination: { reviewMode: "reviewed", validationScope: "focused" } as const,
    executionKind: "investigation" as const,
  };
  assert.equal(deriveCodingNodeDemands(selection).length, 1 + reviewers.length);
  assert.deepEqual(evaluateCodingInvestigationCompletion({
    final_report: JSON.stringify({ status: "completed", answer: "Evidence-backed answer", findings: [] }),
  }), { done: true });

  const compiled = await codingPreviewHarness({
    workingDirectory: "/tmp/repository",
    ...selection,
  }).plan({
    objective: "Trace how billing works across the repository",
    runId: "coding-investigation-preview",
  });

  assert.equal(compiled.target.id, "coding-investigation");
  assert.ok(compiled.tasks.length >= 2);
  assert.ok(compiled.tasks.every((task) =>
    task.capability === "room" || task.capability === "investigate"));
  assert.equal(compiled.tasks.at(-1)?.id, "synthesize-investigation");
  assert.equal(compiled.topologicalOrder.at(-1), "synthesize-investigation");
  assert.equal(compiled.tasks.some((task) => task.capability === "implement"), false);
  const evidenceTasks = compiled.tasks.filter((task) => task.id.startsWith("investigate-"));
  assert.ok(evidenceTasks.every((task) =>
    /direct, natural first-person (?:message|conversational reply) to/.test(task.objective)));
  assert.ok(evidenceTasks.every((task) => /shown verbatim in the shared room/.test(task.objective)));
  assert.match(compiled.tasks.at(-1)?.objective ?? "", /direct, natural first-person reply to/);
  assert.match(compiled.tasks.at(-1)?.objective ?? "", /acknowledge the useful evidence you received/);
  const worker = compiled.nodes.find((node) => node.metadata?.role === "worker");
  const peers = compiled.nodes.filter((node) => node.metadata?.role === "supervisor");
  assert.equal(worker?.runtime.metadata?.projectTrust, "no-approve");
  assert.ok(Array.isArray(worker?.runtime.metadata?.tools));
  assert.equal((worker?.runtime.metadata?.tools as ReadonlyArray<string>).includes("bash"), false);
  assert.ok(peers.every((node) => node.runtime.metadata?.sandbox === "read-only"));

  const calls: string[] = [];
  const executeInvestigation = async (envelope: Parameters<NonNullable<import("../../src/engine/runtime/node-runtime.ts").NodeRuntimeAdapter["executeEnvelope"]>>[0]) => {
    calls.push(envelope.task.taskId);
    assert.equal(envelope.surface.codeMode, undefined);
    assert.equal(
      envelope.grant.budgets.maxFunctionCalls,
      envelope.task.capability === "room" ? 1 : 3,
    );
    if (envelope.task.capability === "room") {
      if (envelope.grant.functionAccess.functionGrants.length > 0
        || envelope.grant.functionAccess.allowedEffects.length > 0
        || envelope.surface.tools.length > 0) {
        throw new Error(`room grant mismatch for ${envelope.task.taskId}: grants=${envelope.grant.functionAccess.functionGrants.join(",")} effects=${envelope.grant.functionAccess.allowedEffects.join(",")} tools=${envelope.surface.tools.map((tool) => tool.id).join(",")}`);
      }
    }
    const outputKey = envelope.resultContract.mode === "json"
      ? (envelope.resultContract.schema as { readonly required?: ReadonlyArray<string> }).required?.[0]
      : undefined;
    assert.ok(outputKey);
    if (outputKey === "final_report") {
      const schema = envelope.resultContract.schema as {
        readonly properties?: Readonly<Record<string, {
          readonly required?: ReadonlyArray<string>;
        }>>;
      };
      assert.deepEqual(schema.properties?.final_report?.required, [
        "status",
        "summary",
        "answer",
        "findings",
        "files",
        "limitations",
        "specialistReports",
      ]);
    }
    return {
      schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
      status: "completed" as const,
      output: envelope.task.capability === "room"
        ? { [outputKey]: { summary: "I’m starting my bounded repository investigation." } }
        : outputKey === "final_report"
        ? {
            final_report: {
              status: "completed",
              summary: "Billing is traced through the repository.",
              answer: "The evidence-backed billing explanation.",
              findings: [],
              files: ["src/server.ts"],
              limitations: [],
              specialistReports: [],
            },
          }
        : {
            [outputKey]: {
              status: "completed",
              summary: "Specialist evidence",
              findings: [],
              files: ["src/server.ts"],
              limitations: [],
            },
          },
    };
  };
  const execution = await runCodingAgent({
    runId: "coding-investigation-smoke",
    objective: "Trace how billing works across the repository",
    workingDirectory: "/tmp/repository",
    ...selection,
    nodeRuntimes: new NodeRuntimeRegistry([
      { kind: "pi-agent", executeEnvelope: executeInvestigation },
      { kind: "codex-cli", executeEnvelope: executeInvestigation },
    ]),
    ...codingExecutionPlanes("coding-investigation-smoke"),
  });
  assert.equal(
    execution.status,
    "completed",
    execution.snapshot.tasks.map((task) => `${task.definition.taskId}:${task.status}:${task.error ?? ""}`).join(" | "),
  );
  for (const taskId of calls.filter((taskId) => taskId.startsWith("investigate-"))) {
    assert.ok(calls.indexOf(`announce-${taskId}`) < calls.indexOf(taskId), taskId);
  }
  assert.ok(calls.includes("synthesize-investigation"));
  assert.match(execution.outputs.final_report ?? "", /evidence-backed billing explanation/);
  assert.match(execution.outputs.coding_result ?? "", /Billing is traced through the repository/);
});

test("coding agent supports Codex as an explicit worker runtime", async () => {
  const roster = codingPreviewHarness({
    workingDirectory: "/tmp/repository",
    workerRuntime: "codex-cli",
    codexModel: "gpt-5.6-luna",
    ...codingSelection(codingProfile.nodes, "fast", "focused"),
  });
  const compiled = await roster.plan({ objective: "Fix README typo", runId: "coding-codex-preview" });
  const plannedWorker = compiled.nodes.find((node) => node.metadata?.role === "worker");
  assert.equal(plannedWorker?.runtime?.kind, "codex-cli");
  assert.equal(plannedWorker?.runtime?.metadata?.model, "gpt-5.6-luna");
  assert.equal(plannedWorker?.runtime?.metadata?.sandbox, "workspace-write");

  const calls: string[] = [];
  const runtimes = new NodeRuntimeRegistry([{
    kind: "codex-cli",
    executeEnvelope: async (envelope) => {
      calls.push(envelope.task.taskId);
      assert.equal(envelope.runtime.kind, "codex-cli");
      const announcement = completeCodingAnnouncement(envelope);
      if (announcement) return announcement;
      if (envelope.task.capability === "synthesize") {
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: { coding_final_answer: {
            status: "completed",
            summary: "I completed and certified the README fix with the Codex worker.",
            frontierHash: "frontier-codex",
          } },
        };
      }
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: {
          final_report: {
            status: "verified",
            summary: "I completed the README fix with the Codex worker.",
            changedFiles: ["README.md"],
            validation: ["Codex worker smoke"],
            frontierHash: "frontier-codex",
          },
        },
      };
    },
  }]);
  const execution = await runCodingAgent({
    runId: "coding-codex-smoke",
    objective: "Fix README typo",
    workingDirectory: "/tmp/repository",
    workerRuntime: "codex-cli",
    ...codingSelection(codingProfile.nodes, "fast", "focused"),
    nodeRuntimes: runtimes,
    ...codingExecutionPlanes("coding-codex-smoke"),
  });

  assert.deepEqual(calls, ["announce-implement", "implement", "synthesize-final"]);
  assert.equal(execution.status, "completed");
  assert.match(execution.outputs.final_report ?? "", /frontier-codex/);
});

test("a human-resolved continuation starts implementation without reopening peer resolution", async () => {
  const calls: string[] = [];
  const humanResolution = {
    status: "resolved" as const,
    summary: "The human participant resolved selector placement.",
    decisions: [{
      subjectId: "public-contract",
      resolution: "Keep the selector in primary chrome and apply the preference everywhere.",
      rationale: "The operator selected the bounded placement.",
      evidence: ["conversation-message:human-answer"],
    }],
    unresolved: [],
  };
  const runtimes = new NodeRuntimeRegistry([
    {
      kind: "pi-agent",
      executeEnvelope: async (envelope) => {
        calls.push(envelope.task.taskId);
        const announcement = completeCodingAnnouncement(envelope);
        if (announcement) return announcement;
        if (envelope.task.capability === "synthesize") {
          return {
            schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
            status: "completed",
            output: { coding_final_answer: {
              status: "completed",
              summary: "I applied the human-resolved direction and certified the reviewed frontier.",
              frontierHash: "frontier-human",
            } },
          };
        }
        if (envelope.task.taskId === "implement") {
          const inputs = (envelope.input as {
            readonly inputs?: {
              readonly inputVersions?: Readonly<Record<string, string>>;
              readonly dataReferences?: ReadonlyArray<{
                readonly contentHash: string;
              }>;
              readonly resolvedDataReferences?: ReadonlyArray<{
                readonly contentHash: string;
                readonly value: unknown;
              }>;
            };
          }).inputs;
          const resolutionHash = inputs?.inputVersions?.collaboration_resolution;
          assert.ok(resolutionHash);
          assert.ok(inputs?.dataReferences?.some((reference) =>
            reference.contentHash === resolutionHash));
          const resolved = inputs?.resolvedDataReferences?.find((reference) =>
            reference.contentHash === resolutionHash);
          assert.ok(resolved);
          assert.deepEqual(resolved.value, humanResolution);
          assert.equal(JSON.stringify(inputs).includes("\"metadata\""), false);
        }
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: envelope.task.taskId === "implement"
            ? { implementation_report: { changed: ["theme.ts"], validation: ["targeted theme test"] } }
            : { final_report: {
                status: "verified",
                summary: "I applied the human-resolved direction and reconciled review findings.",
                validation: ["targeted theme test"],
                frontierHash: "frontier-human",
              } },
        };
      },
    },
    {
      kind: "codex-cli",
      executeEnvelope: async (envelope) => {
        calls.push(envelope.task.taskId);
        const announcement = completeCodingAnnouncement(envelope);
        if (announcement) return announcement;
        const required = envelope.resultContract.mode === "json"
          ? (envelope.resultContract.schema as { readonly required?: ReadonlyArray<string> }).required ?? []
          : [];
        const outputKey = required[0];
        assert.ok(outputKey);
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: {
            [outputKey]: envelope.task.capability === "certify"
              ? { verdict: "approve", frontierHash: "frontier-human", summary: "approved", evidence: [] }
              : { findings: [] },
          },
        };
      },
    },
  ]);
  const execution = await runCodingAgent({
    runId: "coding-human-continuation",
    objective: "Update the root theme",
    workingDirectory: "/tmp/repository",
    ...codingSelection(
      codingProfile.nodes,
      "reviewed",
      "focused",
      ["workspace.implementation", "workspace.quality"],
    ),
    humanResolution,
    nodeRuntimes: runtimes,
    ...codingExecutionPlanes("coding-human-continuation"),
  });

  assert.deepEqual(calls.filter((taskId) => !taskId.startsWith("announce-")).map((taskId) => taskId
    .replace(/^review-.+$/, "review")
    .replace(/^certify-.+$/, "certify")), [
      "implement",
      "review",
      "remediate",
      "certify",
      "synthesize-final",
    ]);
  assert.equal(execution.snapshot.tasks.some((task) =>
    task.definition.taskId === "resolve-collaboration"), false);
  assert.match(execution.outputs.collaboration_resolution ?? "", /resolved/);
  assert.equal(execution.status, "completed");
});

test("repository-wide validation rebinds the logical mutation node to the bounded host command runtime", async () => {
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo",
    files: ["src/auth/login.ts", "src/data/schema.ts"],
    manifests: [],
    reviewedAt: 10,
  });
  const implementation = profile.nodes.find((node) => node.capabilities.includes("implement"));
  assert.ok(implementation);
  const calls: Array<{ readonly taskId: string; readonly runtime: string }> = [];
  const frontierHash = "frontier-host-validation";
  const runtimes = new NodeRuntimeRegistry([
    {
      kind: "pi-agent",
      executeEnvelope: async (envelope) => {
        calls.push({ taskId: envelope.task.taskId, runtime: envelope.runtime.kind });
        const announcement = completeCodingAnnouncement(envelope);
        if (announcement) return announcement;
        if (envelope.task.capability === "synthesize") {
          return {
            schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
            status: "completed",
            output: { coding_final_answer: {
              status: "completed",
              summary: "I reconciled the review and certified the repository-wide validation frontier.",
              frontierHash,
            } },
          };
        }
        if (envelope.task.capability === "remediate") {
          assertAuthoredFinalReportContract(envelope.resultContract);
        }
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: envelope.task.capability === "implement"
            ? { implementation_report: { changed: [], validation: [] } }
            : { final_report: {
                status: "verified",
                summary: "I reconciled the repository-wide review findings.",
                validation: ["repository gate delegated to the host validator"],
                frontierHash,
              } },
        };
      },
    },
    {
      kind: "codex-cli",
      executeEnvelope: async (envelope) => {
        calls.push({ taskId: envelope.task.taskId, runtime: envelope.runtime.kind });
        const announcement = completeCodingAnnouncement(envelope);
        if (announcement) return announcement;
        const required = envelope.resultContract.mode === "json"
          ? (envelope.resultContract.schema as { readonly required?: ReadonlyArray<string> }).required ?? []
          : [];
        const outputKey = required[0];
        assert.ok(outputKey);
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: {
            [outputKey]: envelope.task.capability === "certify"
              ? { verdict: "approve", frontierHash, summary: "approved", evidence: [] }
              : { findings: [] },
          },
        };
      },
    },
    {
      kind: "shell",
      executeEnvelope: async (envelope) => {
        calls.push({ taskId: envelope.task.taskId, runtime: envelope.runtime.kind });
        assert.equal(envelope.task.taskId, "validate-repository");
        assert.equal(envelope.runtime.profile, "repository-validation");
        assert.ok(envelope.runtime.command?.includes("/tmp/repository-validation-checkout"));
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: {
            repository_validation_report: {
              status: "passed",
              command: "npm run verify",
              evidence: "exitCode=0",
              frontierHash,
            },
          },
        };
      },
    },
  ]);
  const execution = await runCodingAgent({
    runId: "coding-host-validation",
    objective: "Harden the login token flow and the persistence schema",
    workingDirectory: "/tmp/repository-validation-checkout",
    workspaceNodes: profile.nodes,
    selectedNodeIds: profile.nodes.map((node) => node.id),
    primaryNodeId: implementation.id,
    coordination: { reviewMode: "reviewed", validationScope: "repository-wide" },
    reviewPolicy: "reviewed",
    humanResolution: {
      status: "resolved",
      summary: "The human participant accepted the repository policy.",
      decisions: [{
        subjectId: "validation",
        resolution: "Run the full repository gate once.",
        rationale: "This is the release boundary.",
        evidence: ["conversation-message:validation"],
      }],
      unresolved: [],
    },
    nodeRuntimes: runtimes,
    ...codingExecutionPlanes("coding-host-validation"),
  });

  assert.equal(calls.filter((call) => call.taskId === "validate-repository").length, 1);
  assert.deepEqual(calls.find((call) => call.taskId === "validate-repository"), {
    taskId: "validate-repository",
    runtime: "shell",
  });
  assert.equal(execution.snapshot.tasks.find((task) =>
    task.definition.taskId === "validate-repository")?.definition.runtimeBindingEpoch, 2);
  assert.equal(
    execution.snapshot.tasks.find((task) =>
      task.definition.capability === "remediate")?.outcome?.artifacts[0]?.presentationText,
    "I reconciled the repository-wide review findings.",
  );
  assert.equal(execution.status, "completed");
});

test("coding peer consensus rejects unresolved decisions and mismatched frontiers", () => {
  const resolution = JSON.stringify({
    status: "aligned",
    summary: "Peers agree.",
    decisions: [],
    unresolved: [],
  });
  assert.deepEqual(evaluateCodingConsensus({
    collaboration_resolution: resolution,
    certification_correctness: JSON.stringify({ verdict: "approve", frontierHash: "frontier-a" }),
    certification_tests: JSON.stringify({ verdict: "changes_requested", frontierHash: "frontier-a" }),
  }, ["certification_correctness", "certification_tests"]), {
    done: false,
    blocked: "At least one peer requested changes",
  });
  assert.deepEqual(evaluateCodingConsensus({
    collaboration_resolution: resolution,
    certification_correctness: JSON.stringify({ verdict: "approve", frontierHash: "frontier-a" }),
    certification_tests: JSON.stringify({ verdict: "approve", frontierHash: "frontier-b" }),
  }, ["certification_correctness", "certification_tests"]), {
    done: false,
    blocked: "Peers endorsed different Git diff frontiers",
  });
  assert.deepEqual(evaluateCodingConsensus({
    collaboration_resolution: JSON.stringify({
      status: "ambiguous",
      summary: "The migration policy is unknown.",
      decisions: [],
      unresolved: [{ subjectId: "migration", reason: "No policy", candidateSummaries: ["A", "B"] }],
    }),
  }, []), {
    done: false,
    blocked: "Peer collaboration has unresolved semantic conflicts",
  });
});
