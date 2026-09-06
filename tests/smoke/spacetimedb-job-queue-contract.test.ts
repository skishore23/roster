import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const read = (name: string): Promise<string> => fs.readFile(path.join(ROOT, name), "utf8");

test("generic agent work is leased transactionally by SpacetimeDB", async () => {
  const moduleSource = await read("spacetimedb/src/index.ts");
  const adapterSource = await read("src/adapters/spacetimedb-job-queue.ts");
  const serverSource = await read("src/server.ts");

  for (const table of [
    "roster_job",
    "roster_job_command",
    "roster_job_event",
    "roster_job_request",
    "roster_workspace_usage",
  ]) {
    assert.match(moduleSource, new RegExp(`name: ["']${table}["']`));
  }
  for (const reducer of [
    "enqueueRosterJob",
    "claimNextRosterJob",
    "heartbeatRosterJob",
    "completeRosterJob",
    "failRosterJob",
    "cancelRosterJob",
    "queueRosterJobCommand",
    "reconcileTerminalRosterJobCommands",
    "consumeRosterJobCommands",
    "expireRosterJobLease",
  ]) {
    assert.match(moduleSource, new RegExp(`export const ${reducer}`));
  }
  assert.match(moduleSource, /leaseFence: fence/);
  assert.match(moduleSource, /job\.leaseFence !== fence/);
  assert.match(moduleSource, /rosterJobLeaseExpiry\.insert/);
  assert.match(moduleSource, /appendRosterJobEvent/);
  assert.match(moduleSource, /continuationPending/);
  assert.match(moduleSource, /const willRetry = args\.retryable && job\.attempt < job\.maxAttempts/);
  assert.doesNotMatch(moduleSource, /args\.retryable \|\| continuationPending/);
  assert.match(moduleSource, /command\.command === "steer" \|\| command\.command === "follow_up"/);
  assert.match(moduleSource, /supersedeTerminalRosterJobCommand/);
  assert.match(moduleSource, /job reached its terminal boundary before command delivery/);
  assert.match(moduleSource, /targetRunId: ""/);
  assert.match(moduleSource, /queue\.command\.superseded/);
  assert.match(moduleSource, /name: "my_roster_job_events", public: true/);
  assert.match(moduleSource, /name: "my_workspace_usage", public: true/);
  assert.match(moduleSource, /MAX_ACTIVE_JOBS_PER_WORKSPACE = 12/);
  assert.match(moduleSource, /MAX_JOBS_PER_WORKSPACE_WINDOW = 250/);
  assert.match(moduleSource, /admitWorkspaceJob\(ctx, workspaceId\)/);
  assert.match(moduleSource, /releaseWorkspaceJob\(ctx, args\.workspaceId\)/);
  assert.match(moduleSource, /active job accounting underflow/);

  assert.match(adapterSource, /control\.claimNextRosterJob/);
  assert.match(adapterSource, /current\.leaseFence/);
  assert.doesNotMatch(adapterSource, /readFile|writeFile/i);
  assert.match(serverSource, /createSpacetimeJobQueue/);
  assert.doesNotMatch(serverSource, /receiptQueue/);
});

test("workspace-node graph expansion remains bounded rather than recursively unbounded", async () => {
  const moduleSource = await read("spacetimedb/src/index.ts");
  const expansion = moduleSource.slice(
    moduleSource.indexOf("export const expandAndDelegateRosterTask"),
    moduleSource.indexOf("export const claimRosterTask"),
  );

  assert.match(expansion, /requireActiveRosterTaskLease/);
  assert.match(expansion, /args\.fence/);
  assert.match(expansion, /policy\.maxFanout/);
  assert.match(expansion, /policy\.maxDepth/);
  assert.match(expansion, /policy\.maxTasks/);
  assert.match(expansion, /dependency cycle or missing dependency/);
  assert.match(expansion, /rosterWorkerCanRunTask/);
});
