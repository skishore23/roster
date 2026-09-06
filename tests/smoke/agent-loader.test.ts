import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

import { loadAgentRoutes } from "../../src/framework/agent-loader.ts";
import type { AgentLoaderContext, AgentLoaderContextInput } from "../../src/framework/agent-types.ts";
import { createStandardNodeRuntimeRegistry } from "../../src/engine/runtime/standard-node-runtimes.ts";

const dummyRuntime = {
  execute: async () => [],
  state: async () => ({}),
  stateAt: async () => ({}),
  chain: async () => [],
  chainAt: async () => [],
  verify: async () => ({ ok: true, count: 0 }),
  fork: async (stream: string, _at: number, _name: string) => ({ name: stream, createdAt: Date.now() }),
  branch: async () => undefined,
  branches: async () => [],
  children: async () => [],
};

const dummyQueue = {
  enqueue: async () => ({ id: "job", status: "queued", commands: [] }),
  leaseNext: async () => undefined,
  heartbeat: async () => undefined,
  complete: async () => undefined,
  fail: async () => undefined,
  cancel: async () => undefined,
  queueCommand: async () => ({ id: "cmd" }),
  consumeCommands: async () => [],
  getJob: async () => undefined,
  listJobs: async () => [],
  waitForJob: async () => undefined,
};

const ctx: AgentLoaderContextInput = {
  llmText: async () => "",
  llmStructured: (async () => ({ parsed: {}, raw: "{}" })) as AgentLoaderContext["llmStructured"],
  enqueueJob: async () => {},
  queue: dummyQueue as AgentLoaderContext["queue"],
  runtimes: {
    theorem: dummyRuntime,
    "axiom-simple": dummyRuntime,
    writer: dummyRuntime,
    agent: dummyRuntime,
    axiom: dummyRuntime,
    "coding-agent": dummyRuntime,
    "coding-room-directory": {
      backfill: async () => undefined,
      list: async () => [],
    },
    "coding-node-runtimes": createStandardNodeRuntimeRegistry(),
    inspector: dummyRuntime,
    selfImprovement: dummyRuntime,
    memory: dummyRuntime,
  },
  prompts: {
    theorem: {},
    writer: {},
    inspector: {},
    agent: {},
    axiom: {},
  },
  promptHashes: {
    theorem: "",
    writer: "",
    inspector: "",
    agent: "",
    axiom: "",
    canvas: "",
  },
  promptPaths: {
    theorem: "",
    writer: "",
    inspector: "",
    agent: "",
    axiom: "",
  },
  models: {
    theorem: "",
    writer: "",
    inspector: "",
    agent: "",
    axiom: "",
  },
  helpers: {},
};

test("agent loader auto-discovers route modules", async () => {
  const routes = await loadAgentRoutes(ctx);
  const ids = routes.map((route) => route.id).sort();
  assert.deepEqual(ids, [
    "agent",
    "axiom",
    "axiom-simple",
    "canvas",
    "coding-agent",
    "receipt-inspector",
    "simulations",
    "theorem",
    "writer",
  ]);
});

test("agent loader can fail closed to an exact application module allowlist", async () => {
  const routes = await loadAgentRoutes(ctx, { moduleNames: ["coding"] });
  assert.deepEqual(routes.map((route) => route.id), ["coding-agent"]);
  await assert.rejects(
    loadAgentRoutes(ctx, { moduleNames: ["missing"] }),
    /Configured Roster agent modules are missing: missing/,
  );
});

test("agent loader adapts defineAgent specs into runnable headless routes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roster-agent-loader-"));
  const runs: Array<{ readonly id: string; readonly problem: string }> = [];
  try {
    await fs.writeFile(path.join(directory, "scaffold.agent.ts"), `
      export default {
        id: "scaffold-agent",
        version: "1.0.0",
        receipts: { "task.requested": { __receipt: true } },
        view: () => ({}),
        actions: () => [],
        goal: () => true,
      };
    `);
    const routes = await loadAgentRoutes({
      ...ctx,
      runHeadlessAgent: async ({ spec, problem }) => {
        runs.push({ id: spec.id, problem });
        return { runId: "run-http", stream: `agents/${spec.id}`, runStream: `agents/${spec.id}/runs/run-http` };
      },
    }, { directory, suffix: ".agent.ts" });

    assert.equal(routes.length, 1);
    assert.equal(routes[0]?.moduleType, "headless");
    assert.equal(routes[0]?.paths?.run, "/agents/scaffold-agent/run");

    const app = new Hono();
    routes[0]?.register(app);
    const page = await app.request("/agents/scaffold-agent");
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /scaffold-agent/);
    assert.match(pageHtml, /data-slot="agent-shell"/);
    assert.match(pageHtml, /data-slot="agent-top-nav"/);
    assert.match(pageHtml, /data-slot="workspace-rail"/);
    assert.match(pageHtml, /data-slot="agent-main"/);
    assert.match(pageHtml, /data-workspace-shell data-layout="room" data-context-open="false" data-slot="workspace-shell"/);
    assert.match(pageHtml, /aria-label="Headless agent context"/);
    assert.match(pageHtml, /data-slot="workspace-conversation"/);
    assert.match(pageHtml, /data-agent-tab="work"/);
    assert.match(pageHtml, /name="problem"[^>]*autocomplete="off"/);
    const csrf = pageHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
    assert.ok(csrf);
    const rejected = await app.request("/agents/scaffold-agent/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ problem: "prove it" }),
    });
    assert.equal(rejected.status, 403);
    const response = await app.request("/agents/scaffold-agent/run", {
      method: "POST",
      headers: { "content-type": "application/json", "x-roster-csrf": csrf },
      body: JSON.stringify({ problem: "prove it" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(runs, [{ id: "scaffold-agent", problem: "prove it" }]);
    assert.equal((await response.json() as { readonly runId: string }).runId, "run-http");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("agent loader rejects duplicate ids across application and headless modules", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roster-agent-loader-duplicate-"));
  try {
    await fs.writeFile(path.join(directory, "application.agent.ts"), `
      export default { id: "duplicate-agent", register: () => {} };
    `);
    await fs.writeFile(path.join(directory, "headless.agent.ts"), `
      export default {
        id: "duplicate-agent", version: "1.0.0", receipts: { "task.requested": { __receipt: true } },
        view: () => ({}), actions: () => [], goal: () => true,
      };
    `);
    await assert.rejects(
      loadAgentRoutes(ctx, { directory, suffix: ".agent.ts" }),
      /duplicate agent route id 'duplicate-agent'/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
