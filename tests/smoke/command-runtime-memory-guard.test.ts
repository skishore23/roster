import assert from "node:assert/strict";
import test from "node:test";

import { runCommand } from "../../src/engine/runtime/command-node-runtime.ts";

const BALLOON_SCRIPT = "const chunks=[];setInterval(()=>{chunks.push(Buffer.alloc(32*1024*1024,1))},25);";

test("runCommand kills a process tree that exceeds maxRssBytes", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runCommand({
      command: process.execPath,
      args: ["-e", BALLOON_SCRIPT],
      stdin: "",
      maxOutputBytes: 1_048_576,
      maxRssBytes: 256 * 1024 * 1024,
      timeoutMs: 10_000,
    }),
    /maxRssBytes/,
  );
  assert.ok(
    Date.now() - startedAt < 8_000,
    "memory guard should trigger well before the timeout backstop",
  );
});

test("runCommand leaves a command under the memory ceiling untouched", async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('bounded');"],
    stdin: "",
    maxOutputBytes: 1_048_576,
    maxRssBytes: 2 * 1024 * 1024 * 1024,
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "bounded");
});

test("runCommand rejects an invalid maxRssBytes", async () => {
  await assert.rejects(
    runCommand({
      command: process.execPath,
      args: ["-e", "process.exit(0);"],
      stdin: "",
      maxOutputBytes: 1_048_576,
      maxRssBytes: 0,
    }),
    /maxRssBytes must be a positive safe integer/,
  );
});

test("runCommand enforces the environment-configured default ceiling", async () => {
  const previous = process.env.ROSTER_NODE_COMMAND_MAX_RSS_BYTES;
  process.env.ROSTER_NODE_COMMAND_MAX_RSS_BYTES = String(256 * 1024 * 1024);
  try {
    await assert.rejects(
      runCommand({
        command: process.execPath,
        args: ["-e", BALLOON_SCRIPT],
        stdin: "",
        maxOutputBytes: 1_048_576,
        timeoutMs: 10_000,
      }),
      /maxRssBytes/,
    );
  } finally {
    if (previous === undefined) delete process.env.ROSTER_NODE_COMMAND_MAX_RSS_BYTES;
    else process.env.ROSTER_NODE_COMMAND_MAX_RSS_BYTES = previous;
  }
});
