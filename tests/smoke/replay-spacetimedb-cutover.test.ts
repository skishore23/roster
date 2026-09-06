import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { StreamReceiptProjection } from "../../src/spacetimedb-bindings/types.js";
import {
  buildReplayTimeline,
  hasLinkedProjection,
  parseReplayBootConfig,
} from "../../src/browser/replay-client.js";

const ROOT = process.cwd();
const source = (name: string): Promise<string> => fs.readFile(path.join(ROOT, name), "utf8");

const row = (input: {
  readonly seq: bigint;
  readonly prevHash: string;
  readonly hash: string;
  readonly body: Readonly<Record<string, unknown>>;
}): StreamReceiptProjection => ({
  id: `stream:${input.seq.toString()}`,
  workspaceId: "roster/test",
  streamId: "agents/test",
  seq: input.seq,
  receiptId: `receipt-${input.seq.toString()}`,
  occurredAtMs: input.seq,
  prevHash: input.prevHash,
  hash: input.hash,
  bodyJson: JSON.stringify(input.body),
  hintsJson: "{}",
  createdAt: { microsSinceUnixEpoch: input.seq * 1_000n },
} as unknown as StreamReceiptProjection);

test("Replay browser validates boot config and folds exact sequence projections", () => {
  const boot = parseReplayBootConfig(JSON.stringify({
    domain: "replay",
    stream: "agents/test",
    workspaceId: "roster/test",
    capabilitySecret: "short-lived-secret",
    realtime: {
      enabled: true,
      uri: "http://127.0.0.1:3000",
      database: "roster-test",
      confirmedReads: true,
    },
  }));
  assert.equal(boot.domain, "replay");
  assert.equal(boot.workspaceId, "roster/test");

  const rows = [
    row({ seq: 1n, prevHash: "", hash: "a".repeat(64), body: { type: "task.graph.projected", agentId: "platform" } }),
    row({ seq: 2n, prevHash: "a".repeat(64), hash: "b".repeat(64), body: { type: "task.graph.projected", agentId: "platform" } }),
  ];
  assert.equal(hasLinkedProjection(rows), true);
  assert.equal(hasLinkedProjection([{ ...rows[1]!, seq: 3n }]), false);
  assert.deepEqual(buildReplayTimeline(rows, 3), [
    { label: "task/platform", count: 2 },
  ]);
});

test("Replay production surface is direct SpacetimeDB with no file, HTMX, SSE, or polling authority", async () => {
  const [route, view, browser, worker, module, streamNames, server, packageJson] = await Promise.all([
    source("src/agents/inspector.agent.ts"),
    source("src/views/receipt.ts"),
    source("src/browser/replay-client.ts"),
    source("src/agents/inspector.ts"),
    source("src/modules/inspector.ts"),
    source("src/agents/inspector.streams.ts"),
    source("src/server.ts"),
    source("package.json"),
  ]);

  for (const productionPath of [route, view, browser, worker, module, streamNames]) {
    assert.doesNotMatch(productionPath, /receipt-tools|listReceiptFiles|readReceiptFile/i);
    assert.doesNotMatch(productionPath, /\bhx-(?:get|post|trigger|swap|ext)\b|\bsse-connect\b|\bEventSource\b/);
    assert.doesNotMatch(productionPath, /\/replay\/(?:stream|seek|island)\b/);
  }

  assert.match(route, /source: \{ kind: "stream", name: stream \}/);
  assert.match(route, /c\.redirect\(replayUrl\(/);
  assert.match(view, /agentReplayClientControlsHtml/);
  assert.match(view, /assetPath: "\/assets\/replay-client\.js"/);
  assert.match(browser, /tables\.myEventStreams\.where\(\(row\) => row\.workspaceId\.eq\(boot\.workspaceId\)\)/);
  assert.match(browser, /row\.workspaceId\.eq\(boot\.workspaceId\)\.and\(row\.streamId\.eq\(selectedStream!\)\)/);
  assert.match(browser, /row\.workspaceId\.eq\(boot\.workspaceId\)\.and\(row\.streamId\.eq\(selectedInspectorStream\(\)!\)\)/);
  assert.match(browser, /row\.workspaceId !== boot\.workspaceId/);
  assert.match(browser, /reducers\.joinWorkspace\(\{ workspaceId: boot\.workspaceId, capabilityHash \}\)/);
  assert.match(browser, /\.onApplied\(\(\) =>/);
  assert.match(browser, /scheduleReconnect/);
  assert.match(browser, /row\.seq <= cursor/);
  assert.match(server, /inspectorRecordsFromChain\(await inspectorRuntime\.chain\(sourceStream\)\)/);
  assert.match(streamNames, /agents\/inspector\/by-source\/\$\{sha256\(sourceStream\.trim\(\)\)\}/);
  assert.doesNotMatch(server, /inspector source file|ensureInspectorSourceExists/);
  assert.match(packageJson, /build:replay-client/);
});
