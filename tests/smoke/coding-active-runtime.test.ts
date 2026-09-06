import assert from "node:assert/strict";
import test from "node:test";

import {
  codingNodeExecutionIdentity,
  type CodingActiveRuntimeBinding,
} from "../../src/browser/coding-active-runtime.ts";

test("active Coding runtime identity wins over the saved future-work preference without private placement", () => {
  const savedPreference = {
    workerRuntime: "pi-agent" as const,
    model: "openai-codex/gpt-5.6-luna",
  };
  const activeBinding: CodingActiveRuntimeBinding = {
    id: "active-binding:execution-codex:workspace.implementation",
    workspaceId: "workspace-control-plane",
    roomId: "room_repository_runtime-override",
    runId: "execution-codex",
    nodeId: "workspace.implementation",
    bindingId: "binding-codex-2",
    epoch: 2n,
    topologyVersion: "topology-runtime-override",
    runtimeKind: "codex-cli",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  };

  assert.deepEqual(codingNodeExecutionIdentity(activeBinding, savedPreference), {
    runtime: "Codex CLI",
    model: "GPT-5.6 Sol · High reasoning",
    scope: "active",
  });
  const publicDto = JSON.stringify(activeBinding, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  assert.doesNotMatch(publicDto, /sessionId|sandboxId|runtimeJson|OPENAI_API_KEY/u);
});

test("a saved runtime preference remains future-work identity when no active binding exists", () => {
  assert.deepEqual(codingNodeExecutionIdentity(undefined, {
    workerRuntime: "pi-agent",
    model: "openai-codex/gpt-5.6-luna",
  }), {
    runtime: "Pi Code",
    model: "GPT-5.6 Luna",
    scope: "preference",
  });
});
