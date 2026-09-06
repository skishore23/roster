import assert from "node:assert/strict";
import test from "node:test";

import { drainServer, serverDrainAllowsRequest } from "../../src/framework/server-drain.ts";

test("graceful server drain keeps HTTP projections available until leased work settles", async () => {
  const order: string[] = [];
  let settleWorker!: () => void;
  const workerSettled = new Promise<void>((resolve) => {
    settleWorker = resolve;
  });

  const completion = drainServer({
    stopWorker: () => order.push("worker-stopped"),
    stopHeartbeats: () => order.push("heartbeats-stopped"),
    drainWorker: async () => {
      order.push("worker-draining");
      await workerSettled;
      order.push("worker-drained");
    },
    closeHttp: async () => { order.push("http-closed"); },
    closeResources: () => order.push("resources-closed"),
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["worker-stopped", "heartbeats-stopped", "worker-draining"]);
  assert.equal(serverDrainAllowsRequest("GET"), true);
  assert.equal(serverDrainAllowsRequest("head"), true);
  assert.equal(serverDrainAllowsRequest("OPTIONS"), true);
  assert.equal(serverDrainAllowsRequest("POST"), false);
  assert.equal(serverDrainAllowsRequest("PATCH"), false);

  settleWorker();
  await completion;
  assert.deepEqual(order, [
    "worker-stopped",
    "heartbeats-stopped",
    "worker-draining",
    "worker-drained",
    "http-closed",
    "resources-closed",
  ]);
});

test("server drain releases HTTP and resources even when a worker fails to settle cleanly", async () => {
  const order: string[] = [];
  const errors: string[] = [];

  await drainServer({
    stopWorker: () => order.push("worker-stopped"),
    stopHeartbeats: () => order.push("heartbeats-stopped"),
    drainWorker: async () => {
      order.push("worker-draining");
      throw new Error("drain failed");
    },
    closeHttp: async () => { order.push("http-closed"); },
    closeResources: () => order.push("resources-closed"),
    onError: (phase) => errors.push(phase),
  });

  assert.deepEqual(errors, ["worker"]);
  assert.deepEqual(order, [
    "worker-stopped",
    "heartbeats-stopped",
    "worker-draining",
    "http-closed",
    "resources-closed",
  ]);
});
