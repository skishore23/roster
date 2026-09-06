import assert from "node:assert/strict";
import test from "node:test";

import {
  RosterFunctionDirectory,
  type RosterFunctionDescriptor,
} from "../../src/engine/functions/function-directory.ts";

const DESCRIPTOR: RosterFunctionDescriptor = {
  id: "lifecycle::inspect",
  version: "1",
  capability: "inspect",
  description: "Inspect one lifecycle value.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  effects: ["read"],
};

const SECOND_DESCRIPTOR: RosterFunctionDescriptor = {
  ...DESCRIPTOR,
  id: "lifecycle::second",
  description: "Inspect a second lifecycle value.",
};

const NODE = {
  id: "lifecycle-node",
  name: "Lifecycle Node",
  capabilities: ["inspect"],
  runtime: { kind: "roster-native" as const },
};

const access = {
  functionGrants: [DESCRIPTOR.id, SECOND_DESCRIPTOR.id],
};

test("provider generations validate completely before publishing any binding", () => {
  const directory = new RosterFunctionDirectory([DESCRIPTOR]);

  assert.throws(() => directory.bindProviderGeneration({
    generationId: "invalid-generation",
    providers: [
      {
        providerId: "valid-provider",
        functionId: DESCRIPTOR.id,
        epoch: 1,
        invoke: async () => ({}),
      },
      {
        providerId: "missing-provider",
        functionId: "lifecycle::missing",
        epoch: 1,
        invoke: async () => ({}),
      },
    ],
  }), /undeclared function/u);

  assert.deepEqual(directory.providerBindings(), []);
  assert.deepEqual(directory.providerGenerations(), []);
});

test("provider generations commit atomically with order-independent identity", () => {
  const providers = [
    {
      providerId: "second-provider",
      functionId: SECOND_DESCRIPTOR.id,
      epoch: 1,
      invoke: async () => ({}),
    },
    {
      providerId: "inspect-provider",
      functionId: DESCRIPTOR.id,
      epoch: 2,
      invoke: async () => ({}),
    },
  ];
  const left = new RosterFunctionDirectory([DESCRIPTOR, SECOND_DESCRIPTOR])
    .bindProviderGeneration({ providers });
  const right = new RosterFunctionDirectory([DESCRIPTOR, SECOND_DESCRIPTOR])
    .bindProviderGeneration({ providers: [...providers].reverse() });

  assert.equal(left.generationHash, right.generationHash);
  assert.deepEqual(left.view(), {
    generationId: left.generationId,
    generationHash: left.generationHash,
    state: "active",
    bindings: [
      { functionId: DESCRIPTOR.id, providerId: "inspect-provider", epoch: 2 },
      { functionId: SECOND_DESCRIPTOR.id, providerId: "second-provider", epoch: 1 },
    ],
    activeInvocations: 0,
  });
});

test("withdrawal excludes new calls before waiting for leased invocations", async () => {
  const directory = new RosterFunctionDirectory([DESCRIPTOR]);
  let finish: (() => void) | undefined;
  let disposed = false;
  const handle = directory.bindProviderGeneration({
    generationId: "leased-generation",
    providers: [{
      providerId: "leased-provider",
      functionId: DESCRIPTOR.id,
      epoch: 1,
      invoke: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { settled: true };
      },
    }],
    dispose: () => {
      disposed = true;
    },
  });

  const invocation = directory.invoke({
    node: NODE,
    functionId: DESCRIPTOR.id,
    value: {},
    access,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(handle.view().activeInvocations, 1);

  const timedOut = await handle.withdraw({ timeoutMs: 1 });
  assert.deepEqual(timedOut, {
    generationId: handle.generationId,
    generationHash: handle.generationHash,
    status: "timed-out",
    activeInvocations: 1,
  });
  assert.equal(disposed, false);
  await assert.rejects(() => directory.invoke({
    node: NODE,
    functionId: DESCRIPTOR.id,
    value: {},
    access,
  }), /no available provider/u);

  finish?.();
  assert.deepEqual(await invocation, {
    status: "completed",
    functionId: DESCRIPTOR.id,
    providerId: "leased-provider",
    output: { settled: true },
  });
  assert.equal((await handle.withdraw()).status, "retired");
  assert.equal(disposed, true);
  assert.equal(handle.view().state, "retired");
});

test("replacement publishes the new epoch while the old generation drains", async () => {
  const directory = new RosterFunctionDirectory([DESCRIPTOR]);
  let finishOld: (() => void) | undefined;
  let oldDisposed = false;
  const old = directory.bindProviderGeneration({
    generationId: "old-generation",
    providers: [{
      providerId: "stable-provider",
      functionId: DESCRIPTOR.id,
      epoch: 1,
      invoke: async () => {
        await new Promise<void>((resolve) => {
          finishOld = resolve;
        });
        return { epoch: 1 };
      },
    }],
    dispose: () => {
      oldDisposed = true;
    },
  });
  const oldCall = directory.invoke({
    node: NODE,
    functionId: DESCRIPTOR.id,
    value: {},
    access,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const replacement = directory.bindProviderGeneration({
    generationId: "new-generation",
    providers: [{
      providerId: "stable-provider",
      functionId: DESCRIPTOR.id,
      epoch: 2,
      invoke: async () => ({ epoch: 2 }),
    }],
  });
  assert.equal(old.view().state, "withdrawing");
  assert.equal(replacement.view().state, "active");
  assert.equal(oldDisposed, false);
  assert.deepEqual(await directory.invoke({
    node: NODE,
    functionId: DESCRIPTOR.id,
    value: {},
    access,
  }), {
    status: "completed",
    functionId: DESCRIPTOR.id,
    providerId: "stable-provider",
    output: { epoch: 2 },
  });

  finishOld?.();
  await oldCall;
  assert.equal((await old.withdraw()).status, "retired");
  assert.equal(oldDisposed, true);
});

test("cleanup failure is forward evidence rather than provider-history rollback", async () => {
  const directory = new RosterFunctionDirectory([DESCRIPTOR]);
  const handle = directory.bindProviderGeneration({
    providers: [{
      providerId: "cleanup-provider",
      functionId: DESCRIPTOR.id,
      epoch: 1,
      invoke: async () => ({}),
    }],
    dispose: () => {
      throw new Error("cleanup failed");
    },
  });

  assert.deepEqual(await handle.withdraw(), {
    generationId: handle.generationId,
    generationHash: handle.generationHash,
    status: "cleanup-uncertain",
    activeInvocations: 0,
    cleanupError: "cleanup failed",
  });
  assert.equal(handle.view().state, "cleanup-uncertain");
  assert.deepEqual(directory.providerBindings(), []);
});
