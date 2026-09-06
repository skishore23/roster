import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyDurableRosterRestart } from "../../src/simulations/durable-roster-restart.ts";

const enabled = Boolean(process.env.SPACETIMEDB_URI && process.env.SPACETIMEDB_DATABASE);

test("Roster platform recovers its dynamic DAG, values, and shared context after process loss", {
  skip: !enabled,
  timeout: 30_000,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const directory = await mkdtemp(join(tmpdir(), "roster-platform-restart-"));
  try {
    const evidence = await verifyDurableRosterRestart({
      workspaceId: `verification/roster-platform-restart/${suffix}`,
      runId: `roster-platform-restart-${suffix}`,
      namespace: `roster-platform-restart:${suffix}`,
      directory,
    });
    assert.equal(evidence.reconnected, true);
    assert.equal(evidence.graphRecovered, true);
    assert.equal(evidence.valuesRecovered, true);
    assert.equal(evidence.workspaceRecovered, true);
    assert.equal(evidence.staleFenceRejected, true);
    assert.equal(evidence.exactReducerReplay, true);
    assert.deepEqual(evidence.executionCounts, {
      compose: 1,
      produce: 1,
      root: 1,
    });
    assert.match(evidence.graphDigest, /^[a-f0-9]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
