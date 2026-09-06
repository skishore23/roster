import assert from "node:assert/strict";
import test from "node:test";

import type { LlmStructured } from "../../src/adapters/openai.ts";
import {
  NODE_EXECUTION_SCHEMA_VERSION,
  NodeRuntimeRegistry,
  type NodeExecutionEnvelope,
} from "../../src/engine/runtime/node-runtime.ts";
import {
  codingConversationFromEvents,
  codingConversationInlineMentions,
  codingConversationInlineTags,
  codingConversationImageEvent,
  codingConversationMessageEvent,
  codingConversationObjective,
  codingConversationTranscript,
  createCodingConversationMessage,
  createCodingConversationImage,
  createCodingConversationRoute,
  codingConversationRouteEvent,
  modelCodingConversationAnswerer,
  modelCodingConversationPlanner,
  validateCodingConversationPlannerResult,
} from "../../src/domains/coding-conversation.ts";
import {
  CodingConversationRuntimeUnavailableError,
  localRuntimeCodingConversationPlanner,
} from "../../src/domains/coding-conversation-runtime.ts";
import { CODING_HUMAN_NODE_ID, codingHumanWorkspaceNode, reviewCodingWorkspaceSnapshot } from "../../src/domains/coding-workspace.ts";
import { deriveCodingNodeDemands, materializeCodingNode } from "../../src/domains/coding.ts";

const profile = reviewCodingWorkspaceSnapshot({
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

test("conversation messages use stable external identities and open namespaced tags", () => {
  const input = {
    conversationId: "coding-conversation",
    author: { kind: "user" as const, id: "github:42", name: "Ada" },
    source: {
      kind: "pr-comment" as const,
      provider: "github",
      repository: "acme/repo",
      externalId: "comment-42",
      revision: "1",
    },
    text: "@workspace.data please check this #domain:data #intent:review",
    createdAt: 10,
  };
  const first = createCodingConversationMessage(input);
  const duplicate = createCodingConversationMessage({ ...input, createdAt: 99 });
  const edited = createCodingConversationMessage({
    ...input,
    text: `${input.text} after the migration`,
    source: { ...input.source, revision: "2" },
  });

  assert.equal(first.messageId, duplicate.messageId);
  assert.notEqual(first.messageId, edited.messageId);
  assert.deepEqual(codingConversationInlineMentions(input.text), ["workspace.data"]);
  assert.deepEqual(codingConversationInlineTags(input.text), ["domain:data", "intent:review"]);
  assert.deepEqual(first.tags, [
    "author:user",
    "domain:data",
    "intent:review",
    "routing:mention",
    "source:pr-comment",
  ]);
});

test("conversation envelopes reserve canonical provenance and routing tags", () => {
  const message = createCodingConversationMessage({
    conversationId: "coding-canonical-tags",
    author: { kind: "agent", id: "workspace.quality", name: "Mira" },
    source: { kind: "agent" },
    text: "I reviewed the evidence.",
    replyTo: "coding_message_parent",
    tags: Array.from({ length: 24 }, (_, index) => `custom:item-${index}`),
  });
  assert.equal(message.tags.length, 24);
  assert.ok(message.tags.includes("source:agent"));
  assert.ok(message.tags.includes("author:agent"));
  assert.ok(message.tags.includes("thread:reply"));

  const route = createCodingConversationRoute({
    conversationId: message.conversationId,
    inReplyTo: message.messageId,
    disposition: "ready",
    selectedNodeIds: ["workspace.implementation"],
    primaryNodeId: "workspace.implementation",
    coordination: { reviewMode: "fast", validationScope: "focused" },
    rationale: "The implementation node owns mutation.",
    confidence: 1,
  });
  assert.deepEqual(route.tags, [
    "disposition:ready",
    "intent:execution",
    "routing:nodes",
    "routing:roster",
  ]);

  const operational = createCodingConversationRoute({
    conversationId: message.conversationId,
    inReplyTo: message.messageId,
    disposition: "operational",
    selectedNodeIds: [],
    answer: "This room cannot restart the host development process.",
    rationale: "The request targets host process control, not tracked repository content.",
    confidence: 1,
  });
  assert.deepEqual(operational.tags, [
    "disposition:operational",
    "intent:operational",
    "routing:roster",
  ]);
  assert.equal(operational.answer, "This room cannot restart the host development process.");
});

test("conversation images are bounded durable artifacts", () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const image = createCodingConversationImage({
    conversationId: "coding-image",
    name: "layout.png",
    mediaType: "image/png",
    dataUrl,
    width: 1,
    height: 1,
    createdAt: 9,
  });
  const message = createCodingConversationMessage({
    conversationId: image.conversationId,
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Match this layout.",
    attachments: [image],
    createdAt: 10,
  });
  const replayed = codingConversationFromEvents([
    codingConversationImageEvent(image),
    codingConversationMessageEvent(message),
  ]);
  assert.equal(replayed.images[0]?.dataUrl, dataUrl);
  assert.deepEqual(replayed.messages[0]?.attachments, [{
    kind: "image",
    artifactId: image.artifactId,
    name: "layout.png",
    mediaType: "image/png",
    width: 1,
    height: 1,
  }]);

  assert.throws(
    () => createCodingConversationImage({
      conversationId: "coding-image",
      name: "payload.svg",
      mediaType: "image/svg+xml",
      dataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
    }),
    /must be PNG, JPEG, WebP, or GIF/,
  );
});

test("model routing is dynamic but Roster rejects invented nodes and requires typed authorities", async () => {
  const invalidPlanner: LlmStructured = async () => ({
    parsed: {
      disposition: "escalated",
      selectedNodeIds: ["workspace.implementation", "workspace.data", "invented.root"],
      primaryNodeId: "workspace.implementation",
      coordination: { reviewMode: "reviewed", validationScope: "repository-wide" },
      tags: ["domain:data", "risk:migration", "not-a-tag"],
      questions: [],
      answer: null,
      rationale: "The migration needs the saved data specialist.",
      confidence: 0.91,
    },
    raw: "{}",
  } as never);
  const message = createCodingConversationMessage({
    conversationId: "coding-dynamic",
    author: { kind: "user", id: "operator", name: "You" },
    source: { kind: "ui" },
    text: "Change the database migration and API contract",
    createdAt: 10,
  });
  const input = {
    conversationId: message.conversationId,
    messages: [message],
    workspaceNodes: profile.nodes,
    repositoryContext: {
      repositoryName: "repo",
      currentBranch: "main",
      headCommit: "abc123",
      workingTree: "clean",
    },
  };
  await assert.rejects(
    modelCodingConversationPlanner(invalidPlanner)(input),
    /unknown workspace node invented\.root/,
  );
  const validPlanner: LlmStructured = async () => ({
    parsed: {
      disposition: "escalated",
      selectedNodeIds: ["workspace.implementation", "workspace.data", "workspace.quality"],
      primaryNodeId: "workspace.implementation",
      coordination: { reviewMode: "reviewed", validationScope: "repository-wide" },
      tags: ["domain:data", "risk:migration", "not-a-tag"],
      questions: [],
      answer: null,
      rationale: "The migration needs the saved implementation, data, and quality responsibilities.",
      confidence: 0.91,
    },
    raw: "{}",
  } as never);
  const planned = await modelCodingConversationPlanner(validPlanner)(input);

  assert.ok(planned.selectedNodeIds.includes("workspace.implementation"));
  assert.ok(planned.selectedNodeIds.includes("workspace.data"));
  assert.equal(planned.primaryNodeId, "workspace.implementation");
  assert.ok(!planned.selectedNodeIds.includes("invented.root"));
  assert.deepEqual(planned.tags, ["domain:data", "risk:migration"]);

  const demands = deriveCodingNodeDemands({
    coordination: planned.coordination,
    reviewPolicy: "reviewed",
    workspaceNodes: profile.nodes,
    selectedNodeIds: planned.selectedNodeIds,
    primaryNodeId: planned.primaryNodeId,
  });
  assert.deepEqual(demands.map((demand) => demand.specialty), ["implementation", "quality", "data"]);
  assert.deepEqual(demands.map((demand) => demand.name), [
    "Kai, Implementation Engineer",
    "Mira, Quality Reviewer",
    "Iris, Data Architect",
  ]);
  const primary = materializeCodingNode({
    runId: "coding-dynamic",
    reflectionId: "reflection-dynamic",
    index: 0,
    demand: demands[0]!,
    profileNode: profile.nodes.find((node) => node.id === planned.primaryNodeId),
    options: { workerRuntime: "pi-agent", workingDirectory: "/repo/.roster/run" },
  });
  assert.equal(primary.id, "workspace.implementation");
  assert.equal(primary.name, "Kai, Implementation Engineer");
  assert.equal(primary.runtime?.kind, "pi-agent");
  assert.equal(primary.metadata?.role, "worker");
});

test("local host-operation follow-ups stay direct and cannot expand a repository graph", async () => {
  const initial = createCodingConversationMessage({
    conversationId: "coding-local-operation",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "The UI is local. What should I do?",
    createdAt: 10,
  });
  const guidance = createCodingConversationRoute({
    conversationId: initial.conversationId,
    inReplyTo: initial.messageId,
    disposition: "informational",
    selectedNodeIds: [],
    answer: "Pull the current checkout, restart the local development server, and refresh the browser.",
    rationale: "The user asked for local troubleshooting guidance.",
    confidence: 0.9,
    createdAt: 11,
  });
  const followUp = createCodingConversationMessage({
    conversationId: initial.conversationId,
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "can you do it",
    createdAt: 12,
  });
  let plannerInput: Readonly<Record<string, unknown>> | undefined;
  let plannerSystem = "";
  const planner: LlmStructured = async (options) => {
    plannerInput = JSON.parse(options.user) as Readonly<Record<string, unknown>>;
    plannerSystem = options.system ?? "";
    return {
      parsed: {
        disposition: "operational",
        selectedNodeIds: [],
        primaryNodeId: null,
        coordination: null,
        tags: ["intent:operational"],
        questions: [],
        answer: "I can’t control the host process or refresh your browser from this room.",
        rationale: "The follow-up inherits a host-process and browser operation, not a repository mutation.",
        confidence: 0.99,
      },
      raw: "{}",
    } as never;
  };

  const planned = await modelCodingConversationPlanner(planner, "gpt-5.6-luna")({
    conversationId: initial.conversationId,
    messages: [initial, followUp],
    routes: [guidance],
    workspaceNodes: profile.nodes,
    repositoryContext: {
      repositoryName: "theorem",
      currentBranch: "main",
      headCommit: "672b7c5",
      workingTree: "clean",
    },
  });

  assert.equal(planned.disposition, "operational");
  assert.deepEqual(planned.selectedNodeIds, []);
  assert.equal(planned.primaryNodeId, undefined);
  assert.equal(planned.coordination, undefined);
  assert.match(planned.answer ?? "", /can’t control the host process/i);
  assert.match(plannerSystem, /short confirmation such as “do it”/i);
  assert.match(plannerSystem, /tracked repository content/i);
  assert.deepEqual(plannerInput?.runtimeContext, {
    kind: "openai",
    model: "gpt-5.6-luna",
    executionAuthority: {
      repositoryMutation: "route-only",
      hostProcess: "none",
      browserControl: "none",
      currentCheckoutGit: "none",
    },
  });
  assert.deepEqual(codingConversationTranscript([initial, followUp], [guidance]).map((entry) =>
    (entry as { readonly text?: string }).text), [
    initial.text,
    guidance.answer,
    followUp.text,
  ]);
});

test("conversation validation normalizes disposition-owned fields but never invents mutation authority", () => {
  const implementation = profile.nodes.find((node) => node.capabilities.includes("implement"))!;
  const reviewer = profile.nodes.find((node) =>
    node.id !== implementation.id && node.capabilities.includes("review"))!;
  const normalized = validateCodingConversationPlannerResult({
    disposition: "ready",
    selectedNodeIds: [implementation.id, reviewer.id],
    primaryNodeId: implementation.id,
    coordination: { reviewMode: "reviewed", validationScope: "focused" },
    tags: ["intent:change"],
    questions: [],
    answer: "I will start the change.",
    rationale: "The requested change has a clear implementation and review surface.",
    confidence: 0.9,
  }, profile.nodes);
  assert.equal(normalized.answer, undefined);

  const informational = validateCodingConversationPlannerResult({
    disposition: "informational",
    selectedNodeIds: [implementation.id],
    primaryNodeId: implementation.id,
    coordination: { reviewMode: "fast", validationScope: "focused" },
    tags: [],
    questions: ["This must be ignored."],
    answer: "This package coordinates repository work.",
    rationale: "The user asked a read-only question.",
    confidence: 0.9,
  }, profile.nodes);
  assert.deepEqual(informational.selectedNodeIds, []);
  assert.equal(informational.primaryNodeId, undefined);
  assert.equal(informational.coordination, undefined);
  assert.deepEqual(informational.questions, []);

  assert.throws(
    () => validateCodingConversationPlannerResult({
      disposition: "ready",
      selectedNodeIds: [reviewer.id],
      primaryNodeId: reviewer.id,
      coordination: { reviewMode: "fast", validationScope: "focused" },
      tags: [],
      questions: [],
      rationale: "A review-only specialist cannot own this mutation.",
      confidence: 0.8,
    }, profile.nodes),
    /mutation-capable primary node/,
  );
});

test("local conversation routing retries one rejected draft and keeps topology validation authoritative", async () => {
  const implementation = profile.nodes.find((node) => node.capabilities.includes("implement"))!;
  const reviewer = profile.nodes.find((node) =>
    node.id !== implementation.id && node.capabilities.includes("review"))!;
  const envelopes: NodeExecutionEnvelope[] = [];
  const runtimes = new NodeRuntimeRegistry([{
    kind: "codex-cli",
    executeEnvelope: async (envelope) => {
      envelopes.push(envelope);
      const accepted = envelopes.length > 1;
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: {
          disposition: "ready",
          selectedNodeIds: accepted
            ? [implementation.id, reviewer.id]
            : [reviewer.id],
          primaryNodeId: accepted ? implementation.id : reviewer.id,
          coordination: accepted
            ? { reviewMode: "reviewed", validationScope: "focused" }
            : { reviewMode: "fast", validationScope: "focused" },
          tags: ["intent:change"],
          questions: [],
          answer: "Starting now.",
          rationale: "Route the bounded repository mutation.",
          confidence: 0.9,
        },
      };
    },
  }]);
  const message = createCodingConversationMessage({
    conversationId: "coding-retry",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "api" },
    text: "Make the server-down error easier to understand.",
  });
  const planned = await localRuntimeCodingConversationPlanner({
    runtimes,
    execution: () => ({
      schema: "roster.coding-worker-execution.v1",
      runtime: "codex-cli",
      source: "workspace-default",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    }),
  })({
    conversationId: message.conversationId,
    messages: [message],
    workspaceNodes: profile.nodes,
    repositoryRoot: "/repo",
    repositoryContext: {
      repositoryName: "repo",
      currentBranch: "main",
      headCommit: "abc123",
      workingTree: "clean",
    },
  });

  assert.equal(envelopes.length, 2);
  assert.deepEqual(envelopes.map((envelope) => envelope.attempt), [1, 2]);
  assert.match(envelopes[1]?.task.objective ?? "", /mutation-capable primary node/);
  assert.equal(planned.primaryNodeId, implementation.id);
  assert.equal(planned.answer, undefined);
});

test("local conversation routing streams only the answer field from structured model output", async () => {
  const answer = "Hello from Kai. I can trace the repository with you.";
  const deltas: string[] = [];
  const runtimes = new NodeRuntimeRegistry([{
    kind: "pi-agent",
    executeEnvelope: async (_envelope, control) => {
      for (const text of [
        '{"disposition":"informational","selectedNodeIds":[],"primaryNodeId":null,"coordination":null,"tags":[],"questions":[],"answer":"Hello from ',
        'Kai. I can trace the repository with you.","rationale":"Direct answer","confidence":1}',
      ]) control.onModelOutput?.({ kind: "delta", text });
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: {
          disposition: "informational",
          selectedNodeIds: [],
          primaryNodeId: null,
          coordination: null,
          tags: [],
          questions: [],
          answer,
          rationale: "Direct answer",
          confidence: 1,
        },
      };
    },
  }]);
  const message = createCodingConversationMessage({
    conversationId: "coding-local-stream",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Say hello and explain how you can help.",
  });

  const planned = await localRuntimeCodingConversationPlanner({
    runtimes,
    execution: () => ({
      schema: "roster.coding-worker-execution.v1",
      runtime: "pi-agent",
      source: "workspace-default",
      model: "openai-codex/gpt-5.6-luna",
      reasoningEffort: "low",
      pi: {
        provider: "openai-codex",
        model: "openai-codex/gpt-5.6-luna",
        extensionPackages: [],
      },
    }),
  })({
    conversationId: message.conversationId,
    messages: [message],
    workspaceNodes: profile.nodes,
    repositoryRoot: "/repo",
    repositoryContext: {
      repositoryName: "repo",
      currentBranch: "main",
      headCommit: "abc123",
      workingTree: "clean",
    },
    onDelta: (delta) => { deltas.push(delta); },
  });

  assert.equal(planned.answer, answer);
  assert.equal(deltas.join(""), answer);
  assert.ok(deltas.length > 1);
});

test("local conversation routing does not present an actionable draft answer as chat", async () => {
  const implementation = profile.nodes.find((node) => node.capabilities.includes("implement"))!;
  const deltas: string[] = [];
  const output = {
    disposition: "ready" as const,
    selectedNodeIds: [implementation.id],
    primaryNodeId: implementation.id,
    coordination: { reviewMode: "fast" as const, validationScope: "focused" as const },
    tags: ["intent:change"],
    questions: [],
    answer: "This draft must not become a room answer.",
    rationale: "Start the bounded change.",
    confidence: 1,
  };
  const runtimes = new NodeRuntimeRegistry([{
    kind: "pi-agent",
    executeEnvelope: async (_envelope, control) => {
      control.onModelOutput?.({ kind: "delta", text: JSON.stringify(output) });
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output,
      };
    },
  }]);
  const message = createCodingConversationMessage({
    conversationId: "coding-local-actionable-stream",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Make the status copy clearer.",
  });

  const planned = await localRuntimeCodingConversationPlanner({
    runtimes,
    execution: () => ({
      schema: "roster.coding-worker-execution.v1",
      runtime: "pi-agent",
      source: "workspace-default",
      model: "openai-codex/gpt-5.6-luna",
      reasoningEffort: "low",
      pi: {
        provider: "openai-codex",
        model: "openai-codex/gpt-5.6-luna",
        extensionPackages: [],
      },
    }),
  })({
    conversationId: message.conversationId,
    messages: [message],
    workspaceNodes: profile.nodes,
    repositoryRoot: "/repo",
    repositoryContext: {
      repositoryName: "repo",
      currentBranch: "main",
      headCommit: "abc123",
      workingTree: "clean",
    },
    onDelta: (delta) => { deltas.push(delta); },
  });

  assert.equal(planned.disposition, "ready");
  assert.deepEqual(deltas, []);
});

test("local conversation routing does not repeat a terminal provider failure", async () => {
  let attempts = 0;
  const runtimes = new NodeRuntimeRegistry([{
    kind: "pi-agent",
    executeEnvelope: async () => {
      attempts += 1;
      throw new Error("429 You exceeded your current quota and billing limit.");
    },
  }]);
  const message = createCodingConversationMessage({
    conversationId: "coding-provider-unavailable",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "api" },
    text: "Make the connection error clearer.",
  });
  await assert.rejects(
    () => localRuntimeCodingConversationPlanner({
      runtimes,
      execution: () => ({
        schema: "roster.coding-worker-execution.v1",
        runtime: "pi-agent",
        source: "workspace-default",
        model: "openai-codex/gpt-5.6-luna",
        reasoningEffort: "low",
        pi: {
          provider: "openai-codex",
          model: "openai-codex/gpt-5.6-luna",
          extensionPackages: [],
        },
      }),
    })({
      conversationId: message.conversationId,
      messages: [message],
      workspaceNodes: profile.nodes,
      repositoryRoot: "/repo",
      repositoryContext: {
        repositoryName: "repo",
        currentBranch: "main",
        headCommit: "abc123",
        workingTree: "clean",
      },
    }),
    (error: unknown) => error instanceof CodingConversationRuntimeUnavailableError
      && error.failureClass === "budget",
  );
  assert.equal(attempts, 1);
});

test("escalated routing expands the saved specialist dependency DAG", () => {
  const nodes = profile.nodes.map((node) => node.id === "workspace.api"
    ? { ...node, metadata: { ...(node.metadata ?? {}), dependsOnNodeIds: ["workspace.data"] } }
    : node);
  const planned = validateCodingConversationPlannerResult({
    disposition: "escalated",
    selectedNodeIds: ["workspace.implementation", "workspace.api"],
    primaryNodeId: "workspace.implementation",
    coordination: { reviewMode: "reviewed", validationScope: "repository-wide" },
    tags: ["domain:api"],
    questions: [],
    rationale: "The API specialist owns the change.",
    confidence: 0.9,
  }, nodes);

  assert.equal(planned.primaryNodeId, "workspace.implementation");
  assert.ok(planned.selectedNodeIds.includes("workspace.data"));
  assert.ok(planned.selectedNodeIds.includes("workspace.api"));
});

test("ready routing keeps a narrow selected surface from inheriting transitive specialist dependencies", () => {
  const nodes = [
    {
      id: "workspace.implementation",
      name: "Kai",
      capabilities: ["implement"],
      metadata: { role: "worker", specialty: "implementation", dependsOnNodeIds: [] },
    },
    {
      id: "workspace.api",
      name: "Theo",
      capabilities: ["review"],
      metadata: { role: "supervisor", specialty: "api", dependsOnNodeIds: ["workspace.data", "workspace.runtime"] },
    },
    {
      id: "workspace.ui",
      name: "Sora",
      capabilities: ["review"],
      metadata: { role: "supervisor", specialty: "ui", dependsOnNodeIds: ["workspace.api"] },
    },
    {
      id: "workspace.data",
      name: "Iris",
      capabilities: ["review"],
      metadata: { role: "supervisor", specialty: "data", dependsOnNodeIds: [] },
    },
    {
      id: "workspace.runtime",
      name: "Owen",
      capabilities: ["review"],
      metadata: { role: "supervisor", specialty: "runtime", dependsOnNodeIds: ["workspace.data"] },
    },
  ];
  const planned = validateCodingConversationPlannerResult({
    disposition: "ready",
    selectedNodeIds: ["workspace.implementation", "workspace.ui"],
    primaryNodeId: "workspace.implementation",
    coordination: { reviewMode: "reviewed", validationScope: "focused" },
    tags: ["domain:ui", "intent:bugfix"],
    questions: [],
    rationale: "The implementation and UI peers cover this focused state fix.",
    confidence: 0.97,
  }, nodes);

  assert.deepEqual(planned.selectedNodeIds, ["workspace.implementation", "workspace.ui"]);
});

test("explicit person-name mentions steer the validated model graph", async () => {
  const message = createCodingConversationMessage({
    conversationId: "coding-mention",
    author: { kind: "user", id: "operator", name: "You" },
    source: { kind: "ui" },
    text: "@nia please make the contributor guide clear",
    createdAt: 10,
  });
  assert.deepEqual(message.mentions, ["nia"]);

  const llmStructured: LlmStructured = async () => ({
    parsed: {
      disposition: "ready",
      selectedNodeIds: ["workspace.implementation", "workspace.documentation"],
      primaryNodeId: "workspace.implementation",
      coordination: { reviewMode: "reviewed", validationScope: "focused" },
      tags: ["domain:documentation"],
      questions: [],
      answer: null,
      rationale: "The change is actionable.",
      confidence: 0.9,
    },
    raw: "{}",
  } as never);
  const input = {
    conversationId: message.conversationId,
    messages: [message],
    workspaceNodes: profile.nodes,
    repositoryContext: {
      repositoryName: "repo",
      currentBranch: "main",
      headCommit: "abc123",
      workingTree: "clean" as const,
    },
  };
  const modelPlanned = await modelCodingConversationPlanner(llmStructured)(input);

  assert.deepEqual(modelPlanned.selectedNodeIds, ["workspace.documentation", "workspace.implementation"]);
  assert.ok(modelPlanned.selectedNodeIds.some((nodeId) =>
    nodeId !== modelPlanned.primaryNodeId
    && profile.nodes.find((node) => node.id === nodeId)?.capabilities.includes("review")),
  "routing should add an independent review-capable peer without hardcoding a quality identity");
});

test("model routing answers read-only repository questions without selecting mutation agents", async () => {
  let plannerInput: Readonly<Record<string, unknown>> | undefined;
  let plannerSystem = "";
  let plannerModel = "";
  const llmStructured: LlmStructured = async (input) => {
    plannerSystem = input.system ?? "";
    plannerModel = input.model ?? "";
    plannerInput = JSON.parse(input.user) as Readonly<Record<string, unknown>>;
    return {
      parsed: {
        disposition: "informational",
        selectedNodeIds: [],
        primaryNodeId: null,
        coordination: null,
        tags: ["intent:question"],
        questions: [],
        answer: "You are on `codex/coding-run-branches`.",
        rationale: "The current branch is present in read-only repository context.",
        confidence: 0.99,
      },
      raw: "{}",
    } as never;
  };
  const message = createCodingConversationMessage({
    conversationId: "coding-information",
    author: { kind: "user", id: "operator", name: "You" },
    source: { kind: "ui" },
    text: "what branch are you on",
    createdAt: 10,
  });
  const planned = await modelCodingConversationPlanner(llmStructured, "gpt-5.6-luna")({
    conversationId: message.conversationId,
    messages: [message],
    workspaceNodes: profile.nodes,
    repositoryContext: {
      repositoryName: "theorem",
      currentBranch: "codex/coding-run-branches",
      headCommit: "abc123",
      workingTree: "clean",
    },
  });

  assert.equal(planned.disposition, "informational");
  assert.equal(plannerModel, "gpt-5.6-luna");
  assert.equal(planned.answer, "You are on `codex/coding-run-branches`.");
  assert.deepEqual(planned.selectedNodeIds, []);
  assert.equal(planned.primaryNodeId, undefined);
  assert.deepEqual(plannerInput?.repositoryContext, {
    repositoryName: "theorem",
    currentBranch: "codex/coding-run-branches",
    headCommit: "abc123",
    workingTree: "clean",
  });
  assert.match(plannerSystem, /ordinary conversation and questions fully answered/);
  assert.match(plannerSystem, /repository mutation/);
});

test("model routing launches evidence-backed repository investigations instead of guessing", async () => {
  let plannerSystem = "";
  const primary = profile.nodes.find((node) => node.capabilities.includes("implement"));
  const reviewer = profile.nodes.find((node) => node.capabilities.includes("review"));
  assert.ok(primary);
  assert.ok(reviewer);
  const llmStructured: LlmStructured = async (input) => {
    plannerSystem = input.system ?? "";
    return {
      parsed: {
        disposition: "investigating",
        selectedNodeIds: [primary.id, reviewer.id],
        primaryNodeId: primary.id,
        coordination: { reviewMode: "reviewed", validationScope: "focused" },
        tags: ["intent:architecture"],
        questions: [],
        answer: null,
        rationale: "The answer requires opening implementation and test files.",
        confidence: 0.98,
      },
      raw: "{}",
    } as never;
  };
  const message = createCodingConversationMessage({
    conversationId: "coding-investigation",
    author: { kind: "user", id: "operator", name: "You" },
    source: { kind: "ui" },
    text: "Explain the detailed architecture and trace how billing works in this repository",
    createdAt: 10,
  });
  const planned = await modelCodingConversationPlanner(llmStructured)({
    conversationId: message.conversationId,
    messages: [message],
    workspaceNodes: profile.nodes,
    repositoryContext: {
      repositoryName: "theorem",
      currentBranch: "main",
      headCommit: "abc123",
      workingTree: "clean",
    },
  });

  assert.equal(planned.disposition, "investigating");
  assert.equal(planned.primaryNodeId, primary.id);
  assert.deepEqual(planned.selectedNodeIds, [primary.id, reviewer.id]);
  assert.equal(planned.answer, undefined);
  assert.match(plannerSystem, /opening files, searching code, tracing behavior/);
  assert.match(plannerSystem, /Prefer starting a\s+bounded investigation/);
});

test("local conversation runtime receives the durable question, prior Roster answer, and correction", async () => {
  const question = createCodingConversationMessage({
    conversationId: "coding-context",
    author: { kind: "user", id: "operator", name: "You" },
    source: { kind: "ui" },
    text: "who built you",
    createdAt: 10,
  });
  const priorAnswer = createCodingConversationRoute({
    conversationId: question.conversationId,
    inReplyTo: question.messageId,
    disposition: "informational",
    selectedNodeIds: [],
    tags: [],
    questions: [],
    answer: "An earlier answer that the user rejected.",
    rationale: "Answered the product question.",
    confidence: 0.8,
    createdAt: 11,
  });
  const image = createCodingConversationImage({
    conversationId: question.conversationId,
    name: "correction.png",
    mediaType: "image/png",
    dataUrl: "data:image/png;base64,cG5n",
    createdAt: 12,
  });
  const correction = createCodingConversationMessage({
    conversationId: question.conversationId,
    author: { kind: "user", id: "operator", name: "You" },
    source: { kind: "ui" },
    text: "wrong answer",
    attachments: [image],
    replyTo: priorAnswer.routeId,
    createdAt: 13,
  });
  let envelope: NodeExecutionEnvelope | undefined;
  const runtimes = new NodeRuntimeRegistry([{
    kind: "codex-cli",
    executeEnvelope: async (candidate) => {
      envelope = candidate;
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: {
          disposition: "informational",
          selectedNodeIds: [],
          primaryNodeId: null,
          coordination: null,
          tags: ["intent:correction"],
          questions: [],
          answer: "You’re right. Roster was created by [@shimikeri](https://x.com/shimikeri).",
          rationale: "Resolved the correction from the chronological room transcript.",
          confidence: 0.97,
        },
      };
    },
  }]);
  const planner = localRuntimeCodingConversationPlanner({
    runtimes,
    execution: () => ({
      schema: "roster.coding-worker-execution.v1",
      runtime: "codex-cli",
      source: "workspace-default",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    }),
  });

  const planned = await planner({
    conversationId: question.conversationId,
    messages: [question, correction],
    images: [image],
    routes: [priorAnswer],
    workspaceNodes: profile.nodes,
    repositoryRoot: "/repo",
    repositoryContext: {
      repositoryName: "repo",
      currentBranch: "main",
      headCommit: "abc123",
      workingTree: "clean",
    },
    productContext: {
      name: "Roster",
      category: "multi-agent coordination workspace",
      description: "People and agents coordinate work in one shared room.",
      creator: {
        label: "@shimikeri",
        url: "https://x.com/shimikeri",
      },
    },
  });

  const runtimeInput = envelope?.input as Readonly<Record<string, unknown>> | undefined;
  const transcript = runtimeInput?.transcript as ReadonlyArray<Readonly<Record<string, unknown>>> | undefined;
  assert.equal(envelope?.runtime.kind, "codex-cli");
  assert.equal(envelope?.runtime.metadata?.sandbox, "read-only");
  assert.equal(envelope?.surface.skills.length, 1);
  assert.equal(envelope?.surface.skills[0]?.id, "roster-coordination");
  assert.ok(envelope?.surface.skills[0]?.contentHash);
  assert.deepEqual(envelope?.attachments?.map((attachment) => ({
    attachmentId: attachment.attachmentId,
    name: attachment.name,
    mediaType: attachment.mediaType,
    byteLength: attachment.byteLength,
  })), [{
    attachmentId: image.artifactId,
    name: "correction.png",
    mediaType: "image/png",
    byteLength: 3,
  }]);
  assert.ok(envelope?.attachments?.[0]?.contentHash);
  assert.match(
    envelope?.surface.skills[0]?.instructions ?? "",
    /validates the proposal and retains all orchestration authority/,
  );
  assert.deepEqual(transcript?.map((entry) => entry.text), [
    "who built you",
    "An earlier answer that the user rejected.",
    "wrong answer",
  ]);
  assert.deepEqual(runtimeInput?.productContext, {
    name: "Roster",
    category: "multi-agent coordination workspace",
    description: "People and agents coordinate work in one shared room.",
    creator: {
      label: "@shimikeri",
      url: "https://x.com/shimikeri",
    },
  });
  assert.match(planned.answer ?? "", /https:\/\/x\.com\/shimikeri/);
  assert.deepEqual(planned.selectedNodeIds, []);
});

test("local conversation runtime binds an explicit saved responder for a peer reply", async () => {
  const responder = profile.nodes.find((node) => node.metadata?.givenName === "Kai");
  assert.ok(responder);
  const handoff = createCodingConversationMessage({
    conversationId: "coding-local-peer-reply",
    author: { kind: "agent", id: "workspace.quality", name: "Mira, Quality Reviewer" },
    source: { kind: "agent" },
    text: "@Kai, please introduce yourself to @You.",
    createdAt: 20,
  });
  let envelope: NodeExecutionEnvelope | undefined;
  const planner = localRuntimeCodingConversationPlanner({
    runtimes: new NodeRuntimeRegistry([{
      kind: "codex-cli",
      executeEnvelope: async (candidate) => {
        envelope = candidate;
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: {
            disposition: "informational",
            selectedNodeIds: [],
            primaryNodeId: null,
            coordination: null,
            tags: ["intent:social"],
            questions: [],
            answer: "Hi! I’m Kai, and I handle implementation.",
            rationale: "Kai answered Mira's handoff.",
            confidence: 1,
          },
        };
      },
    }]),
    execution: () => ({
      schema: "roster.coding-worker-execution.v1",
      runtime: "codex-cli",
      source: "workspace-default",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
    }),
  });

  await planner({
    conversationId: handoff.conversationId,
    messages: [handoff],
    workspaceNodes: profile.nodes,
    responder,
    repositoryRoot: "/repo",
    repositoryContext: {
      repositoryName: "repo",
      currentBranch: "main",
      headCommit: "abc123",
      workingTree: "clean",
    },
  });

  const runtimeInput = envelope?.input as Readonly<Record<string, unknown>> | undefined;
  assert.deepEqual(runtimeInput?.responder, {
    nodeId: responder.id,
    name: "Kai",
    role: "Implementation Engineer",
    instruction: "Write the informational answer as this participant. Reply to the latest speaker; do not ask this participant to answer and do not tag this participant.",
  });
  assert.match(envelope?.task.objective ?? "", /first-person voice to the latest speaker/i);
  assert.match(envelope?.task.objective ?? "", /Do not describe, tag, or ask Kai, Implementation Engineer to respond/i);
});

test("regular workspace chat streams a direct answer without mutation boilerplate", async () => {
  const message = createCodingConversationMessage({
    conversationId: "coding-team-question",
    author: { kind: "user", id: "operator", name: "You" },
    source: { kind: "ui" },
    text: "who is the best among all of you",
    createdAt: 10,
  });
  const deltas: string[] = [];
  let prompt = "";
  let requestedModel = "";
  let answerInput: Readonly<Record<string, unknown>> | undefined;
  const answerer = modelCodingConversationAnswerer(async (options) => {
    prompt = options.system ?? "";
    requestedModel = options.model ?? "";
    answerInput = JSON.parse(options.user) as Readonly<Record<string, unknown>>;
    await options.onDelta?.("There is no single best specialist. ");
    await options.onDelta?.("Kai implements; Mira reviews quality.");
    return "There is no single best specialist. Kai implements; Mira reviews quality.";
  }, "gpt-5.6-luna");
  const answer = await answerer({
    messages: [message],
    workspaceNodes: profile.nodes,
    repositoryContext: {
      repositoryName: "repo",
      currentBranch: "main",
      headCommit: "abc123",
      workingTree: "clean",
    },
    productContext: {
      name: "Roster",
      category: "multi-agent coordination workspace",
      description: "People and agents coordinate work in one shared room.",
      creator: {
        label: "@shimikeri",
        url: "https://x.com/shimikeri",
      },
    },
    onDelta: (delta) => { deltas.push(delta); },
  });

  assert.equal(answer, deltas.join(""));
  assert.equal(requestedModel, "gpt-5.6-luna");
  assert.match(answer, /no single best specialist/i);
  assert.match(prompt, /Do not say you need more detail before creating a branch/i);
  assert.doesNotMatch(prompt, /who built|who created|shimikeri/i);
  assert.deepEqual(answerInput?.productContext, {
    name: "Roster",
    category: "multi-agent coordination workspace",
    description: "People and agents coordinate work in one shared room.",
    creator: {
      label: "@shimikeri",
      url: "https://x.com/shimikeri",
    },
  });
  assert.deepEqual(answerInput?.runtimeContext, {
    kind: "openai",
    model: "gpt-5.6-luna",
    responsibility: "conversation planning and answers",
    executionAuthority: {
      repositoryMutation: "route-only",
      hostProcess: "none",
      browserControl: "none",
      currentCheckoutGit: "none",
    },
  });
  assert.match(prompt, /not an agent or teammate/i);
  assert.match(prompt, /Roster's own coordination behavior/i);
  assert.match(prompt, /conversational host of an ongoing repository team room/i);
  assert.match(prompt, /Sound like an experienced collaborator/i);
  assert.match(prompt, /Prefer one cohesive paragraph/i);
  assert.match(prompt, /Default to two to five natural sentences/i);
  assert.match(prompt, /seven-step tour/i);
  assert.match(prompt, /earlier answer was abstract, confusing, stiff/i);
  assert.doesNotMatch(prompt, /concise system voice/i);
  assert.match(prompt, /ground it in the actual saved agents/i);
});

test("a directly mentioned saved node answers as itself without treating its mention as the user", async () => {
  const responder = profile.nodes.find((node) => node.metadata?.givenName === "Mira");
  assert.ok(responder);
  const message = createCodingConversationMessage({
    conversationId: "coding-direct-mention",
    author: { kind: "user", id: "operator", name: "You" },
    source: { kind: "ui" },
    text: "@mira say hello",
    createdAt: 10,
  });
  let prompt = "";
  let runtimeContext: Readonly<Record<string, unknown>> | undefined;
  let transcript: ReadonlyArray<Readonly<Record<string, unknown>>> | undefined;
  const deltas: string[] = [];
  const answerer = modelCodingConversationAnswerer(async (options) => {
    prompt = options.system ?? "";
    const input = JSON.parse(options.user) as Readonly<Record<string, unknown>>;
    runtimeContext = input.runtimeContext as Readonly<Record<string, unknown>>;
    transcript = input.transcript as ReadonlyArray<Readonly<Record<string, unknown>>>;
    assert.equal(options.onDelta, undefined, "direct replies buffer model deltas until identity is sanitized");
    return "Hello, Mira! How can I help?";
  }, "gpt-5.6-luna");

  const answer = await answerer({
    messages: [message],
    workspaceNodes: profile.nodes,
    responder,
    repositoryContext: {
      repositoryName: "repo",
      currentBranch: "main",
      headCommit: "abc123",
      workingTree: "clean",
    },
    onDelta: (delta) => { deltas.push(delta); },
  });

  assert.equal(answer, "Hello! How can I help?");
  assert.deepEqual(deltas, ["Hello! How can I help?"]);
  assert.match(prompt, /You are Mira/i);
  assert.match(prompt, /latest @mention addresses you/i);
  assert.match(prompt, /not automatically the human's name/i);
  assert.match(prompt, /exact @GivenName/i);
  assert.match(prompt, /one bounded conversational handoff/i);
  assert.match(prompt, /Do not speak as Roster/i);
  assert.match(prompt, /do not recite your role or reintroduce yourself/i);
  assert.match(prompt, /Continue the ongoing exchange/i);
  assert.doesNotMatch(prompt, /You speak as Roster's concise system voice/i);
  assert.equal(transcript?.at(-1)?.text, "say hello");
  assert.deepEqual(runtimeContext, {
    kind: "openai",
    model: "gpt-5.6-luna",
    responsibility: `direct reply as saved workspace node ${responder.id}`,
    executionAuthority: {
      repositoryMutation: "route-only",
      hostProcess: "none",
      browserControl: "none",
      currentCheckoutGit: "none",
    },
  });
});

test("an agent-authored mention gives the next teammate one bounded conversational turn", async () => {
  const responder = profile.nodes.find((node) => node.metadata?.givenName === "Kai");
  assert.ok(responder);
  const handoff = createCodingConversationMessage({
    conversationId: "coding-peer-mention",
    author: { kind: "agent", id: "workspace.quality", name: "Mira, Quality Reviewer" },
    source: { kind: "agent" },
    text: "@Kai, please introduce yourself to @You.",
    replyTo: "coding_message_human_request",
    createdAt: 12,
  });
  let prompt = "";
  let latestText = "";
  const answerer = modelCodingConversationAnswerer(async (options) => {
    prompt = options.system ?? "";
    const context = JSON.parse(options.user) as {
      readonly transcript: ReadonlyArray<{ readonly text: string }>;
    };
    latestText = context.transcript.at(-1)?.text ?? "";
    return "Hi! I’m Kai, and I handle implementation.";
  }, "gpt-5.6-luna");

  const answer = await answerer({
    messages: [handoff],
    workspaceNodes: profile.nodes,
    responder,
    repositoryContext: {
      repositoryName: "repo",
      currentBranch: "main",
      headCommit: "abc123",
      workingTree: "clean",
    },
  });

  assert.equal(answer, "Hi! I’m Kai, and I handle implementation.");
  assert.equal(latestText, "please introduce yourself to");
  assert.match(prompt, /Reply in the room to Mira, Quality Reviewer's request/i);
  assert.match(prompt, /address the human directly/i);
});

test("a durable node-authored reply replaces its coordinator route in model transcript", () => {
  const input = createCodingConversationMessage({
    conversationId: "coding-direct-transcript",
    author: { kind: "user", id: "operator", name: "You" },
    source: { kind: "ui" },
    text: "@mira say hello",
    createdAt: 10,
  });
  const route = createCodingConversationRoute({
    conversationId: input.conversationId,
    inReplyTo: input.messageId,
    disposition: "informational",
    selectedNodeIds: [],
    answer: "Hello!",
    rationale: "A read-only direct reply.",
    confidence: 1,
    createdAt: 11,
  });
  const reply = createCodingConversationMessage({
    conversationId: input.conversationId,
    author: { kind: "agent", id: "workspace.quality", name: "Mira, Quality Reviewer" },
    source: { kind: "agent" },
    text: "Hello!",
    tags: ["intent:informational", "routing:direct-mention"],
    replyTo: input.messageId,
    createdAt: 12,
  });

  const transcript = codingConversationTranscript([input, reply], [route]);
  assert.deepEqual(transcript.map((entry) =>
    (entry as Readonly<Record<string, unknown>>).kind), ["message", "message"]);
  assert.deepEqual(transcript.map((entry) =>
    (entry as Readonly<Record<string, unknown>>).text), ["@mira say hello", "Hello!"]);
  assert.equal(
    ((transcript[1] as Readonly<Record<string, unknown>>).author as Readonly<Record<string, unknown>>).name,
    "Mira, Quality Reviewer",
  );
});

test("clarification conversation replays exactly and composes user answers without a job", () => {
  const questionInput = createCodingConversationMessage({
    conversationId: "coding-clarify",
    author: { kind: "user", id: "operator", name: "You" },
    source: { kind: "ui" },
    text: "Change the deployment behavior",
    createdAt: 10,
  });
  const route = createCodingConversationRoute({
    conversationId: questionInput.conversationId,
    inReplyTo: questionInput.messageId,
    disposition: "needs_clarification",
    selectedNodeIds: [CODING_HUMAN_NODE_ID],
    tags: ["intent:clarification", "domain:runtime"],
    questions: ["Which deployment environment should change?"],
    rationale: "The target environment changes the implementation and authority boundary.",
    confidence: 0.84,
    createdAt: 11,
  });
  const answer = createCodingConversationMessage({
    conversationId: questionInput.conversationId,
    author: { kind: "user", id: "operator", name: "You" },
    source: { kind: "ui" },
    text: "Only staging; production must remain unchanged.",
    replyTo: route.routeId,
    createdAt: 12,
  });
  const replayed = codingConversationFromEvents([
    codingConversationMessageEvent(answer),
    codingConversationRouteEvent(route),
    codingConversationMessageEvent(questionInput),
  ]);

  assert.deepEqual(replayed.messages.map((message) => message.messageId), [questionInput.messageId, answer.messageId]);
  assert.equal(replayed.routes[0]?.disposition, "needs_clarification");
  assert.deepEqual(replayed.routes[0]?.questions, ["Which deployment environment should change?"]);
  assert.match(codingConversationObjective(replayed.messages), /Follow-up 1: Only staging/);
});

test("human is a routable participant but never an executable primary", () => {
  const nodes = [codingHumanWorkspaceNode(), ...profile.nodes];
  const clarification = validateCodingConversationPlannerResult({
    disposition: "needs_clarification",
    selectedNodeIds: [CODING_HUMAN_NODE_ID],
    tags: ["intent:clarification"],
    questions: ["Which product behavior should win?"],
    rationale: "The team needs a human product decision.",
    confidence: 0.9,
  }, nodes);
  assert.deepEqual(clarification.selectedNodeIds, [CODING_HUMAN_NODE_ID]);

  assert.throws(() => validateCodingConversationPlannerResult({
    disposition: "ready",
    selectedNodeIds: [CODING_HUMAN_NODE_ID, "workspace.data"],
    primaryNodeId: CODING_HUMAN_NODE_ID,
    coordination: { reviewMode: "reviewed", validationScope: "focused" },
    tags: ["domain:data"],
    questions: [],
    rationale: "The human supplied intent, but an agent must execute.",
    confidence: 0.9,
  }, nodes), /explicit saved non-human primary node/);
});
