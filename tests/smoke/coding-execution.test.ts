import assert from "node:assert/strict";
import { normalize } from "node:path";
import test from "node:test";

import {
  CODING_WORKER_EXECUTION_SCHEMA,
  codingWorkerExecutionRosterOptions,
  createCodingWorkerExecution,
  parseCodingWorkerExecution,
} from "../../src/domains/coding-execution.ts";

test("Pi is snapshotted with a canonical provider/model and curated AST extensions", () => {
  const execution = createCodingWorkerExecution({
    runtime: "pi-agent",
    source: "product-default",
    env: {},
  });

  assert.equal(execution.schema, CODING_WORKER_EXECUTION_SCHEMA);
  assert.equal(execution.runtime, "pi-agent");
  assert.equal(execution.model, "openai-codex/gpt-5.6-luna");
  assert.equal(execution.pi.provider, "openai-codex");
  assert.equal(execution.pi.model, "gpt-5.6-luna");
  assert.deepEqual(execution.pi.extensionPackages, ["@cortexkit/aft-pi"]);
  assert.ok(execution.pi.extensions.some((extensionPath) =>
    normalize(extensionPath).endsWith(normalize("node_modules/@cortexkit/aft-pi/dist/index.js"))));
  assert.deepEqual(parseCodingWorkerExecution(JSON.parse(JSON.stringify(execution))), execution);
  assert.deepEqual(codingWorkerExecutionRosterOptions(execution), {
    workerRuntime: "pi-agent",
    piProvider: "openai-codex",
    piModel: "gpt-5.6-luna",
    piThinking: undefined,
    piExtensions: execution.pi.extensions,
    piSkills: [],
    piPromptTemplates: [],
    piTools: [],
    piExcludeTools: [],
    piProjectTrust: undefined,
    piNoBuiltinTools: undefined,
    piNoExtensions: undefined,
    piOffline: undefined,
  });
});

test("Pi provider configuration is normalized before it enters a durable job", () => {
  const execution = createCodingWorkerExecution({
    runtime: "pi-agent",
    source: "workspace-default",
    workerModel: "openai-codex/gpt-5.6-sol",
    env: {
      ROSTER_CODING_PI_PROVIDER: "anthropic",
      ROSTER_CODING_PI_MODEL: "anthropic/claude-sonnet-4-5",
      ROSTER_CODING_PI_THINKING: "high",
      ROSTER_CODING_PI_ENABLE_DEFAULT_EXTENSIONS: "0",
    },
  });

  assert.equal(execution.runtime, "pi-agent");
  assert.equal(execution.model, "anthropic/claude-sonnet-4-5");
  assert.equal(execution.pi.provider, "anthropic");
  assert.equal(execution.pi.model, "claude-sonnet-4-5");
  assert.equal(execution.pi.thinking, "high");
  assert.deepEqual(execution.pi.extensionPackages, []);
  assert.deepEqual(execution.pi.extensions, []);
});

test("Pi rejects a provider that conflicts with a qualified model", () => {
  assert.throws(() => createCodingWorkerExecution({
    runtime: "pi-agent",
    source: "product-default",
    workerModel: "openai-codex/gpt-5.6-luna",
    env: { ROSTER_CODING_PI_PROVIDER: "anthropic" },
  }), /provider anthropic conflicts with qualified model openai-codex\/gpt-5\.6-luna/);
});

test("Hermes execution is snapshotted independently of later environment changes", () => {
  const execution = createCodingWorkerExecution({
    runtime: "hermes-agent",
    source: "api-override",
    env: {
      ROSTER_CODING_HERMES_PROVIDER: "openrouter",
      ROSTER_CODING_HERMES_MODEL: "nousresearch/hermes-4",
    },
  });

  assert.deepEqual(execution, {
    schema: CODING_WORKER_EXECUTION_SCHEMA,
    runtime: "hermes-agent",
    source: "api-override",
    model: "nousresearch/hermes-4",
    provider: "openrouter",
  });
  assert.deepEqual(parseCodingWorkerExecution(JSON.parse(JSON.stringify(execution))), execution);
  assert.deepEqual(codingWorkerExecutionRosterOptions(execution), {
    workerRuntime: "hermes-agent",
    hermesProvider: "openrouter",
    hermesModel: "nousresearch/hermes-4",
  });
});

test("malformed worker execution snapshots fail closed", () => {
  const execution = createCodingWorkerExecution({
    runtime: "pi-agent",
    source: "api-override",
    env: {},
  });
  assert.equal(parseCodingWorkerExecution({
    ...execution,
    model: "anthropic/claude-sonnet-4-5",
  }), undefined);
  assert.equal(parseCodingWorkerExecution({
    ...execution,
    pi: { ...execution.pi, extensions: [42] },
  }), undefined);
});

test("dependency resolution round-trips only on an authenticated Codex API override snapshot", () => {
  const execution = createCodingWorkerExecution({
    runtime: "codex-cli",
    source: "api-override",
    dependencyResolution: "registry",
    env: {},
  });
  assert.deepEqual(parseCodingWorkerExecution(JSON.parse(JSON.stringify(execution))), execution);
  assert.deepEqual(codingWorkerExecutionRosterOptions(execution), {
    workerRuntime: "codex-cli",
    codexModel: "gpt-5.6-sol",
    codexReasoningEffort: "high",
    dependencyResolution: "registry",
  });
  assert.throws(() => createCodingWorkerExecution({
    runtime: "codex-cli",
    source: "node-preference",
    dependencyResolution: "registry",
    env: {},
  }), /authenticated Codex API override/);
  assert.throws(() => createCodingWorkerExecution({
    runtime: "pi-agent",
    source: "api-override",
    dependencyResolution: "registry",
    env: {},
  }), /authenticated Codex API override/);
  assert.equal(parseCodingWorkerExecution({
    ...execution,
    source: "workspace-default",
  }), undefined);
  assert.equal(parseCodingWorkerExecution({
    ...execution,
    dependencyResolution: "private-registry",
  }), undefined);
  const piExecution = createCodingWorkerExecution({
    runtime: "pi-agent",
    source: "api-override",
    env: {},
  });
  assert.equal(parseCodingWorkerExecution({
    ...piExecution,
    dependencyResolution: "registry",
  }), undefined);
});
