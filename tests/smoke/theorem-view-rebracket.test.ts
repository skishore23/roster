import assert from "node:assert/strict";
import test from "node:test";

import { fold, receipt } from "../../src/core/chain.ts";
import type { Chain } from "../../src/core/types.ts";
import {
  deriveTheoremNodeDemands,
  materializeTheoremNode,
  theoremAdaptiveDomain,
} from "../../src/domains/theorem.ts";
import { certifyComposition, createCompositionProposal } from "../../src/engine/orchestration/composition.ts";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  createDynamicTaskDefinition,
} from "../../src/engine/orchestration/task-graph.ts";
import { ROSTER_NODE_TASK_HANDLER } from "../../src/engine/platform/roster-platform.ts";
import {
  initial as initialTheorem,
  reduce as reduceTheorem,
  type TheoremEvent,
} from "../../src/modules/theorem.ts";
import {
  compositionCertifiedEvent,
  compositionProposedEvent,
  orchestrationConfiguredEvent,
  taskGraphProjectedEvent,
} from "../../src/modules/orchestration.ts";
import { theoremChatHtml, theoremShell, theoremSideHtml } from "../../src/views/theorem.ts";
import { writerShell } from "../../src/views/writer.ts";
import { axiomSimpleChatHtml, axiomSimpleShell } from "../../src/views/axiom-simple.ts";
import {
  initial as initialAxiomSimple,
  reduce as reduceAxiomSimple,
  type AxiomSimpleEvent,
} from "../../src/modules/axiom-simple.ts";

const chainFrom = (events: ReadonlyArray<TheoremEvent>): Chain<TheoremEvent> => {
  const stream = "agents/theorem/runs/run_demo";
  let previous: string | undefined;
  return events.map((body, index) => {
    const next = receipt(stream, previous, body, index + 1);
    previous = next.hash;
    return next;
  });
};

test("theorem shell exposes direct realtime panels and replay controls", () => {
  const html = theoremShell("agents/theorem", [], "run_demo");
  assert.match(html, /id="tg-chat"/);
  assert.match(html, /id="tg-folds"/);
  assert.match(html, /id="tg-side"/);
  assert.match(html, /data-replay-controls/);
  assert.match(html, /data-slot="agent-replay"/);
  assert.ok(html.indexOf('data-slot="workspace-context"') < html.indexOf('data-slot="agent-replay"'));
  assert.doesNotMatch(html, /data-agent-tab="replay"/);
  assert.doesNotMatch(html, /EventSource|\shx-[\w-]+\s*=/);
});

test("theorem UI renders coordination from the kernel and no legacy control protocol", () => {
  const runId = "run_demo";
  const domain = theoremAdaptiveDomain(3);
  const agents = deriveTheoremNodeDemands("Prove theorem foo.", 3)
    .map((demand, index) => materializeTheoremNode({
      runId,
      reflectionId: "reflection-view",
      index,
      demand,
    }));
  const registry = domain.registry.extendNodes(agents);
  const explorer = agents.find((agent) => agent.role === "explorer");
  const synthesizer = agents.find((agent) => agent.role === "synthesizer");
  assert.ok(explorer && synthesizer);
  const proposal = createCompositionProposal({
    compositionId: "merge-r1-1",
    planVersion: "merge-plan-v1",
    nodeId: synthesizer.id,
    capability: "compose",
    boundaryHash: "boundary-1",
    inputVersions: { left: "v1", right: "v2" },
    content: "merged proof",
    evidence: [],
  });
  const decision = certifyComposition({
    registry,
    contract: {
      compositionId: "merge-r1-1",
      planVersion: "merge-plan-v1",
      boundaryHash: "boundary-1",
      inputVersions: { left: "v1", right: "v2" },
    },
    proposal,
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  const taskDefinition = createDynamicTaskDefinition({
    taskId: `attempt:r1:${explorer.id}`,
    semanticKey: `attempt:r1:${explorer.id}`,
    nodeId: explorer.id,
    capability: "solve",
    objective: "Develop an independent proof route.",
    handler: ROSTER_NODE_TASK_HANDLER,
    acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
    result: { mode: "none" },
    dependencies: [],
    join: { kind: "all-success" },
    inputs: {
      inputVersions: {},
      dataReferences: [],
      frontierVersion: "frontier-r1",
      topologyVersion: "topology-r1",
      catalogVersion: "theorem@3",
    },
    runtimeBindingEpoch: 0,
    retry: { maxAttempts: 1, initialBackoffMs: 1, maximumBackoffMs: 1 },
    timeoutMs: 30_000,
    sideEffect: "pure",
    estimatedCostMicros: 0,
  });

  const chain = chainFrom([
    { type: "problem.set", runId, problem: "Prove theorem foo.", agentId: "orchestrator" },
    orchestrationConfiguredEvent(runId, domain.pack),
    ...agents.map((node) => ({ type: "node.spawned", runId, node, reason: "objective demand" } as const)),
    { type: "run.status", runId, status: "running", agentId: "orchestrator" },
    taskGraphProjectedEvent(runId, {
      runId,
      policy: {
        maxTasks: 16,
        maxDepth: 4,
        maxFanout: 4,
        maxInflight: 2,
        maxReady: 16,
        maxBlocked: 16,
        maxAttempts: 1,
        maxContextBytes: 1_000_000,
        maxCostMicros: 1_000_000,
        maxTokens: 100_000,
        maxWallTimeMs: 30_000,
      },
      tasks: [{
        definition: taskDefinition,
        status: "running",
        attempt: 1,
        leaseFence: 1,
        leaseOwner: "test-dispatcher",
      }],
      expansions: [],
      acceptedCostMicros: 0,
      acceptedTokens: 0,
      outcomeDataReferences: [],
    }),
    compositionProposedEvent(runId, proposal),
    compositionCertifiedEvent(runId, decision.certification),
    {
      type: "composition.rejected",
      runId,
      compositionId: "merge-r1-2",
      reason: "stale_plan",
      detail: "input boundary changed",
    },
  ]);

  const html = theoremChatHtml(chain);
  assert.match(html, /Orchestration kernel/);
  assert.match(html, /Roster · Workspace topology/);
  assert.match(html, /Independent proof routes/);
  assert.match(html, /Review and synthesis/);
  assert.match(html, /Dynamic task frontier/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /Attempt R1 Solve/);
  assert.match(html, /data-status="running"/);
  assert.match(html, /Merge R1 1/);
  assert.match(html, /Synthesizer \/ 2 inputs \/ 0 checks/);
  assert.match(html, /certified/);
  assert.match(html, /input boundary changed/);
  assert.match(html, /class="orch-live"/);
  assert.match(html, /Replay timeline/);
  assert.doesNotMatch(html, /Workflow DAG|team\.configured|agent\.status|merge\.output/);
});

test("coordination shells share direct playable replay controls", () => {
  const theorem = theoremShell("agents/theorem", [], "run_demo", 4, "branch-a");
  const writer = writerShell("agents/writer", [], "run_writer");
  const swarm = axiomSimpleShell("agents/axiom-simple", [], "run_swarm", 3);

  for (const html of [theorem, writer, swarm]) {
    assert.match(html, /data-slot="agent-shell"/);
    assert.match(html, /data-slot="agent-top-nav"/);
    assert.match(html, /data-slot="workspace-rail"/);
    assert.match(html, /data-slot="agent-main"/);
    assert.match(html, /data-workspace-shell data-layout="room" data-context-open="false" data-slot="workspace-shell"/);
    assert.match(html, /data-slot="workspace-conversation"/);
    assert.match(html, /data-slot="workspace-context"/);
    assert.match(html, /data-replay-controls/);
    assert.match(html, /data-replay-play/);
    assert.match(html, /aria-label="Replay speed"/);
    assert.match(html, /aria-live="polite"/);
    assert.doesNotMatch(html, /EventSource|\shx-[\w-]+\s*=/);
  }
  assert.match(theorem, /data-replay-adapter="adaptive"/);
  assert.match(writer, /data-replay-adapter="writer"/);
  assert.match(swarm, /data-replay-adapter="axiom-simple"/);
});

test("empty replay projection keeps the zero-step replay label", () => {
  const html = theoremChatHtml([], 0);
  assert.match(html, /data-mode="replay">Step 0<\/span>/);
  assert.match(html, /At step/);
  assert.doesNotMatch(html, /data-mode="live">Live<\/span>/);
});

test("proof swarm keeps worker evidence without the redundant branch graph", () => {
  const event: AxiomSimpleEvent = {
    type: "problem.set",
    runId: "run_swarm",
    problem: "theorem foo : True := by trivial",
    agentId: "orchestrator",
  };
  const chain: Chain<AxiomSimpleEvent> = [receipt("agents/axiom-simple/runs/run_swarm", undefined, event, 1)];
  const state = reduceAxiomSimple(initialAxiomSimple, event, 1);
  const html = axiomSimpleChatHtml(state, chain);

  assert.match(html, /Selected Output/);
  assert.match(html, /Worker Lanes/);
  assert.doesNotMatch(html, /Branch \/ Merge \/ Loop|as-graph/);
});

test("proof swarm uses the unified workspace shell with context on demand", () => {
  const html = axiomSimpleShell(
    "agents/axiom-simple",
    [{ id: "true", label: "True", problem: "theorem true : True := by trivial" }],
    "run_swarm",
    null,
  );

  assert.match(html, /class="agent-app agent-unified-page"/);
  assert.match(html, /data-workspace-shell data-layout="room" data-context-open="false" data-slot="workspace-shell"/);
  assert.match(html, /data-slot="workspace-context"[^>]* hidden/);
  assert.match(html, /data-agent-tabs/);
  assert.match(html, /data-agent-tab="workspace"/);
  assert.match(html, /data-agent-tab="runs"/);
  assert.match(html, /data-agent-tab="architecture"/);
  assert.match(html, /data-agent-tab="activity"/);
  assert.match(html, new RegExp("Parallel Fan-out / Fan-in"));
  assert.match(html, /id="as-chat"/);
  assert.match(html, /id="as-side"/);
  assert.match(html, /id="as-travel"/);
  assert.match(html, /id="as-folds"/);
  assert.match(html, /data-slot="agent-replay"/);
  assert.doesNotMatch(html, /data-agent-tab="replay"/);
  assert.doesNotMatch(html, /EventSource|\shx-[\w-]+\s*=/);
});

test("failed theorem runs remain failed after a fallback solution", () => {
  const runId = "run_failed";
  const chain = chainFrom([
    { type: "problem.set", runId, problem: "Prove foo.", agentId: "orchestrator" },
    { type: "run.status", runId, status: "failed", agentId: "orchestrator", note: "missing key" },
    {
      type: "solution.finalized",
      runId,
      agentId: "orchestrator",
      content: "missing key",
      confidence: 0,
      gaps: ["missing key"],
    },
  ]);

  assert.equal(fold(chain, reduceTheorem, initialTheorem).status, "failed");
  const html = theoremChatHtml(chain);
  assert.match(html, /<div class="result-pill">Failed<\/div>/);
  assert.match(html, /missing key/);
});

test("theorem side panel keeps status, streams, memory, and receipts outside the main board", () => {
  const runId = "run_side";
  const chain = chainFrom([
    { type: "problem.set", runId, problem: "Prove foo.", agentId: "orchestrator" },
    {
      type: "memory.slice",
      runId,
      agentId: "orchestrator",
      phase: "merge",
      window: 8,
      maxChars: 1200,
      chars: 240,
      itemCount: 2,
    },
  ]);
  const state = fold(chain, reduceTheorem, initialTheorem);
  const html = theoremSideHtml(state, chain, null, chain.length, "agents/theorem", runId);

  assert.match(html, /<h2>Status<\/h2>/);
  assert.match(html, /<h2>Streams<\/h2>/);
  assert.match(html, /<h2>Shared Memory<\/h2>/);
  assert.match(html, /<h2>Receipts<\/h2>/);
  assert.doesNotMatch(html, /Workflow DAG|Raw:/);
});

test("theorem side panel derives the AXLE replay command from persisted evidence", () => {
  const runId = "run_verify";
  const proof = "import Mathlib\n\ntheorem foo : True := by\n  trivial";
  const formalStatement = "import Mathlib\n\ntheorem foo : True := by\n  sorry";
  const evidence = {
    phase: "verify" as const,
    tool: "lean.verify",
    environment: "lean-4.28.0",
    candidateHash: "abc123",
    formalStatementHash: "def456",
    candidateContent: proof,
    formalStatement,
    ok: true,
    failedDeclarations: [],
  };
  const chain = chainFrom([
    { type: "problem.set", runId, problem: "Prove foo.", agentId: "orchestrator" },
    {
      type: "subagent.merged",
      runId,
      agentId: "verifier",
      subJobId: "job_1",
      subRunId: "axiom_run_1",
      task: "Verify theorem.",
      summary: "status: completed\nAXLE tools: lean.verify",
      outcome: "verified",
      evidence: [evidence],
    },
    {
      type: "verification.report",
      runId,
      agentId: "verifier",
      status: "valid",
      trust: "formal",
      content: "AXLE verification succeeded.",
      evidence,
    },
  ]);
  const state = fold(chain, reduceTheorem, initialTheorem);
  const html = theoremSideHtml(state, chain, null, chain.length, "agents/theorem", runId);

  assert.match(html, /Verification run: yes/);
  assert.match(html, /https:\/\/axle\.axiommath\.ai\/api\/v1\/verify_proof/);
  assert.match(html, /curl -s -X POST https:\/\/axle\.axiommath\.ai\/api\/v1\/verify_proof/);
  assert.match(html, /Final environment: lean-4\.28\.0/);
  assert.match(html, /&quot;environment&quot;:&quot;lean-4\.28\.0&quot;/);
  assert.match(html, /&quot;ignore_imports&quot;:true/);
  assert.match(html, /theorem foo/);
  assert.match(html, /sorry/);
  assert.match(html, /Derived from persisted AXLE verification evidence for this run\./);
});
