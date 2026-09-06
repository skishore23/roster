import assert from "node:assert/strict";
import test from "node:test";

import type { Runtime } from "../../src/core/runtime.ts";
import { createQueuedEmitter } from "../../src/engine/runtime/workflow.ts";

type TestCommand = { readonly event: string; readonly eventId: string };

test("queued emitter reports one rejected append without poisoning terminal reporting", async () => {
  let attempts = 0;
  const accepted: string[] = [];
  const runtime = {
    execute: async (_stream: string, command: TestCommand): Promise<string[]> => {
      attempts += 1;
      if (attempts === 1) throw new Error("rejected append");
      accepted.push(command.event);
      return [command.event];
    },
  } as unknown as Runtime<TestCommand, string, never>;
  const errors: string[] = [];
  const emit = createQueuedEmitter({
    runtime,
    stream: "test/run",
    wrap: (event: string, meta) => ({ event, eventId: meta.eventId }),
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  });

  await assert.rejects(emit("invalid"), /rejected append/);
  await emit("terminal.failed");

  assert.equal(attempts, 2);
  assert.deepEqual(errors, ["rejected append"]);
  assert.deepEqual(accepted, ["terminal.failed"]);
});
