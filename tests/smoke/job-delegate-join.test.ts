import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";

import { spacetimeTestOptions } from "../support/spacetimedb-test.js";

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
      // server booting
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
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 5_000);

  await exitPromise;
  clearTimeout(killTimer);
};

const isTerminal = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

test("job worker: delegated follow-up does not stall parent when concurrency=1", spacetimeTestOptions(120_000), async () => {
  const port = await getFreePort();
  const workspaceId = `test/delegate-${randomUUID()}`;
  assert.match(workspaceId, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
  assert.ok(workspaceId.length <= 160, "workspace id must remain bounded");
  assert.notEqual(workspaceId, `test/delegate-${port}`);
  const dataDir = await createTempDir("receipt-job-delegate-join");
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      OPENAI_API_KEY: "",
      // A validation worker may carry the live control-plane identity. The
      // nested server must use a test-local identity or it can contend with
      // the supervising Roster worker for leases and livelock the SDK client.
      SPACETIMEDB_TOKEN: "",
      SPACETIMEDB_TOKEN_PATH: path.join(dataDir, "spacetimedb-service.token"),
      ROSTER_WORKSPACE_ID: workspaceId,
      JOB_CONCURRENCY: "1",
      JOB_POLL_MS: "1000",
      SUBJOB_WAIT_MS: "0",
      SUBJOB_JOIN_WAIT_MS: "10000",
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
    await waitForHttpOk(`${base}/`, 30_000);

    const runId = `delegate_${Date.now()}`;
    const enqueue = await fetch(`${base}/agents/theorem/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          kind: "theorem.run",
          stream: "theorem",
          runId,
          problem: "Prove x = x.",
          config: { rounds: 1, maxDepth: 1, memoryWindow: 20, branchThreshold: 2 },
        },
      }),
    });
    assert.equal(enqueue.status, 202);
    const queued = await enqueue.json() as { job?: { id?: string } };
    const parentJobId = queued.job?.id;
    assert.ok(parentJobId, "expected parent job id");

    const followUp = await fetch(`${base}/jobs/${encodeURIComponent(parentJobId!)}/follow-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          note: "Delegate a quick helper proof.",
          delegate_task: {
            task: "Show that 1 = 1.",
            agentId: "theorem",
          },
        },
      }),
    });
    assert.equal(followUp.status, 202);

    const parentWait = await fetch(`${base}/jobs/${encodeURIComponent(parentJobId!)}/wait?timeoutMs=20000`);
    assert.equal(parentWait.status, 200);
    const parentJob = await parentWait.json() as { status: string };
    assert.equal(parentJob.status, "failed");

    const deadline = Date.now() + 20_000;
    let subJobSeenTerminal = false;
    let lastJobs: Array<{ id: string; lane: string; status: string }> = [];
    while (Date.now() < deadline) {
      const jobsRes = await fetch(`${base}/jobs?limit=100`);
      assert.equal(jobsRes.status, 200);
      const jobsJson = await jobsRes.json() as { jobs: Array<{ id: string; lane: string; status: string }> };
      lastJobs = jobsJson.jobs;
      subJobSeenTerminal = jobsJson.jobs.some((job) =>
        job.id !== parentJobId
        && job.lane === "follow_up"
        && isTerminal(job.status)
      );
      if (subJobSeenTerminal) break;
      await sleep(250);
    }

    assert.equal(
      subJobSeenTerminal,
      true,
      `expected delegated follow-up job to reach terminal state; jobs=${JSON.stringify(lastJobs)}`
    );
  } finally {
    await stopChild(child);
    await fs.rm(dataDir, { recursive: true, force: true });
    if (stderr.trim().length > 0 && !/EADDRINUSE/.test(stderr)) {
      // keep stderr available when test fails unexpectedly
      console.error(stderr);
    }
  }
});
