import assert from "node:assert/strict";
import test from "node:test";

import { createRuntime } from "../../src/core/runtime.ts";
import { memoryBranchStore, memoryStore } from "../../src/adapters/memory-store.ts";
import { receipt, verify } from "../../src/core/chain.ts";

test("runtime: emit eventId is idempotent and expectedPrev is enforced", async () => {
    type Event = { readonly type: "note"; readonly runId: string; readonly text: string };
    type Cmd = {
      readonly type: "emit";
      readonly event: Event;
      readonly eventId: string;
      readonly expectedPrev?: string;
    };

    const runtime = createRuntime<Cmd, Event, { count: number }>(
      memoryStore<Event>(),
      memoryBranchStore(),
      (cmd) => [cmd.event],
      (state) => ({ count: state.count + 1 }),
      { count: 0 }
    );

    await runtime.execute("demo", {
      type: "emit",
      event: { type: "note", runId: "r1", text: "hello" },
      eventId: "evt-1",
    });
    await runtime.execute("demo", {
      type: "emit",
      event: { type: "note", runId: "r1", text: "hello duplicate" },
      eventId: "evt-1",
    });

    const chain = await runtime.chain("demo");
    assert.equal(chain.length, 1, "duplicate eventId should not append");

    await assert.rejects(
      runtime.execute("demo", {
        type: "emit",
        event: { type: "note", runId: "r1", text: "bad prev" },
        eventId: "evt-2",
        expectedPrev: "not-the-head",
      }),
      /Expected prev hash/
    );
});

test("runtime: an empty expectedPrev compare-and-swap protects a genesis append", async () => {
  type Event = { readonly type: "note"; readonly text: string };
  type Cmd = {
    readonly type: "emit";
    readonly event: Event;
    readonly eventId: string;
    readonly expectedPrev?: string;
  };
  const runtime = createRuntime<Cmd, Event, { count: number }>(
    memoryStore<Event>(),
    memoryBranchStore(),
    (cmd) => [cmd.event],
    (state) => ({ count: state.count + 1 }),
    { count: 0 },
  );

  await runtime.execute("genesis", {
    type: "emit",
    event: { type: "note", text: "first" },
    eventId: "first",
    expectedPrev: "",
  });
  await assert.rejects(runtime.execute("genesis", {
    type: "emit",
    event: { type: "note", text: "stale" },
    eventId: "stale",
    expectedPrev: "",
  }), /Expected prev hash <genesis>/);
  assert.equal((await runtime.chain("genesis")).length, 1);
});

test("runtime: branch metadata preserves nested hierarchy", async () => {
    type Cmd = { readonly type: "inc"; readonly seq: number };
    type Event = Cmd;
    const branches = memoryBranchStore();
    const runtime = createRuntime<Cmd, Event, { count: number }>(
      memoryStore<Event>(),
      branches,
      (cmd) => [cmd],
      (state) => ({ count: state.count + 1 }),
      { count: 0 }
    );

    await runtime.execute("root", { type: "inc", seq: 1 });
    await runtime.execute("root", { type: "inc", seq: 2 });
    await runtime.fork("root", 2, "root/branches/a");
    await runtime.fork("root/branches/a", 2, "root/branches/a/branches/b");

    const listed = await runtime.branches();
    assert.ok(listed.some((b) => b.name === "root/branches/a"));
    assert.ok(listed.some((b) => b.name === "root/branches/a/branches/b"));
    assert.deepEqual((await branches.children("root")).map((branch) => branch.name), ["root/branches/a"]);
    assert.deepEqual(
      (await branches.children("root/branches/a")).map((branch) => branch.name),
      ["root/branches/a/branches/b"]
    );
});

test("runtime: hash-chain verification detects a tampered receipt", async () => {
  type Event = { readonly type: "ok"; readonly seq: number };
  const stream = "tamper-check";
  const store = memoryStore<Event>();
  const first = receipt(stream, undefined, { type: "ok", seq: 1 }, 1);
  const second = receipt(stream, first.hash, { type: "ok", seq: 2 }, 2);
  await store.append(first);
  await store.append({ ...second, hash: "tampered" });

  const result = verify(await store.read(stream));
  assert.equal(result.ok, false);
  assert.equal(result.at, 1);
  assert.match(result.reason ?? "", /hash/i);
});
