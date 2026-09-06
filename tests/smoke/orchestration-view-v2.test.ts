import assert from "node:assert/strict";
import test from "node:test";

import type { DomainPack } from "../../src/engine/orchestration/types.ts";
import {
  initialOrchestrationState,
  orchestrationConfiguredEvent,
  reduceOrchestration,
  type OrchestrationEvent,
} from "../../src/modules/orchestration.ts";
import { orchestrationBoardHtml } from "../../src/views/orchestration.ts";

const pack: DomainPack = {
  id: "view-v2",
  version: "2",
  policyVersion: "view-v2",
  coordinatorId: "coordinator",
  capabilities: [
    { id: "coordinate", description: "Coordinate the room." },
    { id: "review", description: "Review the shared result." },
  ],
  nodes: [{
    id: "coordinator",
    name: "Roster",
    capabilities: ["coordinate"],
    runtime: { kind: "roster-native", profile: "view.coordinator" },
  }],
  limits: { maxNodes: 3, maxTasks: 4, maxParallel: 2, maxDepth: 2 },
};

test("orchestration board projects only the v2 node receipt vocabulary", () => {
  const configured = orchestrationConfiguredEvent("view-run", pack);
  const spawned: OrchestrationEvent = {
    type: "node.spawned",
    runId: "view-run",
    node: {
      id: "reviewer",
      name: "Mira",
      capabilities: ["review"],
      parentId: "coordinator",
      runtime: { kind: "roster-native", profile: "view.reviewer" },
    },
    reason: "independent review",
  };
  let state = reduceOrchestration(initialOrchestrationState, configured, 1);
  state = reduceOrchestration(state, spawned, 2);

  const html = orchestrationBoardHtml(state, {
    receipts: [
      { ts: 1, body: configured },
      { ts: 2, body: spawned },
    ],
  });

  assert.match(html, /1 member configured for view-v2/);
  assert.match(html, /node\.spawned/);
  assert.match(html, /Mira joined/);
  assert.match(html, />Members<\/dt>/);
  assert.doesNotMatch(html, /agent\.spawned|Agent hierarchy/);
});
