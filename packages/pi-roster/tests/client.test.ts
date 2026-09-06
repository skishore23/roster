import assert from "node:assert/strict";
import test from "node:test";
import { RosterApiError, RosterClient } from "../src/client.js";
import { ROSTER_CONTROL_API_VERSION, ROSTER_CONTROL_MEDIA_TYPE } from "../src/contracts.js";

test("RosterClient uses the versioned API and bearer token", async () => {
  let request: { readonly url: string; readonly init?: RequestInit } | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    request = { url: String(input), init };
    return Response.json({
      schema: ROSTER_CONTROL_API_VERSION,
      runId: "run-1",
      job: {
        id: "job-1",
        objective: "Add tests",
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
        branch: "roster/run-1",
      },
    });
  };
  const client = new RosterClient({ baseUrl: "http://roster.test/", token: "secret", fetch: fetcher });

  const started = await client.startRun({ objective: "Add tests", workingDirectory: "/repo", reviewPolicy: "fast", workerRuntime: "pi-agent" });

  assert.equal(request?.url, "http://roster.test/api/v2/coding/runs");
  const headers = new Headers(request?.init?.headers);
  assert.equal(headers.get("accept"), ROSTER_CONTROL_MEDIA_TYPE);
  assert.equal(headers.get("content-type"), ROSTER_CONTROL_MEDIA_TYPE);
  assert.equal(headers.get("authorization"), "Bearer secret");
  assert.equal(started.branch, "roster/run-1");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    objective: "Add tests",
    workingDirectory: "/repo",
    reviewPolicy: "fast",
    workerRuntime: "pi-agent",
  });
});

test("RosterClient encodes run IDs and submits commands to Roster", async () => {
  const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({ schema: ROSTER_CONTROL_API_VERSION, ok: true, runId: "run / 1", jobId: "job-1", command: {} });
  };
  const client = new RosterClient({ baseUrl: "http://roster.test", fetch: fetcher });

  await client.steer("run / 1", "focus tests");
  await client.getDiff("run / 1");

  assert.equal(requests[0]?.url, "http://roster.test/api/v2/coding/runs/run%20%2F%201/messages");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    message: "focus tests",
    source: { kind: "agent", provider: "pi" },
    tags: ["intent:steer"],
  });
  assert.equal(requests[1]?.url, "http://roster.test/api/v2/coding/diff?runId=run%20%2F%201");
});

test("RosterClient reads and creates the saved repository team", async () => {
  const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({
      schema: ROSTER_CONTROL_API_VERSION,
      workspace: {
        scanned: requests.length > 1,
        repositoryRoot: "/repo",
        nodes: requests.length > 1 ? [{ id: "workspace.implementation", name: "Implementation Engineer", capabilities: ["implement"] }] : [],
      },
    });
  };
  const client = new RosterClient({ baseUrl: "http://roster.test", fetch: fetcher });

  assert.equal((await client.getWorkspace()).scanned, false);
  const saved = await client.scanWorkspace();

  assert.equal(saved.scanned, true);
  assert.equal(saved.nodes?.[0]?.id, "workspace.implementation");
  assert.equal(requests[0]?.url, "http://roster.test/api/v2/coding/workspace");
  assert.equal(requests[1]?.url, "http://roster.test/api/v2/coding/workspace/scan");
  assert.equal(requests[1]?.init?.method, "POST");
});

test("RosterClient projects v2 run tasks through their workspace node IDs", async () => {
  const client = new RosterClient({
    baseUrl: "http://roster.test",
    fetch: async () => Response.json({
      schema: ROSTER_CONTROL_API_VERSION,
      run: { id: "run-2", objective: "Review the node-native API" },
      job: {
        id: "job-2",
        status: "running",
        createdAt: 1,
        updatedAt: 2,
      },
      tasks: {
        review: {
          taskId: "review",
          nodeId: "workspace.quality",
          status: "running",
        },
      },
      nodes: {
        "workspace.quality": {
          id: "workspace.quality",
          name: "Quinn, Quality Engineer",
          runtime: { kind: "codex-cli", metadata: { model: "gpt-5.6-sol" } },
        },
      },
      events: [],
    }),
  });

  const run = await client.getRun("run-2");

  assert.deepEqual(run.tasks, [{
    id: "review",
    nodeId: "workspace.quality",
    nodeName: "Quinn, Quality Engineer",
    runtime: "codex-cli",
    model: "gpt-5.6-sol",
    status: "running",
  }]);
});

test("RosterClient rejects incompatible response versions", async () => {
  const client = new RosterClient({
    baseUrl: "http://roster.test",
    fetch: async () => Response.json({ schema: "roster.coding.v1", runs: [] }),
  });

  await assert.rejects(client.listRuns(), (error: unknown) =>
    error instanceof RosterApiError && error.message.includes("Unsupported Roster API version"));
});

test("RosterClient preserves server errors", async () => {
  const client = new RosterClient({
    baseUrl: "http://roster.test",
    fetch: async () => Response.json({ error: "run is terminal" }, { status: 409 }),
  });

  await assert.rejects(client.abort("run-1"), (error: unknown) =>
    error instanceof RosterApiError && error.status === 409 && error.message === "run is terminal");
});
