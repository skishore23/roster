import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";

import { createRuntime } from "../../src/core/runtime.ts";
import { receipt } from "../../src/core/chain.ts";
import { memoryBranchStore, memoryStore } from "../../src/adapters/memory-store.ts";

type PerfEvent = { readonly type: "tick"; readonly seq: number };
type PerfCmd = {
  readonly type: "emit";
  readonly event: PerfEvent;
  readonly eventId: string;
};

const nowMs = (): number => performance.now();

test("perf: receipt store handles 100k receipts with bounded latencies", { timeout: 240_000 }, async () => {
    const store = memoryStore<PerfEvent>();
    const runtime = createRuntime<PerfCmd, PerfEvent, { readonly count: number }>(
      store,
      memoryBranchStore(),
      (cmd) => [cmd.event],
      (state) => ({ count: state.count + 1 }),
      { count: 0 }
    );

    const stream = "perf";
    const total = 100_000;
    let prev: string | undefined;
    for (let i = 0; i < total; i += 1) {
      const r = receipt(stream, prev, { type: "tick", seq: i }, Date.now() + i);
      await store.append(r);
      prev = r.hash;
    }

    const headStart = nowMs();
    const head = await store.head(stream);
    const headMs = nowMs() - headStart;

    const countStart = nowMs();
    const count = await store.count(stream);
    const countMs = nowMs() - countStart;

    const stateStart = nowMs();
    const state = await runtime.state(stream);
    const stateMs = nowMs() - stateStart;

    assert.ok(head, "head should exist");
    assert.equal(count, total, "count mismatch");
    assert.equal(state.count, total, "fold mismatch");

    // Guard against accidental quadratic scans in the in-process test adapter.
    assert.ok(headMs < 10, `head latency too high: ${headMs.toFixed(2)}ms`);
    assert.ok(countMs < 10, `count latency too high: ${countMs.toFixed(2)}ms`);
    assert.ok(stateMs < 2000, `state fold latency too high: ${stateMs.toFixed(2)}ms`);
});
