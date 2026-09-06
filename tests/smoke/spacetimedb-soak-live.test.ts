import assert from "node:assert/strict";
import test from "node:test";

import {
  SPACETIMEDB_SOAK_EVIDENCE_SCHEMA,
  runSpacetimeSoak,
} from "../../src/evals/spacetimedb-soak.ts";

const enabled = Boolean(process.env.SPACETIMEDB_URI && process.env.SPACETIMEDB_DATABASE);

test("SpacetimeDB scale canary sustains events, reconnects, and recovers a crashed worker", {
  skip: !enabled,
  timeout: 30_000,
}, async () => {
  const evidence = await runSpacetimeSoak({
    ...(process.env.ROSTER_WORKSPACE_ID ? { workspaceId: process.env.ROSTER_WORKSPACE_ID } : {}),
    eventCount: 40,
    providerCallCount: 2,
    eventP95Ms: 1_000,
    reconnectP95Ms: 8_000,
    workerRecoveryP95Ms: 10_000,
    providerP95Ms: 1_000,
    providerProbe: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  });

  assert.equal(evidence.schema, SPACETIMEDB_SOAK_EVIDENCE_SCHEMA);
  assert.equal(evidence.passed, true, evidence.violations.join("; "));
  assert.equal(evidence.recoveredEventCount, 40);
  assert.equal(evidence.workerRecovery.completed, true);
  assert.notEqual(evidence.workerRecovery.firstFence, evidence.workerRecovery.replacementFence);
  assert.ok((evidence.providerLatencyMs?.p95 ?? Number.POSITIVE_INFINITY) < 1_000);
});
