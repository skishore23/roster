import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const source = await readFile(new URL("../src/runtime-selection.ts", import.meta.url), "utf8");
const compiled = (await transformWithOxc(source, "runtime-selection.ts", { format: "esm", target: "es2022" })).code;
const { selectDiscoveredRuntimes } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const available = (id) => ({ id, readiness: "ready", executablePath: `/bin/${id}` });

test("restart preserves the saved agent and requires review when any selected runtime disappears", () => {
  const saved = { runtimeIds: ["codex-cli", "pi-agent"], defaultRuntimeId: "codex-cli" };
  assert.deepEqual(selectDiscoveredRuntimes([available("pi-agent")], saved), {
    runtimeIds: ["pi-agent"], defaultRuntimeId: undefined, canAutoResume: false,
  });
  assert.equal(selectDiscoveredRuntimes([available("codex-cli")], saved).canAutoResume, false);
  assert.deepEqual(selectDiscoveredRuntimes([available("pi-agent"), available("codex-cli")], saved), {
    runtimeIds: ["pi-agent", "codex-cli"], defaultRuntimeId: "codex-cli", canAutoResume: true,
  });
  assert.equal(selectDiscoveredRuntimes([
    available("pi-agent"), { ...available("codex-cli"), readiness: "probe-failed" },
  ], saved).defaultRuntimeId, undefined);
  assert.equal(selectDiscoveredRuntimes([available("pi-agent")]).defaultRuntimeId, "pi-agent");
});
