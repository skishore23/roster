import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";

import { spacetimeTestOptions } from "../support/spacetimedb-test.js";

import { memoryBranchStore, memoryStore } from "../../src/adapters/memory-store.ts";
import { fold } from "../../src/core/chain.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import {
  runTheoremRoster,
  THEOREM_DEFAULT_CONFIG,
} from "../../src/agents/theorem.ts";
import {
  runWriterRoster,
  WRITER_DEFAULT_CONFIG,
  type WriterExecutionPlane,
} from "../../src/agents/writer.ts";
import { theoremRunStream } from "../../src/agents/theorem.streams.ts";
import { writerRunStream } from "../../src/agents/writer.streams.ts";
import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import {
  InMemoryTaskGraphControl,
  taskGraphTask,
} from "../../src/engine/orchestration/task-graph-control.ts";
import {
  SharedWorkspaceLedger,
  createRosterTaskContext,
} from "../../src/engine/workspace/shared-workspace.ts";
import {
  decide as decideTheorem,
  reduce as reduceTheorem,
  initial as initialTheorem,
  type TheoremCmd,
  type TheoremEvent,
  type TheoremState,
} from "../../src/modules/theorem.ts";
import {
  decide as decideWriter,
  reduce as reduceWriter,
  initial as initialWriter,
  type WriterCmd,
  type WriterEvent,
  type WriterState,
} from "../../src/modules/writer.ts";

const writerExecutionPlane = (runId: string): WriterExecutionPlane => {
  const taskGraph = new InMemoryTaskGraphControl();
  const ledger = new SharedWorkspaceLedger(`writer-ui-test-workspace:${runId}`);
  return {
    taskGraph,
    dataReferences: new InMemoryDataReferenceStore(),
    createTaskContext: ({ node, definition, lease }) => createRosterTaskContext({
      node,
      ledger,
      fence: {
        runId,
        taskId: definition.taskId,
        nodeId: node.id,
        fence: BigInt(lease.fence),
        frontierVersion: definition.inputs.frontierVersion,
        topologyVersion: definition.inputs.topologyVersion,
        catalogVersion: definition.inputs.catalogVersion,
        runtimeBindingEpoch: definition.runtimeBindingEpoch,
        inputVersions: definition.inputs.inputVersions,
      },
      authority: {
        assertActive: async () => {
          const record = taskGraphTask(await taskGraph.snapshot(), definition.taskId);
          if (
            !record
            || (record.status !== "leased" && record.status !== "running")
            || record.leaseOwner !== lease.owner
            || record.leaseFence !== lease.fence
          ) {
            throw new Error(`Writer UI test task ${definition.taskId} lost its workspace fence`);
          }
        },
      },
    }),
  };
};
import { loadTheoremPrompts } from "../../src/prompts/theorem.ts";
import { loadWriterPrompts } from "../../src/prompts/writer.ts";
import { createTestTheoremExecutionPlanes } from "../support/theorem-platform.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const getFreePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("unable to resolve free port"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });

const waitForHttpOk = async (url: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server still booting
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  const exitPromise = once(child, "exit");
  child.kill("SIGTERM");

  const killTimer = setTimeout(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }, 5_000);

  await exitPromise;
  clearTimeout(killTimer);
};

test("smoke: theorem/writer runs boot without API key", { timeout: 120_000 }, async () => {
  const dataDir = await createTempDir("receipt-smoke-agent-boot");

  try {
    const branchStore = memoryBranchStore();
    const theoremRuntime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      memoryStore<TheoremEvent>(),
      branchStore,
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    const writerRuntime = createRuntime<WriterCmd, WriterEvent, WriterState>(
      memoryStore<WriterEvent>(),
      branchStore,
      decideWriter,
      reduceWriter,
      initialWriter
    );

    const theoremRunId = `run_${Date.now()}_theorem`;
    await runTheoremRoster({
      stream: "theorem",
      runId: theoremRunId,
      problem: "Prove x = x",
      config: THEOREM_DEFAULT_CONFIG,
      runtime: theoremRuntime,
      prompts: loadTheoremPrompts(),
      llmText: async () => "",
      model: "gpt-4o",
      apiReady: false,
      apiNote: "OPENAI_API_KEY not set",
      createPlatformExecutionPlanes: createTestTheoremExecutionPlanes,
    });

    const theoremChain = await theoremRuntime.chain(theoremRunStream("theorem", theoremRunId));
    assert.ok(theoremChain.some((r) => r.body.type === "run.configured"), "theorem run.configured missing");
    assert.ok(
      theoremChain.some((r) => r.body.type === "run.status" && r.body.status === "failed"),
      "theorem failed status missing"
    );

    const writerRunId = `run_${Date.now()}_writer`;
    await runWriterRoster({
      stream: "writer",
      runId: writerRunId,
      problem: "Write a short brief",
      config: WRITER_DEFAULT_CONFIG,
      runtime: writerRuntime,
      prompts: loadWriterPrompts(),
      llmText: async () => "",
      model: "gpt-4o",
      apiReady: false,
      apiNote: "OPENAI_API_KEY not set",
      executionPlane: writerExecutionPlane(writerRunId),
    });

    const writerChain = await writerRuntime.chain(writerRunStream("writer", writerRunId));
    assert.ok(writerChain.some((r) => r.body.type === "run.configured"), "writer run.configured missing");
    assert.ok(
      writerChain.some((r) => r.body.type === "run.status" && r.body.status === "failed"),
      "writer failed status missing"
    );
    assert.equal(fold(writerChain, reduceWriter, initialWriter).status, "failed");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("smoke: coordination examples, simulations, and replay UI routes boot", spacetimeTestOptions(120_000), async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-smoke-ui");
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      OPENAI_API_KEY: "",
      SPACETIMEDB_TOKEN: "",
      SPACETIMEDB_TOKEN_PATH: path.join(dataDir, "spacetimedb-service.token"),
      ROSTER_WORKSPACE_ID: `test/agent-ui-${randomUUID()}`,
    },
    stdio: "pipe",
  });

  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHttpOk(`${base}/replay`, 30_000);

    const healthRes = await fetch(`${base}/healthz`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json() as { readonly ok?: boolean; readonly service?: string; readonly state?: string; readonly uptimeSeconds?: number };
    assert.equal(health.ok, true);
    assert.equal(health.service, "roster");
    assert.equal(health.state, "running");
    assert.equal(typeof health.uptimeSeconds, "number");
    const readyRes = await fetch(`${base}/readyz`);
    assert.equal(readyRes.status, 200);
    const ready = await readyRes.json() as { readonly ok?: boolean; readonly state?: string; readonly controlPlane?: string };
    assert.equal(ready.ok, true);
    assert.equal(ready.state, "ready");
    assert.equal(ready.controlPlane, "connected");

    const roomOsHealthRes = await fetch(`${base}/api/v2/room-os/health`);
    assert.equal(roomOsHealthRes.status, 200);
    assert.match(roomOsHealthRes.headers.get("content-type") ?? "", /^application\/json(?:;|$)/);
    assert.equal(roomOsHealthRes.headers.get("cache-control"), "no-store");
    const roomOsHealth = await roomOsHealthRes.json() as {
      readonly schema?: string;
      readonly apiVersion?: string;
      readonly ok?: boolean;
      readonly durableStore?: string;
    };
    assert.equal(roomOsHealth.apiVersion, "v2");
    assert.deepEqual(roomOsHealth, {
      schema: "roster.room-os-health.v1",
      apiVersion: "v2",
      ok: true,
      durableStore: "spacetime",
    });

    const monitorRes = await fetch(`${base}/monitor`);
    assert.equal(monitorRes.status, 200, `GET /monitor failed: ${monitorRes.status}`);
    const monitorHtml = await monitorRes.text();
    assert.match(monitorHtml, /Roster - Lobby/);

    const theoremRes = await fetch(`${base}/theorem`);
    assert.equal(theoremRes.status, 200, `GET /theorem failed: ${theoremRes.status}`);
    const theoremHtml = await theoremRes.text();
    assert.match(theoremHtml, /Roster - Adaptive Proof/);
    assert.match(theoremHtml, /#adaptive-proof/);
    assert.match(theoremHtml, /data-workspace-shell data-layout="room" data-context-open="false" data-slot="workspace-shell"/);
    assert.match(theoremHtml, /data-slot="workspace-rail"/);
    assert.match(theoremHtml, /data-slot="workspace-conversation"/);
    assert.match(theoremHtml, /data-slot="workspace-context"/);
    assert.match(theoremHtml, /data-slot="agent-replay"/);
    assert.ok(theoremHtml.indexOf('data-slot="workspace-conversation"') < theoremHtml.indexOf('data-slot="agent-replay"'));
    assert.doesNotMatch(theoremHtml, /aria-label="Proof mode"/);

    const writerRes = await fetch(`${base}/writer`);
    assert.equal(writerRes.status, 200, `GET /writer failed: ${writerRes.status}`);
    const writerHtml = await writerRes.text();
    assert.match(writerHtml, /Roster - Writer Roster/);
    assert.match(writerHtml, /#writing-room/);
    assert.match(writerHtml, /data-workspace-shell data-layout="room" data-context-open="false" data-slot="workspace-shell"/);
    assert.match(writerHtml, /data-slot="agent-replay"/);

    const canvasRes = await fetch(`${base}/canvas`);
    assert.equal(canvasRes.status, 200, `GET /canvas failed: ${canvasRes.status}`);
    const canvasHtml = await canvasRes.text();
    assert.match(canvasHtml, /Roster - Canvas Roster/);
    assert.match(canvasHtml, /data-slot="agent-replay"/);
    assert.match(canvasHtml, /id="canvas-replay-controls"[^>]*data-replay-controls/);
    assert.match(canvasHtml, /#canvas-studio/);
    assert.match(canvasHtml, /data-workspace-shell data-layout="room" data-context-open="false" data-slot="workspace-shell"/);
    assert.match(canvasHtml, /id="canvas-stage"/);
    assert.match(canvasHtml, /data-slot="studio-floor"/);
    assert.match(canvasHtml, /id="studio-live-copy" role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(canvasHtml, /id="studio-agent-strip"/);
    assert.match(canvasHtml, /id="studio-event-strip"/);
    assert.match(canvasHtml, /Bicycle lighthouse/);
    assert.match(canvasHtml, /id="canvas-parallel"[^>]*max="8"/);
    assert.match(canvasHtml, /Cost-aware new-run route/);
    assert.match(canvasHtml, /gpt-5\.6-luna/);
    assert.match(canvasHtml, /gpt-5\.6-terra/);
    assert.match(canvasHtml, /caller-scoped realtime view/);
    assert.match(canvasHtml, /id="canvas-live-pill"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(canvasHtml, /id="canvas-boot" type="application\/json"/);
    assert.match(canvasHtml, /"realtime":\{"enabled":true/);
    assert.match(canvasHtml, /<script type="module" src="\/assets\/canvas-client\.js" nonce="[^"]+"><\/script>/);
    assert.match(canvasRes.headers.get("content-security-policy") ?? "", /script-src 'self' 'nonce-/);
    assert.match(canvasRes.headers.get("content-security-policy") ?? "", /'unsafe-eval'/);
    assert.equal(canvasRes.headers.get("x-frame-options"), "DENY");
    assert.doesNotMatch(canvasHtml, /SpacetimeDB is unavailable/);
    assert.match(canvasHtml, /id="canvas-submit"[^>]*disabled/);
    assert.doesNotMatch(canvasHtml, /EventSource|\/canvas\/state|\/canvas\/stream/);

    const canvasAssetRes = await fetch(`${base}/assets/canvas-client.js`);
    assert.equal(canvasAssetRes.status, 200, `GET /assets/canvas-client.js failed: ${canvasAssetRes.status}`);
    assert.match(canvasAssetRes.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.equal(canvasAssetRes.headers.get("x-content-type-options"), "nosniff");
    assert.ok((await canvasAssetRes.text()).length > 10_000, "expected bundled Canvas realtime client");

    const shellAssetRes = await fetch(`${base}/assets/roster-shell.js`);
    assert.equal(shellAssetRes.status, 200, `GET /assets/roster-shell.js failed: ${shellAssetRes.status}`);
    assert.match(shellAssetRes.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.equal(shellAssetRes.headers.get("x-content-type-options"), "nosniff");
    const shellAsset = await shellAssetRes.text();
    assert.ok(shellAsset.length > 1_000 && shellAsset.length < 12_000, "expected lean Roster room shell client");
    assert.doesNotMatch(shellAsset, /react|webgl/i);

    const axiomRes = await fetch(`${base}/axiom`);
    assert.equal(axiomRes.status, 200, `GET /axiom failed: ${axiomRes.status}`);
    const axiomHtml = await axiomRes.text();
    assert.match(axiomHtml, /Roster - Verified Proof/);
    assert.match(axiomHtml, /Run Verified Proof/);
    assert.match(axiomHtml, /Conflict-free frontier with successful AXLE verification/);
    assert.match(axiomHtml, /agents%2Faxiom-roster|agents\/axiom-roster/);
    assert.match(axiomHtml, /data-slot="agent-replay"/);

    const swarmRes = await fetch(`${base}/axiom-simple`);
    assert.equal(swarmRes.status, 200, `GET /axiom-simple failed: ${swarmRes.status}`);
    const swarmHtml = await swarmRes.text();
    assert.match(swarmHtml, /Roster - Proof Swarm/);
    assert.match(swarmHtml, /Run Proof Swarm/);
    assert.match(swarmHtml, /Parallel fan-out/);
    assert.match(swarmHtml, /class="agent-app agent-unified-page"/);
    assert.match(swarmHtml, /data-workspace-shell data-layout="room" data-context-open="false" data-slot="workspace-shell"/);
    assert.match(swarmHtml, /data-agent-tabs/);
    assert.match(swarmHtml, /id="as-chat"/);
    assert.match(swarmHtml, /id="as-side"/);
    assert.match(swarmHtml, /id="as-travel"/);
    assert.match(swarmHtml, /id="as-folds"/);
    assert.match(swarmHtml, /data-slot="agent-replay"/);
    assert.doesNotMatch(swarmHtml, /aria-label="Proof mode"/);
    assert.doesNotMatch(swarmHtml, /Axiom Simple|onclick=/);
    assert.match(swarmHtml, /data-thinking-orb/);

    const swarmWorkerRes = await fetch(`${base}/axiom-simple/worker?stream=agents%2Faxiom&run=missing`);
    assert.equal(swarmWorkerRes.status, 200, `GET /axiom-simple/worker failed: ${swarmWorkerRes.status}`);
    const swarmWorkerHtml = await swarmWorkerRes.text();
    assert.match(swarmWorkerHtml, /Lean proof and AXLE evidence/);
    assert.match(swarmWorkerHtml, /class="agent-app agent-unified-page"/);
    assert.match(swarmWorkerHtml, /data-agent-tabs/);
    assert.match(swarmWorkerHtml, /id="axiom-worker-views"/);
    assert.match(swarmWorkerHtml, /id="aw-chat"/);
    assert.match(swarmWorkerHtml, /id="aw-side"/);
    assert.match(swarmWorkerHtml, /id="aw-folds"/);
    assert.match(swarmWorkerHtml, /id="axiom-worker-replay"/);
    assert.match(swarmWorkerHtml, /data-replay-adapter="axiom-worker"/);
    assert.match(swarmWorkerHtml, /data-slot="agent-replay"/);
    assert.match(swarmWorkerHtml, /#axiom-missing/);
    assert.match(swarmWorkerHtml, /data-agent-tab="evidence"><span>Evidence<\/span>/);
    assert.match(swarmWorkerHtml, /data-slot="workspace-conversation"/);
    assert.match(swarmWorkerHtml, /data-slot="workspace-context"/);
    assert.match(swarmWorkerHtml, /data-slot="agent-room-workspace"/);

    const simulationRes = await fetch(`${base}/simulations`);
    assert.equal(simulationRes.status, 200, `GET /simulations failed: ${simulationRes.status}`);
    const simulationHtml = await simulationRes.text();
    assert.match(simulationHtml, /Roster - Simulation Lab/);
    assert.match(simulationHtml, /Simulation lab ready/);
    assert.match(simulationHtml, /Coding Collaboration/);
    assert.match(simulationHtml, /Application invariants/);
    assert.match(simulationHtml, /Coding Terminal Projection Contract/);
    assert.match(simulationHtml, /Terminal delivery/);
    assert.match(simulationHtml, /Dynamic DAG/);
    assert.match(simulationHtml, /Worker mesh/);
    assert.match(simulationHtml, /Runtime lifecycle/);
    assert.match(simulationHtml, /Framework Lifecycle Contract/);
    assert.match(simulationHtml, /data-simulation-runtime-lifecycle/);
    assert.match(simulationHtml, /data-simulation-dag/);
    assert.match(simulationHtml, /data-simulation-worker-mesh/);
    assert.match(simulationHtml, /npm run simulate:campaign/);
    assert.match(simulationHtml, /Base Seed/);
    assert.match(simulationHtml, /Adaptive Topology/);
    assert.match(simulationHtml, /data-status="pass">Converged/);
    assert.match(simulationHtml, /Recorded entropy \+ exact replay/);
    assert.match(simulationHtml, /data-slot="agent-replay"/);
    assert.match(simulationHtml, /#simulation-lab/);
    assert.match(simulationHtml, /data-slot="agent-room-workspace"/);
    assert.match(simulationHtml, /class="agent-app agent-unified-page simulation-app" data-slot="agent-shell" data-ui-family="roster-agent"/);
    assert.match(simulationHtml, /data-workspace-shell data-layout="room"/);
    assert.match(simulationHtml, /top-navbar-link active" href="\/monitor\?tab=inspect" aria-current="page">Inspect/);
    assert.match(simulationHtml, /\.sim-run \{[^}]*background:var\(--action-primary\)/);
    assert.doesNotMatch(simulationHtml, /min-width:980px|background:#1f5f7a/);
    assert.match(simulationHtml, /data-simulation-replay-data/);
    assert.match(simulationHtml, /action="\/simulations\/run" method="post" data-simulation-form/);
    assert.match(simulationHtml, /id="simulation-form-status" role="status" aria-live="polite"/);
    assert.match(simulationHtml, /Accept:"application\/json"/);
    assert.doesNotMatch(simulationHtml, /htmx/i);
    assert.doesNotMatch(simulationHtml, /\shx-[\w-]+=/);
    assert.doesNotMatch(simulationHtml, /unpkg\.com/);
    assert.match(simulationRes.headers.get("content-security-policy") ?? "", /script-src 'self' 'nonce-/);
    assert.equal(simulationRes.headers.get("x-frame-options"), "DENY");

    const simulationRunBody = new URLSearchParams({
      pattern: "hierarchy",
      agents: "4",
      maxParallel: "2",
      schedules: "1",
      seed: "42",
      injectFaults: "1",
    });
    const simulationRunRes = await fetch(`${base}/simulations/run`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: simulationRunBody,
    });
    assert.equal(simulationRunRes.status, 200, `POST /simulations/run JSON failed: ${simulationRunRes.status}`);
    assert.match(simulationRunRes.headers.get("content-type") ?? "", /^application\/json/);
    const simulationPayload = await simulationRunRes.json() as {
      ok: boolean;
      campaignId: string;
      html: string;
    };
    assert.equal(simulationPayload.ok, true);
    assert.match(simulationPayload.campaignId, /^campaign_/);
    assert.match(simulationPayload.html, /Verification Hierarchy/);
    assert.match(simulationPayload.html, /data-simulation-replay-data/);
    assert.match(simulationPayload.html, /Live Task Graph/);
    assert.match(simulationPayload.html, /Catalog-pinned Worker Activity/);
    assert.doesNotMatch(simulationPayload.html, /<!doctype html>/i);

    const simulationFallbackRes = await fetch(`${base}/simulations/run`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: simulationRunBody,
    });
    assert.equal(simulationFallbackRes.status, 200, `POST /simulations/run HTML failed: ${simulationFallbackRes.status}`);
    assert.match(simulationFallbackRes.headers.get("content-type") ?? "", /^text\/html/);
    const simulationFallbackHtml = await simulationFallbackRes.text();
    assert.match(simulationFallbackHtml, /<!doctype html>/i);
    assert.match(simulationFallbackHtml, /Verification Hierarchy/);
    assert.match(simulationFallbackHtml, /name="agents" min="2" max="128" value="4"/);

    const simulationInvalidRes = await fetch(`${base}/simulations/run`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ pattern: "adaptive", agents: "1", maxParallel: "2", schedules: "1", seed: "42" }),
    });
    assert.equal(simulationInvalidRes.status, 400);
    assert.deepEqual(await simulationInvalidRes.json(), {
      ok: false,
      error: "Choose valid campaign controls and try again.",
    });

    const simulationInvalidParallelRes = await fetch(`${base}/simulations/run`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ pattern: "adaptive", agents: "2", maxParallel: "3", schedules: "1", seed: "42" }),
    });
    assert.equal(simulationInvalidParallelRes.status, 400);
    assert.deepEqual(await simulationInvalidParallelRes.json(), {
      ok: false,
      error: "Choose valid campaign controls and try again.",
    });

    const receiptRes = await fetch(`${base}/replay`);
    assert.equal(receiptRes.status, 200, `GET /replay failed: ${receiptRes.status}`);
    const receiptHtml = await receiptRes.text();
    assert.match(receiptHtml, /Roster - Replay/);
    assert.match(receiptHtml, /data-workspace-shell data-layout="room" data-context-open="false" data-slot="workspace-shell"/);
    assert.match(receiptHtml, /id="replay-tabs"[^>]*data-agent-tabs/);
    assert.match(receiptHtml, /data-slot="agent-replay"/);
    assert.match(receiptHtml, /#replay-room/);
    assert.match(receiptHtml, /data-slot="workspace-composer"/);
    assert.match(receiptHtml, /data-slot="composer-input"/);
    assert.match(receiptHtml, /data-slot="agent-room-workspace"/);

    for (const [route, pageHtml] of [["/monitor", monitorHtml], ["/theorem", theoremHtml], ["/axiom", axiomHtml], ["/axiom-simple", swarmHtml], ["/writer", writerHtml], ["/canvas", canvasHtml], ["/replay", receiptHtml]] as const) {
      assert.equal((pageHtml.match(/data-slot="workspace-composer"/g) ?? []).length, 1, `${route} must render one shared Coding-grade composer`);
      assert.equal((pageHtml.match(/<textarea[^>]*data-slot="composer-input"/g) ?? []).length, 1, `${route} must render one shared composer input`);
      assert.equal((pageHtml.match(/<button[^>]*data-slot="composer-submit"/g) ?? []).length, 1, `${route} must render one shared composer submit action`);
    }

    for (const [route, pageHtml] of [
      ["/monitor", monitorHtml],
      ["/theorem", theoremHtml],
      ["/axiom", axiomHtml],
      ["/axiom-simple", swarmHtml],
      ["/axiom-simple/worker", swarmWorkerHtml],
      ["/writer", writerHtml],
      ["/canvas", canvasHtml],
      ["/simulations", simulationHtml],
      ["/replay", receiptHtml],
    ] as const) {
      assert.equal((pageHtml.match(/data-slot="agent-shell"/g) ?? []).length, 1, `${route} must render one Roster shell`);
      assert.equal((pageHtml.match(/data-slot="agent-top-nav"/g) ?? []).length, 1, `${route} must render one Roster top navigation`);
      assert.equal((pageHtml.match(/data-slot="(?:agent-sidebar|workspace-rail)"/g) ?? []).length, 1, `${route} must render one Roster navigation rail`);
      assert.equal((pageHtml.match(/data-slot="agent-main"/g) ?? []).length, 1, `${route} must render one Roster main workspace`);
      assert.match(pageHtml, /<strong translate="no">Roster<\/strong><small>People \+ agents<\/small>/, `${route} must use shared Roster branding`);
      assert.match(pageHtml, /<select[^>]+aria-label="Theme"/, `${route} must expose the shared theme control`);
    }
  } finally {
    await stopChild(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  assert.equal(stderr.includes("EADDRINUSE"), false, `server boot conflict: ${stderr}`);
});
