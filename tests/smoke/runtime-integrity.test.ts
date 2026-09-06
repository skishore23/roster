import assert from "node:assert/strict";
import test from "node:test";

import { memoryBranchStore, memoryStore } from "../../src/adapters/memory-store.ts";
import { receipt } from "../../src/core/chain.ts";
import { createRuntime } from "../../src/core/runtime.ts";

type CounterCmd = {
  readonly type: "counter.inc";
  readonly seq: number;
};

type CounterEvent = CounterCmd;

type CounterState = {
  readonly count: number;
};

const runtimeFor = (
  store = memoryStore<CounterEvent>(),
  branches = memoryBranchStore()
) => createRuntime<CounterCmd, CounterEvent, CounterState>(
  store,
  branches,
  (cmd) => [cmd],
  (state) => ({ count: state.count + 1 }),
  { count: 0 }
);

test("smoke: single-stream concurrent writes preserve integrity", { timeout: 120_000 }, async () => {
  const runtime = runtimeFor();
  const stream = "integrity";
  const writes = 200;

  await Promise.all(
    Array.from({ length: writes }, (_unused, seq) =>
      runtime.execute(stream, { type: "counter.inc", seq })
    )
  );

  const chain = await runtime.chain(stream);
  assert.equal(chain.length, writes, "unexpected receipt count");
  assert.equal((await runtime.verify(stream)).ok, true);
});

test("smoke: multiple runtime instances preserve shared-stream integrity", { timeout: 120_000 }, async () => {
  const stream = "integrity/multi-runtime";
  const writers = 8;
  const writesPerWriter = 25;
  const store = memoryStore<CounterEvent>();
  const branches = memoryBranchStore();
  const runtimes = Array.from({ length: writers }, () => runtimeFor(store, branches));

  await Promise.all(
    runtimes.flatMap((runtime, writer) =>
      Array.from({ length: writesPerWriter }, (_unused, localSeq) =>
        runtime.execute(stream, {
          type: "counter.inc",
          seq: writer * writesPerWriter + localSeq,
        })
      )
    )
  );

  const verifier = runtimeFor(store, branches);
  const chain = await verifier.chain(stream);
  assert.equal(chain.length, writers * writesPerWriter, "unexpected receipt count");
  assert.equal(new Set(chain.map((entry) => entry.body.seq)).size, writers * writesPerWriter);
  assert.equal((await verifier.verify(stream)).ok, true);
});

test("smoke: concurrent direct receipt appends retain every unique row", { timeout: 120_000 }, async () => {
  const stream = "integrity/direct-append";
  const writers = 10;
  const writesPerWriter = 30;
  const store = memoryStore<CounterEvent>();

  await Promise.all(
    Array.from({ length: writers }, (_unused, writer) =>
      Promise.all(
        Array.from({ length: writesPerWriter }, (_unusedSeq, localSeq) =>
          store.append(receipt(stream, undefined, {
            type: "counter.inc",
            seq: writer * writesPerWriter + localSeq,
          }))
        )
      )
    )
  );

  const chain = await store.read(stream);
  assert.equal(chain.length, writers * writesPerWriter, "unexpected direct append count");
  assert.equal(new Set(chain.map((entry) => entry.body.seq)).size, writers * writesPerWriter);
});

test("smoke: concurrent branch metadata saves preserve hierarchy and completeness", { timeout: 120_000 }, async () => {
  const writers = 20;
  const branches = memoryBranchStore();

  await Promise.all(
    Array.from({ length: writers }, (_unused, index) =>
      branches.save({
        name: `root/branch-${index}`,
        parent: "root",
        forkAt: index,
        createdAt: Date.now() + index,
      })
    )
  );

  assert.equal((await branches.list()).length, writers, "unexpected branch metadata count");
  assert.equal((await branches.children("root")).length, writers, "unexpected child branch count");
});
