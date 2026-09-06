import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 5_000);

  await exitPromise;
  clearTimeout(killTimer);
};

test("framework routes: status parity for core endpoints", spacetimeTestOptions(120_000), async () => {
  const port = await getFreePort();
  const dataDir = await createTempDir("receipt-framework-routes");
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      OPENAI_API_KEY: "",
      SPACETIMEDB_TOKEN: "",
      SPACETIMEDB_TOKEN_PATH: path.join(dataDir, "spacetimedb-service.token"),
      ROSTER_WORKSPACE_ID: `test/framework-${port}`,
      IMPROVEMENT_VALIDATE_COMMAND_JSON: JSON.stringify([process.execPath, "-e", "process.exit(0)"]),
      IMPROVEMENT_HARNESS_COMMAND_JSON: JSON.stringify([process.execPath, "-e", "process.exit(0)"]),
      IMPROVEMENT_PREPARE_DEPENDENCIES: "0",
      IMPROVEMENT_AUTHORITY_TOKENS_JSON: JSON.stringify({
        "independent-verifier": "test-verifier-token-0001",
        "canary-operator": "test-canary-token-0001",
        "independent-promoter": "test-promoter-token-0001",
        "rollback-operator": "test-rollback-token-0001",
      }),
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
    const notFound = await fetch(`${base}/not-real`);
    assert.equal(notFound.status, 404);
    assert.equal(await notFound.text(), "Not found");

    const home = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /Roster Lab — A safe place for your AI to make mistakes/);
    assert.match(homeHtml, /Let your AI make mistakes/);
    assert.match(homeHtml, /data-world-engine/);
    assert.match(homeHtml, /prefers-reduced-motion/);

    const removedTodo = await fetch(`${base}/todo`);
    assert.equal(removedTodo.status, 404);

    const theoremBad = await fetch(`${base}/theorem/run?stream=theorem`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(theoremBad.status, 400);
    assert.equal(await theoremBad.text(), "problem required");

    const writerBad = await fetch(`${base}/writer/run?stream=writer`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(writerBad.status, 400);
    assert.equal(await writerBad.text(), "problem required");

    const axiomSimplePage = await fetch(`${base}/axiom-simple?stream=${encodeURIComponent("agents/axiom-simple")}`);
    assert.equal(axiomSimplePage.status, 200);

    const axiomSimpleBad = await fetch(`${base}/axiom-simple/run?stream=${encodeURIComponent("agents/axiom-simple")}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(axiomSimpleBad.status, 400);
    assert.equal(await axiomSimpleBad.text(), "problem required");

    const agentRemoved = await fetch(`${base}/autopilot?stream=agent`);
    assert.equal(agentRemoved.status, 404);

    const monitorPage = await fetch(`${base}/monitor?stream=agent`);
    assert.equal(monitorPage.status, 200);
    const monitorHtml = await monitorPage.text();
    assert.match(monitorHtml, /General Agent/);
    assert.match(monitorHtml, /Adaptive Proof/);
    assert.match(monitorHtml, /A proof team debates and verifies/);
    assert.match(monitorHtml, /Verified Proof/);
    assert.match(monitorHtml, /A proof team with formal verification/);
    assert.match(monitorHtml, /Proof Swarm/);
    assert.match(monitorHtml, /Independent proof strategies converge/);
    assert.match(monitorHtml, /Roster - Lobby/);
    assert.match(monitorHtml, /data-slot="agent-page-header"/);
    assert.match(monitorHtml, /<h1>Your rooms<\/h1>/);
    assert.match(monitorHtml, /id="room-directory-title">Your rooms<\/h2>/);
    assert.match(monitorHtml, /#adaptive-proof/);
    assert.match(monitorHtml, /data-agent-tab="overview"><span>Rooms<\/span>/);
    assert.match(monitorHtml, /data-slot="agent-replay"/);
    assert.match(monitorHtml, /id="monitor-replay"/);
    assert.doesNotMatch(monitorHtml, /data-agent-tab="replay"/);
    assert.match(monitorHtml, /id="monitor-tabs"[^>]*data-agent-tabs/);
    assert.match(monitorHtml, /Decision history/);

    const monitorBad = await fetch(`${base}/monitor/run?stream=agent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(monitorBad.status, 400);
    assert.equal(await monitorBad.text(), "problem required");

    const axiomBad = await fetch(`${base}/axiom/run?stream=axiom`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(axiomBad.status, 400);
    assert.equal(await axiomBad.text(), "problem required");

    const enqueue = await fetch(`${base}/agents/writer/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          kind: "writer.run",
          stream: "writer",
          runId: `route_${Date.now()}`,
          problem: "Test",
          config: { maxParallel: 1 },
        },
      }),
    });
    assert.equal(enqueue.status, 202);
    const queued = await enqueue.json() as { job?: { id?: string } };
    assert.ok(queued.job?.id, "expected job id");

    const agentEnqueue = await fetch(`${base}/agents/agent/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          kind: "agent.run",
          stream: "agent",
          runId: `route_${Date.now()}`,
          problem: "List src files and summarize.",
          config: { maxIterations: 2, maxToolOutputChars: 1200, memoryScope: "agent", workspace: "." },
        },
      }),
    });
    assert.equal(agentEnqueue.status, 202);
    const agentQueued = await agentEnqueue.json() as { job?: { id?: string } };
    assert.ok(agentQueued.job?.id, "expected agent job id");

    const steerCmd = await fetch(`${base}/monitor/job/${encodeURIComponent(agentQueued.job.id!)}/steer?stream=agent&job=${encodeURIComponent(agentQueued.job.id!)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "fetch",
      },
      body: "problem=Retarget+scope",
    });
    const steerBody = await steerCmd.text();
    assert.equal(steerCmd.status, 202, `${steerBody}\n${stderr}`);

    const followUpCmd = await fetch(`${base}/monitor/job/${encodeURIComponent(agentQueued.job.id!)}/follow-up?stream=agent&job=${encodeURIComponent(agentQueued.job.id!)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "fetch",
      },
      body: "note=Add+validation",
    });
    const followUpBody = await followUpCmd.text();
    assert.equal(followUpCmd.status, 202, followUpBody);

    const abortCmd = await fetch(`${base}/monitor/job/${encodeURIComponent(agentQueued.job.id!)}/abort?stream=agent&job=${encodeURIComponent(agentQueued.job.id!)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "fetch",
      },
      body: "reason=route+test",
    });
    const abortBody = await abortCmd.text();
    assert.equal(abortCmd.status, 202, abortBody);

    const jobStatus = await fetch(`${base}/jobs/${encodeURIComponent(queued.job!.id!)}`);
    assert.equal(jobStatus.status, 200);

    const memCommit = await fetch(`${base}/memory/test/commit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Roster-Memory-Authority": "commit",
      },
      body: JSON.stringify({ text: "remember this event", tags: ["test"] }),
    });
    assert.equal(memCommit.status, 201);
    const committed = await memCommit.json() as {
      readonly entry?: { readonly id?: string; readonly contentHash?: string };
    };
    assert.ok(committed.entry?.id);
    assert.ok(committed.entry?.contentHash);

    const memSearch = await fetch(`${base}/memory/test/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "remember" }),
    });
    assert.equal(memSearch.status, 200);

    const memoryProposal = await fetch(`${base}/memory/test/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Use handle-first retrieval for older room context.",
        tags: ["memory", "architecture"],
        proposedBy: "api-agent",
        sourceReferences: [{
          sourceId: committed.entry.id,
          contentHash: committed.entry.contentHash,
          kind: "memory",
        }],
      }),
    });
    assert.equal(memoryProposal.status, 202);
    const proposed = await memoryProposal.json() as {
      readonly proposal?: { readonly proposalId?: string; readonly status?: string };
    };
    assert.ok(proposed.proposal?.proposalId);
    assert.equal(proposed.proposal?.status, "pending");

    const pendingMemory = await fetch(`${base}/memory/test/proposals?status=pending`);
    assert.equal(pendingMemory.status, 200);
    const pendingMemoryJson = await pendingMemory.json() as {
      readonly proposals?: ReadonlyArray<{ readonly proposalId?: string }>;
    };
    assert.deepEqual(
      pendingMemoryJson.proposals?.map((proposal) => proposal.proposalId),
      [proposed.proposal.proposalId],
    );

    const unauthorizedAccept = await fetch(
      `${base}/memory/test/proposals/${encodeURIComponent(proposed.proposal.proposalId!)}/accept`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decidedBy: "api-operator" }),
      },
    );
    assert.equal(unauthorizedAccept.status, 403);

    const acceptedMemory = await fetch(
      `${base}/memory/test/proposals/${encodeURIComponent(proposed.proposal.proposalId!)}/accept`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Roster-Memory-Authority": "decide",
        },
        body: JSON.stringify({ decidedBy: "api-operator" }),
      },
    );
    assert.equal(acceptedMemory.status, 200);
    const acceptedMemoryJson = await acceptedMemory.json() as {
      readonly entry?: { readonly id?: string; readonly acceptedBy?: string };
    };
    assert.ok(acceptedMemoryJson.entry?.id);
    assert.equal(acceptedMemoryJson.entry?.acceptedBy, "api-operator");

    const openedMemory = await fetch(`${base}/memory/test/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [acceptedMemoryJson.entry.id] }),
    });
    assert.equal(openedMemory.status, 200);
    const openedMemoryJson = await openedMemory.json() as {
      readonly entries?: ReadonlyArray<{ readonly id?: string }>;
    };
    assert.deepEqual(
      openedMemoryJson.entries?.map((entry) => entry.id),
      [acceptedMemoryJson.entry.id],
    );

    const memoryScopes = await fetch(`${base}/memory/scopes`);
    assert.equal(memoryScopes.status, 200);
    assert.deepEqual(
      (await memoryScopes.json() as { readonly scopes?: ReadonlyArray<string> }).scopes,
      ["test"],
    );

    const removedImprovementConsole = await fetch(`${base}/improvements`);
    assert.equal(removedImprovementConsole.status, 404);

    const proposal = await fetch(`${base}/improvement/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        artifactType: "prompt_patch",
        target: "prompts/theorem.prompts.json",
        patch: "{\"note\":\"safe\"}",
        createdBy: "proposal-author",
      }),
    });
    assert.equal(proposal.status, 201);
    const proposalJson = await proposal.json() as { proposalId?: string; recordId?: string };
    assert.ok(proposalJson.proposalId, "expected proposalId");
    assert.ok(proposalJson.recordId, "expected initial rollout recordId");

    const validate = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        validatedBy: "independent-verifier",
        authorizationToken: "test-verifier-token-0001",
        expectedRecordId: proposalJson.recordId,
      }),
    });
    assert.equal(validate.status, 200);
    const validateJson = await validate.json() as { recordId?: string };
    assert.ok(validateJson.recordId, "expected verification rollout recordId");

    const staleValidate = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        validatedBy: "independent-verifier",
        authorizationToken: "test-verifier-token-0001",
        expectedRecordId: proposalJson.recordId,
      }),
    });
    assert.equal(staleValidate.status, 409);

    const dependentCanary = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        canaryBy: "independent-verifier",
        authorizationToken: "test-verifier-token-0001",
        expectedRecordId: validateJson.recordId,
      }),
    });
    assert.equal(dependentCanary.status, 409);

    const approve = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        canaryBy: "canary-operator",
        authorizationToken: "test-canary-token-0001",
        expectedRecordId: validateJson.recordId,
      }),
    });
    assert.equal(approve.status, 200);
    const approveJson = await approve.json() as { recordId?: string };
    assert.ok(approveJson.recordId, "expected canary rollout recordId");

    const dependentPromotion = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appliedBy: "canary-operator",
        authorizationToken: "test-canary-token-0001",
        expectedRecordId: approveJson.recordId,
      }),
    });
    assert.equal(dependentPromotion.status, 409);

    const apply = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appliedBy: "independent-promoter",
        authorizationToken: "test-promoter-token-0001",
        expectedRecordId: approveJson.recordId,
      }),
    });
    assert.equal(apply.status, 200);
    const applyJson = await apply.json() as { recordId?: string };
    assert.ok(applyJson.recordId, "expected promotion rollout recordId");

    const activeImprovementRuntime = await fetch(`${base}/improvement/runtime`);
    assert.equal(activeImprovementRuntime.status, 200);
    const activeImprovementJson = await activeImprovementRuntime.json() as {
      readonly generationId?: string;
      readonly snapshotHash?: string;
      readonly improvements?: ReadonlyArray<unknown>;
    };
    assert.match(activeImprovementJson.generationId ?? "", /^runtime_generation_/);
    assert.match(activeImprovementJson.snapshotHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(activeImprovementJson.improvements?.length, 1);

    const inspectAudit = await fetch(`${base}/monitor?tab=inspect`);
    assert.equal(inspectAudit.status, 200);
    const inspectAuditHtml = await inspectAudit.text();
    assert.match(inspectAuditHtml, /Self-improvement audit/);
    assert.match(inspectAuditHtml, new RegExp(proposalJson.proposalId!));
    assert.match(inspectAuditHtml, /promoted/i);

    const dependentRollback = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revertedBy: "independent-promoter",
        authorizationToken: "test-promoter-token-0001",
        reason: "promotion authority cannot roll back its own deployment",
        expectedRecordId: applyJson.recordId,
      }),
    });
    assert.equal(dependentRollback.status, 409);

    const revert = await fetch(`${base}/improvement/${encodeURIComponent(proposalJson.proposalId!)}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revertedBy: "rollback-operator",
        authorizationToken: "test-rollback-token-0001",
        reason: "test rollback",
        expectedRecordId: applyJson.recordId,
      }),
    });
    assert.equal(revert.status, 200);
  } finally {
    await stopChild(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  assert.equal(stderr.includes("EADDRINUSE"), false, `server boot conflict: ${stderr}`);
});
