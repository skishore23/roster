import assert from "node:assert/strict";
import test from "node:test";

import type { DomainPack } from "../../src/engine/orchestration/types.ts";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  createDynamicTaskDefinition,
} from "../../src/engine/orchestration/task-graph.ts";
import {
  inlineArtifactPublishedEvent,
  initialOrchestrationState,
  orchestrationConfiguredEvent,
  reduceOrchestration,
  taskGraphProjectedEvent,
} from "../../src/modules/orchestration.ts";
import { orchestrationConversationHtml } from "../../src/views/room-conversation.ts";

const pack: DomainPack = {
  id: "conversation-test",
  version: "1",
  policyVersion: "conversation-test-v1",
  coordinatorId: "roster",
  capabilities: [
    { id: "facilitate", description: "Facilitate the room." },
    { id: "research", description: "Research the shared question." },
  ],
  nodes: [
    {
      id: "roster",
      name: "Roster",
      capabilities: ["facilitate"],
      runtime: { kind: "roster-native", profile: "room.facilitator" },
    },
    {
      id: "researcher",
      name: "Mira",
      capabilities: ["research"],
      runtime: { kind: "roster-native", profile: "room.researcher" },
      metadata: { role: "evidence researcher" },
    },
  ],
  limits: { maxNodes: 4, maxTasks: 8, maxParallel: 2, maxDepth: 2 },
};

test("room conversation projects meaningful human-agent turns instead of a task dashboard", () => {
  const configured = orchestrationConfiguredEvent("conversation-run", pack);
  const graph = taskGraphProjectedEvent("conversation-run", {
    runId: "conversation-run",
    policy: {
      maxTasks: 8,
      maxDepth: 2,
      maxFanout: 4,
      maxInflight: 2,
      maxReady: 8,
      maxBlocked: 8,
      maxAttempts: 2,
      maxContextBytes: 1_000_000,
      maxCostMicros: 1_000_000,
      maxTokens: 100_000,
      maxWallTimeMs: 60_000,
    },
    tasks: [{
      definition: createDynamicTaskDefinition({
        taskId: "research",
        semanticKey: "conversation:research",
        nodeId: "researcher",
        capability: "research",
        objective: "Research the shared question.",
        handler: { kind: "roster.node", version: "1" },
        acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
        result: { mode: "json", outputKey: "research_finding", schema: true },
        dependencies: [],
        join: { kind: "all-success" },
        inputs: {
          inputVersions: {},
          dataReferences: [],
          frontierVersion: "conversation-frontier",
          topologyVersion: "conversation-topology",
          catalogVersion: "conversation-catalog",
        },
        runtimeBindingEpoch: 0,
        retry: { maxAttempts: 2, initialBackoffMs: 1, maximumBackoffMs: 10 },
        timeoutMs: 60_000,
        sideEffect: "pure",
        estimatedCostMicros: 0,
      }),
      status: "accepted",
      attempt: 1,
      leaseFence: 1,
    }],
    expansions: [],
    outcomeDataReferences: [],
    acceptedCostMicros: 0,
    acceptedTokens: 0,
  });
  const artifact = inlineArtifactPublishedEvent({
    runId: "conversation-run",
    artifactId: "artifact-finding",
    origin: "task",
    outputKey: "research_finding",
    taskId: "research",
    nodeId: "researcher",
    kind: "finding",
    inputVersions: {},
  }, JSON.stringify({ summary: "The repository already exposes a safe adapter boundary." }));
  let state = reduceOrchestration(initialOrchestrationState, configured, 10);
  state = reduceOrchestration(state, graph, 12);
  state = reduceOrchestration(state, artifact, 20);

  const html = orchestrationConversationHtml({
    state,
    objective: "Can we attach Hermes without changing the workflow?",
    humanRole: "Builder",
    receipts: [
      { ts: 10, body: configured },
      { ts: 12, body: graph },
      { ts: 20, body: artifact },
    ],
  });

  assert.match(html, /aria-label="Room conversation"/);
  assert.match(html, /<strong>You<\/strong><span>Builder<\/span>/);
  assert.match(html, /Can we attach Hermes without changing the workflow\?/);
  assert.match(html, /<strong>Roster<\/strong><span>Facilitator<\/span>/);
  assert.match(html, /I brought Mira into the room/);
  assert.match(html, /<strong>Mira<\/strong><span>Evidence Researcher<\/span>/);
  assert.match(html, /I added Research Finding to the shared work/);
  assert.match(html, /safe adapter boundary/);
  assert.doesNotMatch(html, /task dashboard|conversation-test-v1/);
});

test("room conversation escapes untrusted contributions", () => {
  const html = orchestrationConversationHtml({
    state: initialOrchestrationState,
    receipts: [],
    objective: "<script>alert('room')</script>",
  });

  assert.match(html, /&lt;script&gt;alert\(&#39;room&#39;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
