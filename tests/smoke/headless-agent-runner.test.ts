import assert from "node:assert/strict";
import test from "node:test";

import { memoryBranchStore, memoryStore } from "../../src/adapters/memory-store.ts";
import {
  runHeadlessAgent,
  selectHeadlessAgentSeedType,
  type HeadlessAgentEvent,
} from "../../src/framework/headless-agent-runner.ts";
import type { HeadlessAgentSpec } from "../../src/framework/agent-types.ts";
import { receipt } from "../../src/sdk/receipt.ts";

const specWith = (...receiptTypes: ReadonlyArray<string>): HeadlessAgentSpec => ({
  id: "headless-test",
  version: "1.0.0",
  receipts: Object.fromEntries(receiptTypes.map((type) => [type, receipt<Record<string, unknown>>() ])),
  view: ({ on }) => ({ seeded: receiptTypes.some((type) => on(type).exists()) }),
  actions: () => [],
  goal: ({ view }) => Boolean((view as { readonly seeded: boolean }).seeded),
});

test("headless runner selects one shared seed convention", () => {
  assert.equal(selectHeadlessAgentSeedType(specWith("prompt.received")), "prompt.received");
  assert.equal(
    selectHeadlessAgentSeedType(specWith("prompt.received", "task.requested")),
    "task.requested",
  );
  assert.throws(
    () => selectHeadlessAgentSeedType(specWith("custom.started")),
    /must declare task\.requested or prompt\.received/,
  );
});

test("headless runner seeds and executes a spec with explicit stream identity", async () => {
  const store = memoryStore<HeadlessAgentEvent>();
  const result = await runHeadlessAgent({
    spec: specWith("task.requested"),
    problem: "prove it",
    store,
    branchStore: memoryBranchStore(),
    runId: "run-fixed",
    stream: "agents/custom",
    runStream: "custom/run-stream",
    now: () => 100,
  });

  assert.deepEqual(result, {
    runId: "run-fixed",
    stream: "agents/custom",
    runStream: "custom/run-stream",
  });
  const events = (await store.read(result.runStream)).map((entry) => entry.body);
  assert.deepEqual(events.map((event) => event.type), [
    "task.requested",
    "run.started",
    "goal.completed",
    "run.completed",
  ]);
  assert.equal(events[0]?.prompt, "prove it");
});
