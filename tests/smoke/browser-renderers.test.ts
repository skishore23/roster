import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../../src/core/canonical.js";
import {
  renderAxiomSimplePanels,
  renderAxiomWorkerPanels,
  renderTheoremPanels,
  renderWriterPanels,
  rowsToChain,
  type RealtimeReceiptRow,
} from "../../src/browser/roster-renderers.js";

const row = (
  streamId: string,
  seq: number,
  body: Readonly<Record<string, unknown>>,
  previous = "",
): RealtimeReceiptRow => ({
  id: `${streamId}:${seq}`,
  workspaceId: "roster/test",
  streamId,
  seq: BigInt(seq),
  receiptId: `receipt-${seq}`,
  occurredAtMs: BigInt(1_700_000_000_000 + seq),
  prevHash: previous,
  hash: `hash-${seq}`,
  bodyJson: JSON.stringify(body),
  hintsJson: "{}",
});

test("axiom child workers use the same durable replay projection", () => {
  const workerRows = [row("agents/axiom/runs/worker-1", 1, {
    type: "problem.set",
    runId: "worker-1",
    problem: "Prove a child lemma",
    agentId: "axiom-worker",
  })];
  const panels = renderAxiomWorkerPanels({
    stream: "agents/axiom",
    runId: "worker-1",
    runRows: workerRows,
    cursor: { seq: null },
  });

  assert.equal(panels.replay.position, 1);
  assert.equal(panels.replay.total, 1);
  assert.match(panels.chatHtml, /Prove a child lemma/);
  assert.match(panels.sideHtml, /Run Overview/);
  assert.match(panels.foldsHtml, /worker-1/);
});

test("browser hashing keeps the canonical SHA-256 contract", () => {
  assert.equal(
    sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256("🌌 collaborative agents"),
    "a3d52d3f6c2f6b5633cbe8a126551d53c537bae7ddb68019e7aef2209b5e1ea5",
  );
});

test("receipt rows fold at an exact SpacetimeDB sequence", () => {
  const rows = [
    row("agents/demo", 1, { type: "first" }),
    row("agents/demo", 2, { type: "second" }, "hash-1"),
  ];
  assert.deepEqual(rowsToChain(rows).map((receipt) => receipt.body.type), ["first", "second"]);
  assert.deepEqual(rowsToChain(rows, { seq: 1n }).map((receipt) => receipt.body.type), ["first"]);
  assert.deepEqual(rowsToChain(rows, { seq: 0n }), []);
});

test("shared render adapters expose one replay contract for proof, writer, and swarm", () => {
  const theoremRows = [row("agents/theorem/runs/t1", 1, {
    type: "problem.set",
    runId: "t1",
    problem: "Prove a theorem",
    agentId: "orchestrator",
  })];
  const writerRows = [row("agents/writer/runs/w1", 1, {
    type: "problem.set",
    runId: "w1",
    problem: "Write a note",
    agentId: "orchestrator",
  })];
  const swarmRows = [row("agents/axiom-simple/runs/a1", 1, {
    type: "problem.set",
    runId: "a1",
    problem: "Solve a lemma",
    agentId: "orchestrator",
  })];

  const theorem = renderTheoremPanels({
    basePath: "/theorem",
    stream: "agents/theorem",
    runId: "t1",
    indexRows: theoremRows,
    runRows: theoremRows,
    cursor: { seq: null },
  });
  const writer = renderWriterPanels({
    stream: "agents/writer",
    runId: "w1",
    indexRows: writerRows,
    runRows: writerRows,
    cursor: { seq: null },
  });
  const swarm = renderAxiomSimplePanels({
    stream: "agents/axiom-simple",
    runId: "a1",
    indexRows: swarmRows,
    runRows: swarmRows,
    cursor: { seq: null },
  });

  for (const panels of [theorem, writer, swarm]) {
    assert.equal(panels.replay.position, 1);
    assert.equal(panels.replay.total, 1);
    assert.match(panels.replay.label, /^Live 1\/1$/);
    assert.match(panels.conversationHtml, /class="room-thread"/);
    assert.match(panels.conversationHtml, /<strong>You<\/strong>/);
    assert.ok(panels.chatHtml.length > 0);
    assert.ok(panels.foldsHtml.length > 0);
    assert.ok(panels.sideHtml.length > 0);
  }
});
