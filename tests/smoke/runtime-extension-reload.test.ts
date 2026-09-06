import assert from "node:assert/strict";
import test from "node:test";

import {
  defineRuntimeService,
  type RuntimeExtensionDefinition,
} from "../../src/engine/runtime/runtime-extension.ts";
import { RuntimeExtensionHost } from "../../src/engine/runtime/runtime-extension-host.ts";
import {
  RuntimeExtensionReloadAdapter,
  type RuntimeExtensionReloadOutcome,
  type RuntimeExtensionReloadScheduler,
} from "../../src/engine/runtime/runtime-extension-reload.ts";

class ManualReloadScheduler implements RuntimeExtensionReloadScheduler {
  readonly #callbacks = new Map<number, () => void>();
  #sequence = 0;

  setTimeout(callback: () => void, _delayMs: number): unknown {
    this.#sequence += 1;
    this.#callbacks.set(this.#sequence, callback);
    return this.#sequence;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#callbacks.delete(handle);
  }

  flush(): void {
    const callbacks = [...this.#callbacks.entries()].sort(([left], [right]) => left - right);
    this.#callbacks.clear();
    for (const [, callback] of callbacks) callback();
  }

  size(): number {
    return this.#callbacks.size;
  }
}

const VALUE = defineRuntimeService<{ readonly read: () => string }>("reload.value", "1");

const valueExtension = (
  version: string,
  value: string,
  activations: string[] = [],
): RuntimeExtensionDefinition => ({
  id: "value",
  version,
  provides: [VALUE],
  activate: ({ provide }) => {
    activations.push(version);
    provide(VALUE, { read: () => value });
  },
});

test("reload bursts debounce to the newest immutable candidate and report supersession", async () => {
  const host = new RuntimeExtensionHost();
  const scheduler = new ManualReloadScheduler();
  const observed: RuntimeExtensionReloadOutcome[] = [];
  const activations: string[] = [];
  const reload = new RuntimeExtensionReloadAdapter(host, {
    debounceMs: 10,
    maxPendingCandidates: 2,
    scheduler,
    onOutcome: (outcome) => { observed.push(outcome); },
  });

  const thirdDefinition = {
    id: "value",
    version: "3",
    provides: [VALUE],
    activate: ({ provide }: Parameters<RuntimeExtensionDefinition["activate"]>[0]) => {
      activations.push("3");
      provide(VALUE, { read: () => "third" });
    },
  };
  const first = reload.submit([valueExtension("1", "first", activations)]);
  const second = reload.submit([valueExtension("2", "second", activations)]);
  const third = reload.submit([thirdDefinition]);
  thirdDefinition.version = "mutated-after-submit";
  thirdDefinition.activate = () => { throw new Error("mutated closure must not run"); };

  assert.equal(scheduler.size(), 1);
  scheduler.flush();
  const [firstOutcome, secondOutcome, thirdOutcome] = await Promise.all([first, second, third]);

  assert.equal(firstOutcome.status, "superseded");
  assert.equal(firstOutcome.supersededBy, thirdOutcome.requestId);
  assert.equal(secondOutcome.status, "superseded");
  assert.equal(secondOutcome.supersededBy, thirdOutcome.requestId);
  assert.equal(thirdOutcome.status, "applied");
  assert.deepEqual(activations, ["3"]);
  assert.equal(host.view({ scopeId: "reload-test" }).get(VALUE).read(), "third");
  assert.deepEqual(observed.map(({ status }) => status).sort(), [
    "applied",
    "superseded",
    "superseded",
  ]);
  await reload.close();
});

test("reload reconciliation is serialized while newer submissions coalesce", async () => {
  const host = new RuntimeExtensionHost();
  const scheduler = new ManualReloadScheduler();
  const events: string[] = [];
  const reload = new RuntimeExtensionReloadAdapter(host, { debounceMs: 10, scheduler });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const first = reload.submit([{
    id: "value",
    version: "1",
    provides: [VALUE],
    activate: async ({ provide }) => {
      events.push("start:1");
      await gate;
      events.push("finish:1");
      provide(VALUE, { read: () => "one" });
    },
  }]);
  scheduler.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = reload.submit([valueExtension("2", "two", events)]);
  const third = reload.submit([valueExtension("3", "three", events)]);
  assert.equal(scheduler.size(), 0, "a second debounce does not run beside active reconciliation");

  release();
  assert.equal((await first).status, "applied");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(scheduler.size(), 1);
  scheduler.flush();
  const [secondOutcome, thirdOutcome] = await Promise.all([second, third]);

  assert.equal(secondOutcome.status, "superseded");
  assert.equal(thirdOutcome.status, "applied");
  assert.deepEqual(events, ["start:1", "finish:1", "3"]);
  assert.equal(host.view({ scopeId: "serialized" }).get(VALUE).read(), "three");
  await reload.close();
});

test("compile and activation failures are reported while the old generation remains committed", async () => {
  const host = new RuntimeExtensionHost();
  await host.reconcile([valueExtension("1", "stable")]);
  const stableGeneration = host.generation();
  const scheduler = new ManualReloadScheduler();
  const observed: RuntimeExtensionReloadOutcome[] = [];
  const reload = new RuntimeExtensionReloadAdapter(host, {
    debounceMs: 10,
    scheduler,
    onOutcome: async (outcome) => { observed.push(outcome); },
  });
  const missing = defineRuntimeService("reload.missing", "1");

  const compileFailure = reload.submit([{
    id: "invalid",
    version: "1",
    requires: [missing],
    activate: () => {},
  }]);
  scheduler.flush();
  const compileOutcome = await compileFailure;
  assert.equal(compileOutcome.status, "failed");
  assert.match(String(compileOutcome.error), /requires missing service reload.missing@1/);
  assert.equal(host.generation(), stableGeneration);

  await new Promise<void>((resolve) => setImmediate(resolve));
  const activationFailure = reload.submit([{
    id: "value",
    version: "2",
    provides: [VALUE],
    activate: () => { throw new Error("candidate activation failed"); },
  }]);
  scheduler.flush();
  const activationOutcome = await activationFailure;
  assert.equal(activationOutcome.status, "failed");
  assert.match(String(activationOutcome.error), /candidate activation failed/);
  assert.equal(host.generation(), stableGeneration);
  assert.equal(host.view({ scopeId: "after-failures" }).get(VALUE).read(), "stable");
  assert.deepEqual(observed.map(({ status }) => status), ["failed", "failed"]);
  await reload.close();
});

test("close cancels pending candidates, waits for reporting, and rejects later reload work", async () => {
  const host = new RuntimeExtensionHost();
  const scheduler = new ManualReloadScheduler();
  const observed: string[] = [];
  const reload = new RuntimeExtensionReloadAdapter(host, {
    debounceMs: 10,
    scheduler,
    onOutcome: async (outcome) => {
      await Promise.resolve();
      observed.push(`${outcome.requestId}:${outcome.status}`);
    },
  });

  const pending = reload.submit([valueExtension("1", "never")]);
  assert.equal(scheduler.size(), 1);
  await reload.close();
  assert.equal((await pending).status, "closed");
  assert.equal(scheduler.size(), 0);
  assert.deepEqual(host.view({ scopeId: "closed" }).services, []);

  const afterClose = await reload.submit([valueExtension("2", "also-never")]);
  assert.equal(afterClose.status, "closed");
  await reload.close();
  assert.deepEqual(observed.map((entry) => entry.split(":")[1]), ["closed", "closed"]);
});

test("reload bounds reject unsafe debounce and pending candidate limits", () => {
  const host = new RuntimeExtensionHost();
  assert.throws(() => new RuntimeExtensionReloadAdapter(host, { debounceMs: 0 }), /debounceMs/);
  assert.throws(
    () => new RuntimeExtensionReloadAdapter(host, { maxPendingCandidates: 257 }),
    /maxPendingCandidates/,
  );
});
