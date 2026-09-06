import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createClaudeCodeNodeRuntimeAdapter,
  createA2ANodeRuntimeAdapter,
  createCommandNodeRuntimeAdapter,
  createCodexCliNodeRuntimeAdapter,
  createHermesAgentNodeRuntimeAdapter,
  createNodeExecutionSurface,
  createNodeExecutionSkill,
  createPiAgentNodeRuntimeAdapter,
  createRosterFunctionExecutionPlane,
  NODE_EXECUTION_SCHEMA_VERSION,
  NodeRuntimeRegistry,
  ROSTER_CATALOG_INVOKE_FUNCTION_ID,
  ROSTER_CATALOG_SEARCH_FUNCTION_ID,
  type CommandExecution,
  type CommandExecutionResult,
  type NodeRuntimeAdapter,
  type NodeRuntimeAdapterView,
} from "../../src/sdk/runtime.ts";
import {
  RosterFunctionDirectory,
  type RosterFunctionDescriptor,
  type RosterFunctionTool,
} from "../../src/sdk/capabilities.ts";
import {
  createDynamicTaskDefinition,
  createTaskExecutionGrant,
  ROSTER_TASK_EXECUTION_GRANT_VERSION,
} from "../../src/sdk/orchestration.ts";
import type { WorkspaceNode } from "../../src/sdk/workspace.ts";
import { runCommand } from "../../src/engine/runtime/command-node-runtime.ts";
import {
  executeWithPreparedNodeCodeMode,
  prepareNodeCodeMode,
  type NodeCodeModeScheduler,
  type NodeCodeModeWatcher,
} from "../../src/engine/runtime/node-code-mode.ts";
import type {
  NodeExecutionEnvelope,
  NodeExecutionRequest,
} from "../../src/engine/runtime/node-runtime.ts";
import { bindPreparedNodeRuntimeExecutor } from "../../src/engine/runtime/node-runtime.ts";
import {
  compileNodeExecutionPrompt,
  NODE_EXECUTION_PROMPT_CONTEXT_SCHEMA_VERSION,
} from "../../src/engine/runtime/node-execution-prompt.ts";
import type { JsonValue } from "../../src/engine/orchestration/types.ts";
import { hashCanonical } from "../../src/core/canonical.ts";

const CODE_MODE_NODE: WorkspaceNode = {
  id: "coordinator",
  name: "Coordinator",
  capabilities: ["delegate"],
  runtime: { kind: "codex-cli" },
};

const workerFunctionDescriptor = (): RosterFunctionDescriptor => ({
  id: "worker::delegate-test",
  version: "1",
  capability: "delegate",
  description: "Execute one bounded test worker function.",
  inputSchema: true,
  outputSchema: true,
  effects: ["external"],
  idempotency: "required",
  defaultTimeoutMs: 120_000,
});

const executeClient = (
  execution: CommandExecution,
  args: ReadonlyArray<string>,
  stdin = "",
): Promise<CommandExecutionResult> => runCommand({
  command: "roster-tool",
  args,
  stdin,
  env: execution.env,
  signal: execution.signal,
  maxOutputBytes: 2 * 1_048_576,
  maxCaptureBytes: 2 * 1_048_576,
});

const contextHandle = (response: string): string => {
  const parsed = JSON.parse(response) as {
    readonly context?: { readonly handle?: unknown };
  };
  assert.equal(typeof parsed.context?.handle, "string");
  assert.ok(parsed.context);
  return parsed.context.handle as string;
};

const reachableOwnDescriptorValues = (
  ...roots: ReadonlyArray<unknown>
): ReadonlySet<unknown> => {
  const reachable = new Set<unknown>();
  const pending = [...roots];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === undefined || reachable.has(value)) continue;
    reachable.add(value);
    if (
      (typeof value !== "object" || value === null)
      && typeof value !== "function"
    ) {
      continue;
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if ("value" in descriptor) pending.push(descriptor.value);
      if (descriptor.get) pending.push(descriptor.get);
      if (descriptor.set) pending.push(descriptor.set);
    }
  }
  return reachable;
};

test("code mode externalizes input and reduces worker results to handles", async () => {
  const inputSecret = "INPUT_BODY_MUST_NOT_ENTER_THE_MODEL_PROMPT";
  const childSecret = "CHILD_BODY_MUST_NOT_ENTER_THE_TOOL_OBSERVATION";
  const descriptor = workerFunctionDescriptor();
  const directory = new RosterFunctionDirectory([descriptor]);
  const receivedContexts: unknown[] = [];
  let providerCalls = 0;
  directory.bindProvider({
    providerId: "durable-roster-scheduler",
    functionId: descriptor.id,
    epoch: 1,
    invoke: async (value) => {
      providerCalls += 1;
      const request = value as { readonly context?: unknown };
      receivedContexts.push(request.context);
      return {
        summary: "child completed",
        privateEvidence: childSecret,
        facts: [{ id: 1, value: "selected" }],
      };
    },
  });
  const plane = createRosterFunctionExecutionPlane({
    directory,
    access: () => ({
      functionGrants: [descriptor.id],
      allowedEffects: ["external"],
    }),
  });
  const task = {
    taskId: "root-turn",
    nodeId: CODE_MODE_NODE.id,
    capability: "delegate",
    objective: "Inspect the external context, delegate one child, and reduce its result.",
  };
  let clientDirectory = "";
  const adapter = createCodexCliNodeRuntimeAdapter({
    runner: async (execution) => {
      assert.equal(execution.env?.ROSTER_CODE_TOOL_SOCKET, undefined);
      assert.ok(execution.env?.ROSTER_CODE_TOOL_MAILBOX_DIR);
      assert.ok(execution.env?.ROSTER_CODE_TOOL_VALUE_DIR);
      const sandboxedExecution = execution;
      const readOnlyEnvironment = { ...execution.env };
      delete readOnlyEnvironment.ROSTER_CODE_TOOL_MAILBOX_DIR;
      const readOnlyExecution = { ...execution, env: readOnlyEnvironment };
      clientDirectory = (execution.env?.PATH ?? "").split(delimiter)[0] ?? "";
      assert.ok(clientDirectory);
      assert.doesNotMatch(execution.stdin, new RegExp(inputSecret));
      assert.match(execution.stdin, /context_[a-f0-9]{28}/u);
      assert.match(execution.stdin, /roster-tool materialize/u);

      const listed = await executeClient(readOnlyExecution, ["list"]);
      assert.equal(listed.exitCode, 0);
      const list = JSON.parse(listed.stdout) as {
        readonly contextValues?: ReadonlyArray<{ readonly handle: string; readonly label: string }>;
        readonly tools?: ReadonlyArray<{ readonly id: string }>;
      };
      const inputHandle = list.contextValues?.find((value) => value.label === "task.input")?.handle;
      assert.ok(inputHandle);
      assert.deepEqual(list.tools?.map((tool) => tool.id), [
        ROSTER_CATALOG_SEARCH_FUNCTION_ID,
        ROSTER_CATALOG_INVOKE_FUNCTION_ID,
      ]);

      const peeked = await executeClient(readOnlyExecution, [
        "peek", inputHandle, "/documents/0/body", "0", "12",
      ]);
      assert.equal(peeked.exitCode, 0);
      assert.match(peeked.stdout, /INPUT_BODY_M/u);
      assert.doesNotMatch(peeked.stdout, new RegExp(inputSecret));

      const searchedInput = await executeClient(
        readOnlyExecution,
        ["search", inputHandle, "remaining content"],
      );
      assert.equal(searchedInput.exitCode, 0);
      assert.match(searchedInput.stdout, /remaining content/u);

      const materializedInput = await executeClient(
        readOnlyExecution,
        ["materialize", inputHandle],
      );
      assert.equal(materializedInput.exitCode, 0);
      const materializedInputPath = (JSON.parse(materializedInput.stdout) as {
        readonly path?: unknown;
      }).path;
      assert.equal(typeof materializedInputPath, "string");
      assert.match(await readFile(materializedInputPath as string, "utf8"), new RegExp(inputSecret));
      assert.deepEqual(
        (await readdir(execution.env?.ROSTER_CODE_TOOL_MAILBOX_DIR ?? ""))
          .filter((name) => name.startsWith("request-")),
        [],
      );

      const searched = await executeClient(
        sandboxedExecution,
        ["call", ROSTER_CATALOG_SEARCH_FUNCTION_ID],
        JSON.stringify({ query: "delegate-test" }),
      );
      assert.equal(searched.exitCode, 0);
      const searchHandle = contextHandle(searched.stdout);
      const materializedSearch = await executeClient(
        readOnlyExecution,
        ["materialize", searchHandle],
      );
      assert.equal(materializedSearch.exitCode, 0);
      const searchPath = (JSON.parse(materializedSearch.stdout) as {
        readonly path?: unknown;
      }).path;
      assert.equal(typeof searchPath, "string");
      const catalog = JSON.parse(await readFile(searchPath as string, "utf8")) as {
        readonly catalogVersion: string;
        readonly entries: ReadonlyArray<{
          readonly id: string;
          readonly version: string;
          readonly providers: ReadonlyArray<{ readonly providerId: string; readonly epoch: number }>;
        }>;
      };
      const entry = catalog.entries.find((candidate) => candidate.id === descriptor.id);
      const provider = entry?.providers[0];
      assert.ok(entry);
      assert.ok(provider);
      const call = await executeClient(
        sandboxedExecution,
        ["call", ROSTER_CATALOG_INVOKE_FUNCTION_ID],
        JSON.stringify({
          operation: "call",
          catalogVersion: catalog.catalogVersion,
          functionId: entry.id,
          functionVersion: entry.version,
          providerId: provider.providerId,
          providerEpoch: provider.epoch,
          value: {
            idempotencyKey: "root-turn-child-1",
            objective: "Extract the relevant fact.",
            childCapability: "inspect",
            outputContract: { type: "object", required: ["summary"] },
            context: {
              $rosterContext: inputHandle,
              pointer: "/documents/0",
            },
          },
        }),
      );
      assert.equal(call.exitCode, 0);
      assert.doesNotMatch(call.stdout, new RegExp(childSecret));
      const childHandle = contextHandle(call.stdout);

      const materialized = await executeClient(readOnlyExecution, ["materialize", childHandle]);
      assert.equal(materialized.exitCode, 0);
      const materializedResult = JSON.parse(materialized.stdout) as { readonly path?: unknown };
      assert.equal(typeof materializedResult.path, "string");
      assert.match(await readFile(materializedResult.path as string, "utf8"), new RegExp(childSecret));

      const bounded = await executeClient(
        sandboxedExecution,
        ["call", ROSTER_CATALOG_SEARCH_FUNCTION_ID],
        JSON.stringify({ query: "second-search" }),
      );
      assert.notEqual(bounded.exitCode, 0);
      assert.match(bounded.stderr, /maxFunctionCalls=2/u);

      const unauthorized = await executeClient(sandboxedExecution, ["call", "roster::not-projected"], "{}");
      assert.notEqual(unauthorized.exitCode, 0);
      assert.match(unauthorized.stderr, /not projected for this node/u);

      return {
        exitCode: 0,
        stderr: "",
        stdout: [
          '{"type":"thread.started","thread_id":"code-mode-thread"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"answer\\":{\\"summary\\":\\"reduced\\"}}"}}',
        ].join("\n"),
      };
    },
  });
  const runtimes = new NodeRuntimeRegistry([adapter]);
  const output = await runtimes.execute({
    runId: "code-mode-run",
    node: CODE_MODE_NODE,
    task,
    input: {
      documents: [{
        body: `${inputSecret}: the remaining content is intentionally external`,
        ignored: "x".repeat(4_096),
      }],
    },
    resultContract: {
      mode: "json",
      outputKey: "answer",
      schema: { type: "object", required: ["answer"] },
    },
    surface: {
      tools: plane.functionTools(CODE_MODE_NODE, task),
      codeMode: {
        inputMode: "external",
        maxFunctionCalls: 2,
        maxContextValues: 4,
        maxContextBytes: 64 * 1_024,
        maxValueBytes: 32 * 1_024,
        maxObservationBytes: 1_024,
      },
    },
    invokeFunction: plane.functionInvoker(CODE_MODE_NODE, task),
    validateOutput: (candidate) => Boolean(candidate)
      && candidate !== null
      && typeof candidate === "object"
      && "answer" in candidate,
    execute: async () => ({ answer: { summary: "native" } }),
  });

  assert.deepEqual(output, { answer: { summary: "reduced" } });
  assert.equal(providerCalls, 1);
  assert.deepEqual(receivedContexts, [{
    body: `${inputSecret}: the remaining content is intentionally external`,
    ignored: "x".repeat(4_096),
  }]);
  assert.equal(await stat(clientDirectory).then(() => true, () => false), false);
});

type LocalRuntimeCase = {
  readonly kind: "codex-cli" | "claude-code" | "pi-agent" | "hermes-agent";
  readonly adapter: (runner: (execution: CommandExecution) => Promise<CommandExecutionResult>) => NodeRuntimeAdapter;
  readonly result: CommandExecutionResult;
};

const LOCAL_RUNTIME_CASES: ReadonlyArray<LocalRuntimeCase> = [
  {
    kind: "codex-cli",
    adapter: (runner) => createCodexCliNodeRuntimeAdapter({ runner }),
    result: {
      exitCode: 0,
      stderr: "",
      stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"answer\\":\\"codex-cli\\"}"}}',
    },
  },
  {
    kind: "claude-code",
    adapter: (runner) => createClaudeCodeNodeRuntimeAdapter({ runner }),
    result: {
      exitCode: 0,
      stderr: "",
      stdout: '{"type":"result","is_error":false,"result":"{\\"answer\\":\\"claude-code\\"}"}',
    },
  },
  {
    kind: "pi-agent",
    adapter: (runner) => createPiAgentNodeRuntimeAdapter({ runner }),
    result: {
      exitCode: 0,
      stderr: "",
      stdout: '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"answer\\":\\"pi-agent\\"}"}]}}',
    },
  },
  {
    kind: "hermes-agent",
    adapter: (runner) => createHermesAgentNodeRuntimeAdapter({ runner }),
    result: {
      exitCode: 0,
      stderr: "",
      stdout: '{"answer":"hermes-agent"}',
    },
  },
];

const SHARED_RUNTIME_SKILL = createNodeExecutionSkill({
  id: "shared-runtime-skill",
  name: "Shared runtime skill",
  description: "Prove exact skills cross every supported local coding runtime.",
  instructions: "SHARED_RUNTIME_SKILL_INSTRUCTION",
});

const SHARED_RUNTIME_TOOL: RosterFunctionTool = {
  id: "workspace::surface-check",
  version: "1",
  capability: "delegate",
  description: "Prove exact tools cross every supported local coding runtime.",
  inputSchema: true,
  outputSchema: true,
  effects: ["read"],
};

const SHARED_RUNTIME_WORKSPACE = {
  workspaceId: "workspace-surface-matrix",
  inputs: {
    inputVersions: { repository: "sha256:surface-matrix" },
    dataReferences: [{
      source: "task.input",
      label: "surface-matrix",
      contentHash: "sha256:surface-matrix",
      mediaType: "application/json",
      byteLength: 128,
    }],
    frontierVersion: "frontier-surface-matrix",
    topologyVersion: "topology-surface-matrix",
    catalogVersion: "catalog-surface-matrix",
  },
} as const;

for (const runtimeCase of LOCAL_RUNTIME_CASES) {
  test(`${runtimeCase.kind} receives the same complete bounded execution surface`, async () => {
    let listed = false;
    const inputSentinel = `SURFACE_INPUT_${runtimeCase.kind}_MUST_STAY_EXTERNAL`;
    const adapter = runtimeCase.adapter(async (execution) => {
      assert.equal(execution.timeoutMs, 12_345);
      assert.equal(execution.env?.ROSTER_CODE_TOOL_SOCKET, undefined);
      assert.ok(execution.env?.ROSTER_CODE_TOOL_MAILBOX_DIR);
      assert.ok(execution.env?.ROSTER_CODE_TOOL_VALUE_DIR);
      if (runtimeCase.kind === "claude-code") {
        assert.ok(execution.args.includes("--safe-mode"));
        const allowedToolsIndex = execution.args.indexOf("--allowedTools");
        assert.ok(allowedToolsIndex >= 0);
        assert.equal(execution.args[allowedToolsIndex + 1], "Bash");
      }
      if (runtimeCase.kind === "hermes-agent") {
        assert.match(execution.env?.HERMES_HOME ?? "", /roster-hermes-runtime-.+\/hermes-home$/u);
      }
      const promptTransport = [execution.stdin, ...execution.args].join("\n");
      assert.doesNotMatch(promptTransport, new RegExp(inputSentinel, "u"));
      assert.match(promptTransport, /SHARED_RUNTIME_SKILL_INSTRUCTION/u);
      assert.match(promptTransport, new RegExp(SHARED_RUNTIME_SKILL.contentHash, "u"));
      const serializedEnvelope = promptTransport
        .split(/\r?\n/u)
        .find((line) => line.startsWith(
          `{"schemaVersion":"${NODE_EXECUTION_PROMPT_CONTEXT_SCHEMA_VERSION}"`,
        ));
      assert.ok(serializedEnvelope);
      const envelope = JSON.parse(serializedEnvelope) as Omit<
        NodeExecutionEnvelope,
        "schemaVersion" | "target" | "resultContract"
      > & {
        readonly schemaVersion: string;
        readonly executionSchemaVersion: string;
      };
      assert.equal(envelope.schemaVersion, NODE_EXECUTION_PROMPT_CONTEXT_SCHEMA_VERSION);
      assert.equal(envelope.executionSchemaVersion, NODE_EXECUTION_SCHEMA_VERSION);
      assert.equal(Object.hasOwn(envelope.task, "objective"), false);
      assert.equal(Object.hasOwn(envelope, "target"), false);
      assert.equal(Object.hasOwn(envelope, "resultContract"), false);
      assert.equal(envelope.grant.schemaVersion, ROSTER_TASK_EXECUTION_GRANT_VERSION);
      assert.equal(envelope.grant.runId, `code-mode-${runtimeCase.kind}`);
      assert.equal(envelope.grant.taskId, "inspect");
      assert.equal(envelope.grant.nodeId, node.id);
      assert.deepEqual(envelope.grant.surface.skills, [{
        id: SHARED_RUNTIME_SKILL.id,
        contentHash: SHARED_RUNTIME_SKILL.contentHash,
      }]);
      assert.deepEqual(envelope.grant.surface.tools, [{
        id: SHARED_RUNTIME_TOOL.id,
        version: SHARED_RUNTIME_TOOL.version,
        effects: SHARED_RUNTIME_TOOL.effects,
      }]);
      assert.equal(envelope.grant.surface.codeMode?.maxFunctionCalls, 16);
      assert.deepEqual(
        Reflect.ownKeys(envelope.input as object).sort(),
        ["byteLength", "contentHash", "contextHandle"],
      );
      assert.equal(Object.hasOwn(envelope, "skills"), false);
      assert.equal(Object.hasOwn(envelope, "tools"), false);
      assert.equal(Object.hasOwn(envelope, "workspace"), false);
      assert.equal(Object.hasOwn(envelope, "codeMode"), false);
      assert.equal(envelope.surface.schemaVersion, "roster.node-execution-surface.v1");
      assert.match(envelope.surface.surfaceId, /^node_surface_[a-f0-9]{28}$/u);
      assert.deepEqual(envelope.surface.skills, [SHARED_RUNTIME_SKILL]);
      assert.deepEqual(envelope.surface.tools, [SHARED_RUNTIME_TOOL]);
      assert.deepEqual(envelope.surface.workspace, SHARED_RUNTIME_WORKSPACE);
      assert.equal(envelope.surface.codeMode?.inputMode, "external");
      assert.equal(envelope.surface.codeMode?.command, "roster-tool");
      const result = await executeClient(execution, ["list"]);
      assert.equal(result.exitCode, 0);
      const list = JSON.parse(result.stdout) as {
        readonly contextValues?: ReadonlyArray<{ readonly label: string }>;
        readonly tools?: ReadonlyArray<{ readonly id: string }>;
      };
      assert.ok(list.contextValues?.some((value) => value.label === "task.input"));
      assert.deepEqual(list.tools?.map((tool) => tool.id), [SHARED_RUNTIME_TOOL.id]);
      listed = true;
      return runtimeCase.result;
    });
    const node: WorkspaceNode = {
      ...CODE_MODE_NODE,
      runtime: { kind: runtimeCase.kind },
    };
    const output = await new NodeRuntimeRegistry([adapter]).execute({
      runId: `code-mode-${runtimeCase.kind}`,
      node,
      task: {
        taskId: "inspect",
        nodeId: node.id,
        capability: "delegate",
      },
      input: {
        largeContext: `${inputSentinel}: kept outside the prompt`,
      },
      surface: {
        skills: [SHARED_RUNTIME_SKILL],
        tools: [SHARED_RUNTIME_TOOL],
        workspace: SHARED_RUNTIME_WORKSPACE,
        codeMode: { inputMode: "external" },
      },
      resultContract: {
        mode: "json",
        outputKey: "answer",
        schema: { type: "object", required: ["answer"] },
      },
      validateOutput: (candidate) => Boolean(candidate)
        && candidate !== null
        && typeof candidate === "object"
        && "answer" in candidate,
      timeoutMs: 12_345,
      execute: async () => ({ answer: "native" }),
    });
    assert.equal(listed, true);
    assert.deepEqual(output, { answer: runtimeCase.kind });
  });
}

test("prepared dispatch has no forgeable public adapter route", () => {
  for (const adapter of [
    createCommandNodeRuntimeAdapter(),
    createCodexCliNodeRuntimeAdapter(),
    createClaudeCodeNodeRuntimeAdapter(),
    createPiAgentNodeRuntimeAdapter(),
    createHermesAgentNodeRuntimeAdapter(),
  ]) {
    assert.equal("executePrepared" in adapter, false);
    assert.equal("preparedClientDirectory" in adapter, false);
    assert.equal("codeModeEnvironment" in adapter, false);
    assert.equal(
      Reflect.ownKeys(adapter).some((key) => typeof key === "symbol"),
      false,
    );
  }
});

test("explicit inline code mode still externalizes unique input before launch", async () => {
  const inputSentinel = "UNIQUE_EXPLICIT_INLINE_INPUT_MUST_NEVER_REACH_RUNNER";
  let launched = 0;
  const adapter = createCommandNodeRuntimeAdapter({
    runner: async (execution) => {
      launched += 1;
      assert.doesNotMatch(execution.stdin, new RegExp(inputSentinel));
      const envelope = JSON.parse(execution.stdin) as NodeExecutionEnvelope;
      assert.equal(envelope.surface.codeMode?.inputMode, "external");
      assert.deepEqual(
        Reflect.ownKeys(envelope.input as object).sort(),
        ["byteLength", "contentHash", "contextHandle"],
      );
      const listed = await executeClient(execution, ["list"]);
      const inputHandle = (JSON.parse(listed.stdout) as {
        readonly contextValues?: ReadonlyArray<{ readonly handle: string; readonly label: string }>;
      }).contextValues?.find((value) => value.label === "task.input")?.handle;
      assert.ok(inputHandle);
      const materialized = await executeClient(execution, ["materialize", inputHandle]);
      const path = (JSON.parse(materialized.stdout) as { readonly path?: unknown }).path;
      assert.equal(typeof path, "string");
      assert.match(await readFile(path as string, "utf8"), new RegExp(inputSentinel));
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: { answer: "external" },
        }),
      };
    },
  });
  const output = await new NodeRuntimeRegistry([adapter]).execute({
    runId: "explicit-inline-externalized",
    node: { ...CODE_MODE_NODE, runtime: { kind: "shell", command: ["worker"] } },
    task: { taskId: "inspect", nodeId: CODE_MODE_NODE.id, capability: "delegate" },
    input: { sentinel: inputSentinel },
    surface: { codeMode: { inputMode: "inline" } },
    resultContract: { mode: "json", outputKey: "answer" },
    execute: async () => ({ answer: "native" }),
  });
  assert.deepEqual(output, { answer: "external" });
  assert.equal(launched, 1);
});

test("code mode rejects an unbound adapter before launch", async () => {
  let launched = false;
  const adapter: NodeRuntimeAdapter = {
    kind: "local-unprepared",
    supportsCodeMode: true,
    executeEnvelope: async () => {
      launched = true;
      throw new Error("unprepared adapter must not launch");
    },
  };
  await assert.rejects(() => new NodeRuntimeRegistry([adapter]).execute({
    runId: "unprepared-code-mode",
    node: { ...CODE_MODE_NODE, runtime: { kind: adapter.kind } },
    task: { taskId: "inspect", nodeId: CODE_MODE_NODE.id, capability: "delegate" },
    input: { sentinel: "must never reach adapter" },
    surface: { codeMode: {} },
    execute: async () => ({ answer: "native" }),
  }), /does not support code mode/u);
  assert.equal(launched, false);
});

test("external execute-only adapters cannot observe private requests or invoke native callbacks", () => {
  const rawPrivateReference = {
    schemaVersion: "roster.data-reference.v1",
    referenceId: "PRIVATE_RAW_DATA_REFERENCE_SENTINEL",
    contentHash: "c".repeat(64),
    mediaType: "application/json",
    byteLength: 1,
    storage: "object",
    artifactId: "private-artifact-locator",
  };
  let adapterCalls = 0;
  let observedPrivateReference = false;
  const hostileAdapter: NodeRuntimeAdapter = {
    kind: "hostile-execute-only",
    execute: async (request) => {
      adapterCalls += 1;
      observedPrivateReference = JSON.stringify(request).includes(rawPrivateReference.referenceId);
      return request.execute();
    },
  };

  assert.throws(
    () => new NodeRuntimeRegistry([hostileAdapter]),
    /requires a serializable execution transport/u,
  );
  assert.equal(adapterCalls, 0);
  assert.equal(observedPrivateReference, false);
});

test("mutating a registered external adapter cannot expose private requests to native execute", async () => {
  const privateSentinel = "PRIVATE_MUTATED_ADAPTER_REFERENCE";
  let adapterCalls = 0;
  let nativeCalls = 0;
  let privateSeen = false;
  const mutableAdapter: {
    kind: string;
    executeEnvelope?: NodeRuntimeAdapter["executeEnvelope"];
    execute?: NodeRuntimeAdapter["execute"];
  } = {
    kind: "hostile-external",
    executeEnvelope: async (envelope) => ({
      schemaVersion: envelope.schemaVersion,
      status: "completed",
      output: "external",
    }),
  };
  const runtimes = new NodeRuntimeRegistry([mutableAdapter]);
  mutableAdapter.kind = "roster-native";
  mutableAdapter.executeEnvelope = undefined;
  mutableAdapter.execute = async (request) => {
    adapterCalls += 1;
    privateSeen = JSON.stringify(request).includes(privateSentinel);
    return request.execute();
  };

  await assert.rejects(() => runtimes.execute({
    runId: "mutated-adapter",
    node: {
      ...CODE_MODE_NODE,
      runtime: { kind: "hostile-external" },
    },
    task: { taskId: "inspect", nodeId: CODE_MODE_NODE.id, capability: "delegate" },
    input: { referenceId: privateSentinel },
    execute: async () => {
      nativeCalls += 1;
      return { answer: "native" };
    },
  }), /adapter hostile-external changed after registration/u);
  assert.equal(adapterCalls, 0);
  assert.equal(nativeCalls, 0);
  assert.equal(privateSeen, false);
});

test("dispatch snapshots node-authored and binding-provided runtimes before getters can redirect execution", async (t) => {
  for (const runtimeSource of ["node", "binding"] as const) {
    await t.test(runtimeSource, async () => {
      let runtimeKindReads = 0;
      let runtimeProfileReads = 0;
      let runtimeCommandReads = 0;
      let runtimeEndpointReads = 0;
      let runtimeMetadataReads = 0;
      let nodeRuntimeReads = 0;
      let validateCalls = 0;
      let envelopeCalls = 0;
      let nativeCalls = 0;
      const envelopes: NodeExecutionEnvelope[] = [];
      const dynamicRuntime = {
        get kind() {
          runtimeKindReads += 1;
          return runtimeKindReads === 1
            ? "dynamic-runtime-source"
            : "roster-native";
        },
        get profile() {
          runtimeProfileReads += 1;
          return "source-profile";
        },
        get command() {
          runtimeCommandReads += 1;
          return ["source-worker", "--stdio"];
        },
        get endpoint() {
          runtimeEndpointReads += 1;
          return "source://worker";
        },
        get metadata() {
          runtimeMetadataReads += 1;
          return { identity: "source", nested: { stable: true } };
        },
      };
      const staticRuntime: WorkspaceNode["runtime"] = {
        kind: "dynamic-runtime-source",
        profile: "source-profile",
        command: ["source-worker", "--stdio"],
        endpoint: "source://worker",
        metadata: { identity: "source", nested: { stable: true } },
      };
      const adapter: NodeRuntimeAdapter = {
        kind: "dynamic-runtime-source",
        validateRuntime: () => {
          validateCalls += 1;
        },
        executeEnvelope: async (envelope) => {
          envelopeCalls += 1;
          envelopes.push(envelope);
          return {
            schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
            status: "completed",
            output: "external",
          };
        },
      };
      const runtimes = new NodeRuntimeRegistry([adapter]);
      const dynamicNode = {
        id: CODE_MODE_NODE.id,
        name: CODE_MODE_NODE.name,
        capabilities: [...CODE_MODE_NODE.capabilities],
      } as Record<PropertyKey, unknown>;
      Object.defineProperty(dynamicNode, "runtime", {
        enumerable: true,
        get: () => {
          nodeRuntimeReads += 1;
          return runtimeSource === "node"
            ? dynamicRuntime
            : { kind: "roster-native" };
        },
      });
      const bindingFor = (runtime: WorkspaceNode["runtime"]) => runtimeSource === "binding"
        ? {
          bindingId: "binding-dynamic-runtime",
          nodeId: CODE_MODE_NODE.id,
          runtime,
          epoch: 3,
          topologyVersion: "topology-dynamic-runtime",
        }
        : undefined;
      const request = {
        runId: `dynamic-runtime-${runtimeSource}`,
        task: {
          taskId: "dynamic-runtime-kind",
          nodeId: CODE_MODE_NODE.id,
          capability: "delegate",
        },
        execute: async () => {
          nativeCalls += 1;
          return "native";
        },
      };

      const output = await runtimes.execute({
        ...request,
        node: dynamicNode as unknown as WorkspaceNode,
        ...(bindingFor(dynamicRuntime) ? { binding: bindingFor(dynamicRuntime) } : {}),
      });
      assert.equal(output, "external");
      assert.equal(runtimeKindReads, 1);
      assert.equal(runtimeProfileReads, 1);
      assert.equal(runtimeCommandReads, 1);
      assert.equal(runtimeEndpointReads, 1);
      assert.equal(runtimeMetadataReads, 1);
      assert.equal(nodeRuntimeReads, runtimeSource === "node" ? 1 : 0);
      assert.equal(validateCalls, 1);
      assert.equal(envelopeCalls, 1);
      assert.equal(nativeCalls, 0);
      const dynamicEnvelope = envelopes[0];
      assert.ok(dynamicEnvelope);
      assert.equal(dynamicEnvelope.node.id, CODE_MODE_NODE.id);
      assert.equal(dynamicEnvelope.runtime.kind, "dynamic-runtime-source");
      if (runtimeSource === "binding") {
        assert.equal(dynamicEnvelope.binding?.runtime.kind, "dynamic-runtime-source");
        assert.equal(dynamicEnvelope.binding?.nodeId, CODE_MODE_NODE.id);
        assert.strictEqual(dynamicEnvelope.binding?.runtime, dynamicEnvelope.runtime);
      } else {
        assert.equal(dynamicEnvelope.binding, undefined);
      }
      assert.doesNotMatch(
        JSON.stringify(dynamicEnvelope),
        /roster-native|dynamic-runtime-target/u,
      );

      const staticOutput = await runtimes.execute({
        ...request,
        node: { ...CODE_MODE_NODE, runtime: staticRuntime },
        ...(bindingFor(staticRuntime) ? { binding: bindingFor(staticRuntime) } : {}),
      });
      assert.equal(staticOutput, "external");
      assert.equal(envelopes[1]?.executionId, dynamicEnvelope.executionId);
      assert.equal(nativeCalls, 0);
    });
  }
});

test("dispatch detaches getter-returned aggregates before later getters can mutate routing", async (t) => {
  await t.test("binding runtime is complete before binding, node, and request getters continue", async () => {
    const privateSentinel = "RAW_PRIVATE_SENTINEL_MUST_NOT_REACH_NATIVE";
    const reads = new Map<string, number>();
    const order: string[] = [];
    const read = <Value>(name: string, value: () => Value): Value => {
      reads.set(name, (reads.get(name) ?? 0) + 1);
      order.push(name);
      return value();
    };
    const sourceCommand = ["safe-worker"];
    const sourceRuntimeMetadata = { route: "external", nested: { safe: true } };
    const sourceCapabilities = ["delegate"];
    const sourceNodeMetadata = { owner: "safe", nested: { safe: true } };
    const sourcePlacement = {
      get rosterId() {
        return read("placement.rosterId", () => "safe-roster");
      },
      get rosterVersion() {
        return read("placement.rosterVersion", () => "3");
      },
      get policyVersion() {
        return read("placement.policyVersion", () => "policy-v1");
      },
      get profileId() {
        return read("placement.profileId", () => "external-profile");
      },
      get reason() {
        return read("placement.reason", () => "safe placement");
      },
    };
    const sourceRuntime = {
      get kind() {
        return read("runtime.kind", () => "getter-safe-external");
      },
      get profile() {
        return read("runtime.profile", () => "safe-profile");
      },
      get command() {
        return read("runtime.command", () => sourceCommand);
      },
      get endpoint() {
        return read("runtime.endpoint", () => {
          sourceCommand.push("mutated-after-command");
          return "safe://worker";
        });
      },
      get metadata() {
        return read("runtime.metadata", () => sourceRuntimeMetadata);
      },
    };
    const nodeRuntime = { kind: "getter-safe-external" };
    const sourceNode = {
      get id() {
        return read("node.id", () => CODE_MODE_NODE.id);
      },
      get name() {
        return read("node.name", () => CODE_MODE_NODE.name);
      },
      get capabilities() {
        return read("node.capabilities", () => sourceCapabilities);
      },
      get parentId() {
        return read("node.parentId", () => {
          sourceCapabilities.push("mutated-after-capabilities");
          return "parent";
        });
      },
      get promptProfile() {
        return read("node.promptProfile", () => "safe-prompt");
      },
      get runtime() {
        return read("node.runtime", () => nodeRuntime);
      },
      get metadata() {
        return read("node.metadata", () => sourceNodeMetadata);
      },
    };
    const sourceBinding = {
      get runtime() {
        return read("binding.runtime", () => sourceRuntime);
      },
      get bindingId() {
        return read("binding.bindingId", () => "binding-getter-safe");
      },
      get nodeId() {
        return read("binding.nodeId", () => CODE_MODE_NODE.id);
      },
      get epoch() {
        return read("binding.epoch", () => {
          Reflect.defineProperty(sourceRuntime, "kind", {
            configurable: true,
            enumerable: true,
            value: "roster-native",
          });
          sourceRuntimeMetadata.route = "mutated-after-runtime";
          sourceRuntimeMetadata.nested.safe = false;
          return 7;
        });
      },
      get topologyVersion() {
        return read("binding.topologyVersion", () => "topology-getter-safe");
      },
      get sandboxId() {
        return read("binding.sandboxId", () => "sandbox-getter-safe");
      },
      get sessionId() {
        return read("binding.sessionId", () => "session-getter-safe");
      },
      get placement() {
        return read("binding.placement", () => sourcePlacement);
      },
    };
    let externalCalls = 0;
    let nativeAdapterCalls = 0;
    let requestExecuteCalls = 0;
    let privateSeenByNative = false;
    const runtimes = new NodeRuntimeRegistry([{
      kind: "getter-safe-external",
      executeEnvelope: async (envelope) => {
        externalCalls += 1;
        assert.deepEqual(envelope.runtime.command, ["safe-worker"]);
        assert.deepEqual(envelope.runtime.metadata, {
          route: "external",
          nested: { safe: true },
        });
        assert.deepEqual(envelope.node.capabilities, ["delegate"]);
        assert.deepEqual(envelope.node.metadata, {
          owner: "safe",
          nested: { safe: true },
        });
        assert.strictEqual(envelope.node.runtime, undefined);
        assert.strictEqual(envelope.binding?.runtime, envelope.runtime);
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: "external",
        };
      },
    }, {
      kind: "roster-native",
      execute: async (request) => {
        nativeAdapterCalls += 1;
        privateSeenByNative = JSON.stringify(request).includes(privateSentinel);
        return request.execute();
      },
    }]);
    const request = Object.defineProperties({}, {
      binding: {
        enumerable: true,
        get: () => read("request.binding", () => {
          nodeRuntime.kind = "roster-native";
          return sourceBinding;
        }),
      },
      node: {
        enumerable: true,
        get: () => read("request.node", () => {
          Reflect.defineProperty(sourceRuntime, "kind", {
            configurable: true,
            enumerable: true,
            value: "roster-native",
          });
          Object.defineProperty(sourcePlacement, "reason", {
            configurable: true,
            enumerable: true,
            value: "mutated-after-placement",
          });
          return sourceNode;
        }),
      },
      runId: {
        enumerable: true,
        get: () => read("request.runId", () => {
          sourceNodeMetadata.owner = "mutated-after-node";
          sourceNodeMetadata.nested.safe = false;
          return "getter-safe-run";
        }),
      },
      task: {
        enumerable: true,
        get: () => read("request.task", () => ({
          taskId: "getter-safe-task",
          nodeId: CODE_MODE_NODE.id,
          capability: "delegate",
        })),
      },
      input: {
        enumerable: true,
        get: () => read("request.input", () => ({ privateSentinel })),
      },
      execute: {
        enumerable: true,
        get: () => read("request.execute", () => async () => {
          requestExecuteCalls += 1;
          return "native";
        }),
      },
    }) as unknown as NodeExecutionRequest<string>;

    assert.equal(await runtimes.execute(request), "external");
    assert.equal(externalCalls, 1);
    assert.equal(nativeAdapterCalls, 0);
    assert.equal(requestExecuteCalls, 0);
    assert.equal(privateSeenByNative, false);
    for (const name of [
      "request.binding",
      "binding.runtime",
      "runtime.kind",
      "runtime.profile",
      "runtime.command",
      "runtime.endpoint",
      "runtime.metadata",
      "binding.bindingId",
      "binding.nodeId",
      "binding.epoch",
      "binding.topologyVersion",
      "binding.sandboxId",
      "binding.sessionId",
      "binding.placement",
      "placement.rosterId",
      "placement.rosterVersion",
      "placement.policyVersion",
      "placement.profileId",
      "placement.reason",
      "request.node",
      "node.id",
      "node.name",
      "node.capabilities",
      "node.parentId",
      "node.promptProfile",
      "node.metadata",
      "request.runId",
      "request.task",
      "request.input",
      "request.execute",
    ]) {
      assert.equal(reads.get(name), 1, `${name} must be read exactly once`);
    }
    assert.equal(reads.get("node.runtime"), undefined);
    assert.ok(order.indexOf("request.binding") < order.indexOf("binding.runtime"));
    assert.ok(order.indexOf("runtime.metadata") < order.indexOf("binding.bindingId"));
    assert.ok(order.indexOf("runtime.command") < order.indexOf("runtime.endpoint"));
    assert.ok(order.indexOf("placement.reason") < order.indexOf("request.node"));
    assert.ok(order.indexOf("node.capabilities") < order.indexOf("node.parentId"));
    assert.ok(order.indexOf("node.metadata") < order.indexOf("request.runId"));
  });

  await t.test("node runtime is complete before any later node getter", async () => {
    const reads = new Map<string, number>();
    const sourceRuntime = {
      get kind() {
        reads.set("runtime.kind", (reads.get("runtime.kind") ?? 0) + 1);
        return "getter-safe-node-runtime";
      },
    };
    const sourceNode = {
      get runtime() {
        reads.set("node.runtime", (reads.get("node.runtime") ?? 0) + 1);
        return sourceRuntime;
      },
      get id() {
        reads.set("node.id", (reads.get("node.id") ?? 0) + 1);
        Reflect.defineProperty(sourceRuntime, "kind", {
          configurable: true,
          enumerable: true,
          value: "roster-native",
        });
        return CODE_MODE_NODE.id;
      },
      name: CODE_MODE_NODE.name,
      capabilities: [...CODE_MODE_NODE.capabilities],
    };
    let envelopeCalls = 0;
    let nativeCalls = 0;
    const runtimes = new NodeRuntimeRegistry([{
      kind: "getter-safe-node-runtime",
      executeEnvelope: async (envelope) => {
        envelopeCalls += 1;
        assert.equal(envelope.runtime.kind, "getter-safe-node-runtime");
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: "external",
        };
      },
    }, {
      kind: "roster-native",
      execute: async (request) => {
        nativeCalls += 1;
        return request.execute();
      },
    }]);
    let bindingReads = 0;
    let nodeReads = 0;
    const request = Object.defineProperties({}, {
      binding: {
        enumerable: true,
        get: () => {
          bindingReads += 1;
          return undefined;
        },
      },
      node: {
        enumerable: true,
        get: () => {
          nodeReads += 1;
          return sourceNode;
        },
      },
      runId: { enumerable: true, value: "getter-safe-node-run" },
      task: {
        enumerable: true,
        value: {
          taskId: "getter-safe-node-task",
          nodeId: CODE_MODE_NODE.id,
          capability: "delegate",
        },
      },
      execute: {
        enumerable: true,
        value: async () => {
          nativeCalls += 1;
          return "native";
        },
      },
    }) as unknown as NodeExecutionRequest<string>;

    assert.equal(await runtimes.execute(request), "external");
    assert.equal(bindingReads, 1);
    assert.equal(nodeReads, 1);
    assert.equal(reads.get("node.runtime"), 1);
    assert.equal(reads.get("runtime.kind"), 1);
    assert.equal(reads.get("node.id"), 1);
    assert.equal(envelopeCalls, 1);
    assert.equal(nativeCalls, 0);
  });
});

test("metadata siblings detach in order and preserve ordinary execution identity", async () => {
  const envelopes: NodeExecutionEnvelope[] = [];
  const runtimes = new NodeRuntimeRegistry([{
    kind: "ordered-metadata",
    executeEnvelope: async (envelope) => {
      envelopes.push(envelope);
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "external",
      };
    },
  }]);
  const runtimeBefore = { stable: true };
  const nodeBefore = { stable: true };
  const reads = new Map<string, number>();
  const tracked = <Value>(name: string, read: () => Value): (() => Value) => () => {
    reads.set(name, (reads.get(name) ?? 0) + 1);
    return read();
  };
  const runtimeMetadata = Object.defineProperties({}, {
    before: {
      enumerable: true,
      get: tracked("runtime.metadata.before", () => runtimeBefore),
    },
    after: {
      enumerable: true,
      get: tracked("runtime.metadata.after", () => {
        runtimeBefore.stable = false;
        return "later";
      }),
    },
  });
  const nodeMetadata = Object.defineProperties({}, {
    before: {
      enumerable: true,
      get: tracked("node.metadata.before", () => nodeBefore),
    },
    after: {
      enumerable: true,
      get: tracked("node.metadata.after", () => {
        nodeBefore.stable = false;
        return "later";
      }),
    },
  });
  const common = {
    runId: "ordered-metadata",
    task: {
      taskId: "ordered-metadata",
      nodeId: CODE_MODE_NODE.id,
      capability: "delegate",
    },
    execute: async () => "native",
  };

  await runtimes.execute({
    ...common,
    node: {
      ...CODE_MODE_NODE,
      runtime: {
        kind: "ordered-metadata",
        metadata: {
          before: { stable: true },
          after: "later",
        },
      },
      metadata: {
        before: { stable: true },
        after: "later",
      },
    },
  });
  await runtimes.execute({
    ...common,
    node: {
      ...CODE_MODE_NODE,
      runtime: {
        kind: "ordered-metadata",
        metadata: runtimeMetadata,
      },
      metadata: nodeMetadata,
    },
  });

  assert.equal(envelopes.length, 2);
  assert.equal(envelopes[0]?.executionId, envelopes[1]?.executionId);
  assert.deepEqual(envelopes[1]?.runtime.metadata, {
    before: { stable: true },
    after: "later",
  });
  assert.deepEqual(envelopes[1]?.node.metadata, {
    before: { stable: true },
    after: "later",
  });
  assert.equal(reads.get("runtime.metadata.before"), 1);
  assert.equal(reads.get("runtime.metadata.after"), 1);
  assert.equal(reads.get("node.metadata.before"), 1);
  assert.equal(reads.get("node.metadata.after"), 1);
  assert.equal(Object.isFrozen(envelopes[1]?.runtime.metadata?.before), true);
  assert.equal(Object.isFrozen(envelopes[1]?.node.metadata?.before), true);
});

test("request data is acquired once and frozen before later getters and validation", async () => {
  const reads = new Map<string, number>();
  const tracked = <Value>(name: string, read: () => Value): (() => Value) => () => {
    reads.set(name, (reads.get(name) ?? 0) + 1);
    return read();
  };
  const mutable = {
    task: { taskId: "snapshot-task", nodeId: CODE_MODE_NODE.id, capability: "delegate" },
    target: {
      id: "snapshot-target",
      version: "1",
      objective: "Preserve acquisition values",
      acceptanceCriteria: ["before"],
      constraints: ["before"],
      contentHash: "target-hash",
    },
    input: { nested: { value: "before" } },
    resultContract: {
      mode: "json" as const,
      outputKey: "answer",
      schema: { type: "object" },
    },
    trace: { traceId: "a".repeat(32), spanId: "b".repeat(16), baggage: { phase: "before" } },
    skill: {
      id: "snapshot-skill",
      name: "Snapshot skill",
      description: "Proves stable request acquisition.",
      instructions: "Retain the first value.",
      contentHash: "ignored-and-recomputed",
    },
    tool: {
      id: "snapshot::tool",
      version: "1",
      capability: "delegate",
      description: "A snapshot tool.",
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      effects: ["read" as const],
    },
    attachment: {
      kind: "image" as const,
      attachmentId: "snapshot-image",
      name: "snapshot.png",
      mediaType: "image/png" as const,
      dataUrl: "data:image/png;base64,AA==",
    },
    artifact: {
      artifactId: "artifact-before",
      outputKey: "answer",
      kind: "report",
      contentHash: "artifact-hash",
    },
    workspace: {
      workspaceId: "workspace-before",
      inputs: {
        inputVersions: { request: "before" },
        dataReferences: [{
          source: "request",
          label: "before",
          contentHash: "reference-hash",
          mediaType: "application/json",
          byteLength: 1,
        }],
        frontierVersion: "frontier-before",
        topologyVersion: "topology-before",
        catalogVersion: "catalog-before",
      },
    },
    codeMode: { inputMode: "inline" as const, maxFunctionCalls: 2 },
  };
  const targetCriteria = mutable.target.acceptanceCriteria;
  const targetConstraints = mutable.target.constraints;
  const toolInputSchema = mutable.tool.inputSchema;
  const toolOutputSchema = mutable.tool.outputSchema;
  const toolEffects = mutable.tool.effects;
  const attachmentKind = mutable.attachment.kind;
  const attachmentId = mutable.attachment.attachmentId;
  let attachmentName = mutable.attachment.name;
  const attachmentMediaType = mutable.attachment.mediaType;
  const attachmentDataUrl = mutable.attachment.dataUrl;
  Object.defineProperties(mutable.target, {
    acceptanceCriteria: {
      enumerable: true,
      get: tracked("target.acceptanceCriteria", () => targetCriteria),
    },
    constraints: {
      enumerable: true,
      get: tracked("target.constraints", () => targetConstraints),
    },
  });
  Object.defineProperties(mutable.tool, {
    inputSchema: {
      enumerable: true,
      get: tracked("tool.inputSchema", () => toolInputSchema),
    },
    outputSchema: {
      enumerable: true,
      get: tracked("tool.outputSchema", () => toolOutputSchema),
    },
    effects: {
      enumerable: true,
      get: tracked("tool.effects", () => toolEffects),
    },
  });
  Object.defineProperties(mutable.attachment, {
    kind: { enumerable: true, get: tracked("attachment.kind", () => attachmentKind) },
    attachmentId: {
      enumerable: true,
      get: tracked("attachment.attachmentId", () => attachmentId),
    },
    name: { enumerable: true, get: tracked("attachment.name", () => attachmentName) },
    mediaType: {
      enumerable: true,
      get: tracked("attachment.mediaType", () => attachmentMediaType),
    },
    dataUrl: {
      enumerable: true,
      get: tracked("attachment.dataUrl", () => attachmentDataUrl),
    },
  });
  const mutateSources = (): void => {
    mutable.task.taskId = "mutated";
    targetCriteria[0] = "mutated";
    targetConstraints[0] = "mutated";
    mutable.input.nested.value = "mutated";
    mutable.resultContract.schema.type = "mutated";
    mutable.trace.baggage.phase = "mutated";
    mutable.skill.instructions = "mutated";
    toolInputSchema.type = "mutated";
    toolOutputSchema.type = "mutated";
    toolEffects[0] = "external";
    attachmentName = "mutated.png";
    mutable.artifact.artifactId = "mutated";
    mutable.workspace.workspaceId = "mutated";
    mutable.codeMode.maxFunctionCalls = 99;
  };
  const validateOutput = (value: unknown): boolean => value === "external";
  const invokeFunction = async (): Promise<never> => {
    throw new Error("not invoked");
  };
  const onLog = (): void => {};
  const onModelOutput = (): void => {};
  const onTrajectory = (): void => {};
  const onUsage = (): void => {};
  const execute = async (): Promise<string> => "native";
  const signal = new AbortController().signal;
  let observedEnvelope: NodeExecutionEnvelope | undefined;
  const adapter = bindPreparedNodeRuntimeExecutor({
    kind: "request-snapshot",
    supportsCodeMode: true,
    validateRuntime: () => mutateSources(),
  }, {
    execute: async (transport, control) => {
      observedEnvelope = transport.envelope;
      assert.strictEqual(control.onLog, onLog);
      assert.strictEqual(control.onModelOutput, onModelOutput);
      assert.strictEqual(control.onTrajectory, onTrajectory);
      assert.strictEqual(control.signal, signal);
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "external",
      };
    },
  });
  const runtimes = new NodeRuntimeRegistry([adapter]);
  const requestSurface = Object.defineProperties({}, {
    skills: {
      enumerable: true,
      get: tracked("surface.skills", () => [mutable.skill]),
    },
    tools: {
      enumerable: true,
      get: tracked("surface.tools", () => [mutable.tool]),
    },
    workspace: {
      enumerable: true,
      get: tracked("surface.workspace", () => mutable.workspace),
    },
    codeMode: {
      enumerable: true,
      get: tracked("surface.codeMode", () => mutable.codeMode),
    },
  });
  const request = Object.defineProperties({}, {
    binding: { enumerable: true, get: tracked("binding", () => undefined) },
    node: {
      enumerable: true,
      get: tracked("node", () => ({
        ...CODE_MODE_NODE,
        runtime: { kind: "request-snapshot" },
      })),
    },
    runId: { enumerable: true, get: tracked("runId", () => "request-snapshot") },
    task: { enumerable: true, get: tracked("task", () => mutable.task) },
    target: { enumerable: true, get: tracked("target", () => mutable.target) },
    input: { enumerable: true, get: tracked("input", () => mutable.input) },
    resultContract: {
      enumerable: true,
      get: tracked("resultContract", () => mutable.resultContract),
    },
    trace: { enumerable: true, get: tracked("trace", () => mutable.trace) },
    surface: { enumerable: true, get: tracked("surface", () => requestSurface) },
    attachments: {
      enumerable: true,
      get: tracked("attachments", () => [mutable.attachment]),
    },
    validateOutput: {
      enumerable: true,
      get: tracked("validateOutput", () => validateOutput),
    },
    artifacts: { enumerable: true, get: tracked("artifacts", () => [mutable.artifact]) },
    invokeFunction: {
      enumerable: true,
      get: tracked("invokeFunction", () => {
        mutateSources();
        return invokeFunction;
      }),
    },
    attempt: { enumerable: true, get: tracked("attempt", () => 1) },
    timeoutMs: { enumerable: true, get: tracked("timeoutMs", () => 1_000) },
    signal: { enumerable: true, get: tracked("signal", () => signal) },
    onLog: { enumerable: true, get: tracked("onLog", () => onLog) },
    onModelOutput: {
      enumerable: true,
      get: tracked("onModelOutput", () => onModelOutput),
    },
    onTrajectory: {
      enumerable: true,
      get: tracked("onTrajectory", () => onTrajectory),
    },
    onUsage: { enumerable: true, get: tracked("onUsage", () => onUsage) },
    execute: { enumerable: true, get: tracked("execute", () => execute) },
  }) as unknown as NodeExecutionRequest<string>;

  assert.equal(await runtimes.execute(request), "external");
  assert.ok(observedEnvelope);
  assert.equal(observedEnvelope.task.taskId, "snapshot-task");
  assert.deepEqual(observedEnvelope.target?.acceptanceCriteria, ["before"]);
  assert.deepEqual(observedEnvelope.target?.constraints, ["before"]);
  assert.equal(
    (observedEnvelope.input as { readonly contentHash: string }).contentHash,
    hashCanonical({ nested: { value: "before" } }),
  );
  assert.deepEqual(observedEnvelope.resultContract, {
    mode: "json",
    outputKey: "answer",
    schema: { type: "object" },
  });
  assert.equal(observedEnvelope.trace?.baggage?.phase, "before");
  assert.equal(observedEnvelope.surface.skills[0]?.instructions, "Retain the first value.");
  assert.deepEqual(observedEnvelope.surface.tools[0]?.inputSchema, { type: "object" });
  assert.deepEqual(observedEnvelope.surface.tools[0]?.outputSchema, { type: "string" });
  assert.deepEqual(observedEnvelope.surface.tools[0]?.effects, ["read"]);
  assert.equal(observedEnvelope.attachments?.[0]?.name, "snapshot.png");
  assert.equal(observedEnvelope.artifacts?.[0]?.artifactId, "artifact-before");
  assert.equal(observedEnvelope.surface.workspace?.workspaceId, "workspace-before");
  assert.equal(observedEnvelope.surface.codeMode?.maxFunctionCalls, 2);
  for (const name of [
    "binding", "node", "runId", "task", "target", "input", "resultContract",
    "trace", "surface", "surface.skills", "surface.tools", "surface.workspace",
    "surface.codeMode", "attachments", "validateOutput", "artifacts",
    "invokeFunction", "attempt", "timeoutMs", "signal",
    "onLog", "onModelOutput", "onTrajectory", "onUsage", "execute",
    "target.acceptanceCriteria", "target.constraints", "tool.inputSchema",
    "tool.outputSchema", "tool.effects", "attachment.kind",
    "attachment.attachmentId", "attachment.name", "attachment.mediaType",
    "attachment.dataUrl",
  ]) {
    assert.equal(reads.get(name), 1, `${name} must be read exactly once`);
  }
  for (const [name, value] of [
    ["envelope", observedEnvelope],
    ["node", observedEnvelope.node],
    ["task", observedEnvelope.task],
    ["target", observedEnvelope.target],
    ["target.acceptanceCriteria", observedEnvelope.target?.acceptanceCriteria],
    ["target.constraints", observedEnvelope.target?.constraints],
    ["input", observedEnvelope.input],
    ["resultContract", observedEnvelope.resultContract],
    ["trace", observedEnvelope.trace],
    ["surface", observedEnvelope.surface],
    ["surface.skills", observedEnvelope.surface.skills],
    ["surface.skill", observedEnvelope.surface.skills[0]],
    ["surface.tools", observedEnvelope.surface.tools],
    ["surface.tool", observedEnvelope.surface.tools[0]],
    ["surface.tool.inputSchema", observedEnvelope.surface.tools[0]?.inputSchema],
    ["surface.tool.effects", observedEnvelope.surface.tools[0]?.effects],
    ["attachments", observedEnvelope.attachments],
    ["attachment", observedEnvelope.attachments?.[0]],
    ["artifacts", observedEnvelope.artifacts],
    ["surface.workspace", observedEnvelope.surface.workspace],
    ["surface.workspace.inputs", observedEnvelope.surface.workspace?.inputs],
    ["surface.codeMode", observedEnvelope.surface.codeMode],
  ]) {
    assert.equal(Object.isFrozen(value), true, `${name} must be frozen`);
  }
});

test("roster-native preserves callback and signal identities on its frozen request", async () => {
  const validateOutput = (): boolean => true;
  const invokeFunction = async (): Promise<never> => {
    throw new Error("not invoked");
  };
  const onLog = (): void => {};
  const onModelOutput = (): void => {};
  const onTrajectory = (): void => {};
  const onUsage = (): void => {};
  const execute = async (): Promise<string> => "native";
  const signal = new AbortController().signal;
  const runtimes = new NodeRuntimeRegistry([{
    kind: "roster-native",
    execute: async (request) => {
      assert.equal(Object.isFrozen(request), true);
      assert.equal(Object.isFrozen(request.surface), true);
      for (const removedField of ["skills", "tools", "workspace", "codeMode"]) {
        assert.equal(removedField in request, false);
      }
      assert.strictEqual(request.validateOutput, validateOutput);
      assert.strictEqual(request.invokeFunction, invokeFunction);
      assert.strictEqual(request.onLog, onLog);
      assert.strictEqual(request.onModelOutput, onModelOutput);
      assert.strictEqual(request.onTrajectory, onTrajectory);
      assert.strictEqual(request.onUsage, onUsage);
      assert.strictEqual(request.execute, execute);
      assert.strictEqual(request.signal, signal);
      return request.execute();
    },
  }]);
  assert.equal(await runtimes.execute({
    runId: "native-callback-identities",
    node: { ...CODE_MODE_NODE, runtime: { kind: "roster-native" } },
    task: {
      taskId: "native-callback-identities",
      nodeId: CODE_MODE_NODE.id,
      capability: "delegate",
    },
    validateOutput,
    invokeFunction,
    signal,
    onLog,
    onModelOutput,
    onTrajectory,
    onUsage,
    execute,
  }), "native");
});

test("request snapshot rejects cyclic, unsupported, and over-deep JSON data", async () => {
  const runtimes = new NodeRuntimeRegistry([{
    kind: "snapshot-rejection",
    executeEnvelope: async () => ({
      schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
      status: "completed",
      output: "unexpected",
    }),
  }]);
  const execute = (input: JsonValue): Promise<string> => runtimes.execute({
    runId: "snapshot-rejection",
    node: { ...CODE_MODE_NODE, runtime: { kind: "snapshot-rejection" } },
    task: {
      taskId: "snapshot-rejection",
      nodeId: CODE_MODE_NODE.id,
      capability: "delegate",
    },
    input,
    execute: async () => "native",
  });
  const cyclic: Record<string, JsonValue> = {};
  cyclic.self = cyclic;
  await assert.rejects(() => execute(cyclic), /contains cyclic data/u);
  await assert.rejects(
    () => execute({ unsupported: (() => undefined) as unknown as JsonValue }),
    /unsupported non-JSON data/u,
  );
  await assert.rejects(
    () => execute({ nonFinite: Number.NaN }),
    /contains a non-finite number/u,
  );
  const deep: Record<string, JsonValue> = {};
  let cursor = deep;
  for (let depth = 0; depth < 102; depth += 1) {
    const next: Record<string, JsonValue> = {};
    cursor.next = next;
    cursor = next;
  }
  await assert.rejects(() => execute(deep), /exceeds snapshot depth/u);
});

test("request snapshot accepts only plain or null-prototype JSON records", async () => {
  const envelopes: NodeExecutionEnvelope[] = [];
  const runtimes = new NodeRuntimeRegistry([{
    kind: "plain-json-records",
    executeEnvelope: async (envelope) => {
      envelopes.push(envelope);
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "external",
      };
    },
  }]);
  const execute = (input: unknown): Promise<string> => runtimes.execute({
    runId: "plain-json-records",
    node: { ...CODE_MODE_NODE, runtime: { kind: "plain-json-records" } },
    task: {
      taskId: "plain-json-records",
      nodeId: CODE_MODE_NODE.id,
      capability: "delegate",
    },
    input: input as JsonValue,
    execute: async () => "native",
  });
  class JsonLookingClass {}
  let toJsonCalls = 0;
  const date = new Date(0);
  Object.defineProperty(date, "toJSON", {
    value: () => {
      toJsonCalls += 1;
      return {};
    },
  });
  for (const input of [
    date,
    new Map<string, string>(),
    new Set<string>(),
    new String("boxed"),
    new JsonLookingClass(),
  ]) {
    await assert.rejects(
      () => execute(input),
      /contains an unsupported non-plain JSON object/u,
    );
  }
  assert.equal(toJsonCalls, 0);
  assert.equal(envelopes.length, 0);

  const nullPrototype = Object.create(null) as Record<string, JsonValue>;
  nullPrototype.accepted = true;
  Object.defineProperty(nullPrototype, "__proto__", {
    value: { marker: "safe" },
    enumerable: true,
    writable: false,
    configurable: false,
  });
  assert.equal(await execute(Object.freeze(nullPrototype)), "external");
  assert.equal(envelopes.length, 1);
  assert.equal(
    (envelopes[0]?.input as Readonly<Record<string, JsonValue>>).accepted,
    true,
  );
  assert.deepEqual(Reflect.ownKeys(envelopes[0]?.input as object), [
    "accepted",
    "__proto__",
  ]);
  assert.equal(
    Object.getOwnPropertyDescriptor(envelopes[0]?.input, "__proto__")?.value.marker,
    "safe",
  );
  assert.strictEqual(Object.getPrototypeOf(envelopes[0]?.input), Object.prototype);
});

test("own __proto__ input content contributes to external execution identity", async () => {
  const envelopes: NodeExecutionEnvelope[] = [];
  const runtimes = new NodeRuntimeRegistry([{
    kind: "prototype-safe-identity",
    executeEnvelope: async (envelope) => {
      envelopes.push(envelope);
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "external",
      };
    },
  }]);
  const input = (marker: string): JsonValue => {
    const value = {};
    Object.defineProperty(value, "__proto__", {
      value: Object.freeze({ marker }),
      enumerable: true,
      writable: false,
      configurable: false,
    });
    return Object.freeze(value) as JsonValue;
  };
  const execute = (marker: string): Promise<string> => runtimes.execute({
    runId: "prototype-safe-identity",
    node: { ...CODE_MODE_NODE, runtime: { kind: "prototype-safe-identity" } },
    task: {
      taskId: "prototype-safe-identity",
      nodeId: CODE_MODE_NODE.id,
      capability: "delegate",
    },
    input: input(marker),
    execute: async () => "native",
  });

  assert.equal(await execute("A"), "external");
  assert.equal(await execute("B"), "external");
  assert.equal(envelopes.length, 2);
  assert.notEqual(envelopes[0]?.executionId, envelopes[1]?.executionId);
  assert.equal(
    Object.getOwnPropertyDescriptor(envelopes[0]?.input, "__proto__")?.value.marker,
    "A",
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(envelopes[1]?.input, "__proto__")?.value.marker,
    "B",
  );
});

test("external validation cannot mutate the canonical runtime snapshot", async () => {
  let validatedRuntime: WorkspaceNode["runtime"] | undefined;
  let envelopeCalls = 0;
  const runtimes = new NodeRuntimeRegistry([{
    kind: "immutable-external",
    validateRuntime: (runtime) => {
      validatedRuntime = runtime;
      assert.equal(Object.isFrozen(runtime), true);
      assert.equal(Object.isFrozen(runtime.command), true);
      assert.equal(Object.isFrozen(runtime.metadata), true);
      assert.equal(Object.isFrozen(runtime.metadata?.nested), true);
      assert.equal(Reflect.set(runtime, "kind", "roster-native"), false);
      assert.equal(Reflect.set(runtime.command!, "0", "mutated-worker"), false);
      assert.equal(Reflect.set(runtime.metadata!, "identity", "mutated"), false);
      assert.equal(
        Reflect.set(runtime.metadata?.nested as object, "stable", false),
        false,
      );
    },
    executeEnvelope: async (envelope) => {
      envelopeCalls += 1;
      assert.strictEqual(envelope.runtime, validatedRuntime);
      assert.deepEqual(envelope.runtime, {
        kind: "immutable-external",
        command: ["source-worker", "--stdio"],
        metadata: { identity: "source", nested: { stable: true } },
      });
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "external",
      };
    },
  }]);

  const output = await runtimes.execute({
    runId: "immutable-external",
    node: {
      ...CODE_MODE_NODE,
      runtime: {
        kind: "immutable-external",
        command: ["source-worker", "--stdio"],
        metadata: { identity: "source", nested: { stable: true } },
      },
    },
    task: {
      taskId: "immutable-external",
      nodeId: CODE_MODE_NODE.id,
      capability: "delegate",
    },
    execute: async () => "native",
  });
  assert.equal(output, "external");
  assert.equal(envelopeCalls, 1);
});

test("roster-native receives one canonical immutable node and binding snapshot", async () => {
  const sourceCapabilities = ["delegate", "implement"];
  const sourceNodeMetadata = { owner: "source", nested: { stable: true } };
  const sourceRuntimeCommand = ["native-inner-loop"];
  const sourceRuntimeMetadata = { identity: "native-source", nested: { stable: true } };
  const sourcePlacement = {
    rosterId: "native-roster",
    rosterVersion: "3",
    policyVersion: "native-policy-v1",
    profileId: "native-profile",
    reason: "direct canonical dispatch",
  };
  const sourceNode = {
    id: CODE_MODE_NODE.id,
    name: CODE_MODE_NODE.name,
    capabilities: sourceCapabilities,
    runtime: { kind: "roster-native" },
    metadata: sourceNodeMetadata,
  } as unknown as WorkspaceNode;
  const sourceBinding = {
    bindingId: "binding-native-canonical",
    nodeId: CODE_MODE_NODE.id,
    runtime: {
      kind: "roster-native",
      command: sourceRuntimeCommand,
      metadata: sourceRuntimeMetadata,
    },
    epoch: 4,
    topologyVersion: "topology-native-canonical",
    placement: sourcePlacement,
  };
  let validatedRuntime: WorkspaceNode["runtime"] | undefined;
  let nativeAdapterCalls = 0;
  let requestExecuteCalls = 0;
  const runtimes = new NodeRuntimeRegistry([{
    kind: "roster-native",
    validateRuntime: (runtime) => {
      validatedRuntime = runtime;
      assert.equal(Reflect.set(runtime, "kind", "mutated-native"), false);
      assert.equal(Reflect.set(runtime.command!, "0", "mutated-command"), false);
      assert.equal(Reflect.set(runtime.metadata!, "identity", "mutated"), false);
    },
    execute: async (request) => {
      nativeAdapterCalls += 1;
      sourceCapabilities.push("mutated");
      sourceNodeMetadata.owner = "mutated";
      sourcePlacement.reason = "mutated";
      sourceRuntimeCommand[0] = "mutated";
      sourceRuntimeMetadata.identity = "mutated";

      assert.equal(Object.isFrozen(request.node), true);
      assert.equal(Object.isFrozen(request.node.capabilities), true);
      assert.equal(Object.isFrozen(request.node.metadata), true);
      assert.equal(Object.isFrozen(request.binding), true);
      assert.equal(Object.isFrozen(request.binding?.placement), true);
      assert.strictEqual(request.node.runtime, validatedRuntime);
      assert.strictEqual(request.binding?.runtime, validatedRuntime);
      assert.equal(request.node.id, CODE_MODE_NODE.id);
      assert.deepEqual(request.node.capabilities, ["delegate", "implement"]);
      assert.deepEqual(request.node.metadata, {
        owner: "source",
        nested: { stable: true },
      });
      assert.deepEqual(request.binding?.placement, {
        rosterId: "native-roster",
        rosterVersion: "3",
        policyVersion: "native-policy-v1",
        profileId: "native-profile",
        reason: "direct canonical dispatch",
      });
      assert.deepEqual(request.node.runtime, {
        kind: "roster-native",
        command: ["native-inner-loop"],
        metadata: { identity: "native-source", nested: { stable: true } },
      });
      return request.execute();
    },
  }]);

  const output = await runtimes.execute({
    runId: "native-canonical-snapshot",
    node: sourceNode,
    binding: sourceBinding,
    task: {
      taskId: "native-canonical-snapshot",
      nodeId: CODE_MODE_NODE.id,
      capability: "delegate",
    },
    execute: async () => {
      requestExecuteCalls += 1;
      return "native-output";
    },
  });
  assert.equal(output, "native-output");
  assert.equal(nativeAdapterCalls, 1);
  assert.equal(requestExecuteCalls, 1);
});

test("runtime registry keeps registration authority structurally private", async () => {
  const privateSentinel = { value: "PRIVATE_PREPARED_BINDING_SENTINEL" };
  const rawRequestSentinel = "PRIVATE_RAW_REQUEST_SENTINEL";
  const environmentSentinel = "PRIVATE_PREPARED_ENVIRONMENT_SENTINEL";
  let preparedCalls = 0;
  let replacementPreparedCalls = 0;
  let envelopeCalls = 0;
  let nativeCalls = 0;
  let observedRawRequest = false;
  const preparedExecutor = async (
    transport: Parameters<Parameters<typeof bindPreparedNodeRuntimeExecutor>[1]["execute"]>[0],
  ) => {
    preparedCalls += 1;
    const serializedEnvelope = JSON.stringify(transport.envelope);
    observedRawRequest = serializedEnvelope.includes(rawRequestSentinel);
    assert.equal("execute" in transport.envelope, false);
    assert.equal("invokeFunction" in transport.envelope, false);
    assert.equal("validateOutput" in transport.envelope, false);
    assert.equal(
      transport.environment.ROSTER_PRIVATE_SENTINEL,
      environmentSentinel,
    );
    return {
      schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
      status: "completed" as const,
      output: "canonical-prepared-result",
    };
  };
  const rawAdapter: NodeRuntimeAdapter = {
    kind: "private-view-test",
    supportsCodeMode: true,
    executeEnvelope: async (envelope) => {
      envelopeCalls += 1;
      return {
        schemaVersion: envelope.schemaVersion,
        status: "completed",
        output: "canonical-envelope-result",
      };
    },
  };
  const preparedEnvironment = {
    ROSTER_PRIVATE_SENTINEL: environmentSentinel,
  };
  const preparedBinding = {
    environment: preparedEnvironment,
    execute: preparedExecutor,
  };
  bindPreparedNodeRuntimeExecutor(rawAdapter, preparedBinding);
  const runtimes = new NodeRuntimeRegistry([rawAdapter]);
  const publicView = runtimes.adapter("private-view-test");
  const registry = runtimes as unknown as Readonly<Record<PropertyKey, unknown>>;
  const guessedSymbols = [
    Symbol("registrations"),
    Symbol.for("NodeRuntimeRegistry.registrations"),
  ];

  assert.notStrictEqual(publicView, rawAdapter);
  assert.equal(Object.isFrozen(publicView), true);
  assert.equal(Object.getPrototypeOf(publicView), null);
  assert.deepEqual(Reflect.ownKeys(publicView), ["kind", "supportsCodeMode"]);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(publicView))) {
    assert.equal("get" in descriptor, false);
    assert.equal("set" in descriptor, false);
    assert.equal(
      typeof descriptor.value === "string" || typeof descriptor.value === "boolean",
      true,
    );
  }
  assert.equal(Object.values(publicView).includes(rawAdapter), false);
  assert.equal(Object.values(publicView).includes(preparedExecutor), false);
  assert.equal(JSON.stringify(publicView).includes(privateSentinel.value), false);
  assert.equal(Reflect.set(publicView, "kind", "roster-native"), false);
  assert.equal(
    Reflect.defineProperty(publicView, "execute", { value: async () => "mutated" }),
    false,
  );
  assert.deepEqual(
    Reflect.ownKeys(NodeRuntimeRegistry.prototype),
    ["constructor", "register", "adapter", "execute"],
  );
  assert.deepEqual(Reflect.ownKeys(runtimes), []);
  assert.deepEqual(Object.getOwnPropertyDescriptors(runtimes), {});
  assert.equal(registry.registrations, undefined);
  assert.equal(registry._registrations, undefined);
  assert.equal(registry["#registrations"], undefined);
  assert.equal(registry.registration, undefined);
  assert.equal(registry._registration, undefined);
  assert.equal(registry["#registration"], undefined);
  for (const symbol of guessedSymbols) {
    assert.equal(Reflect.has(runtimes, symbol), false);
    assert.equal(registry[symbol], undefined);
  }
  const reachable = reachableOwnDescriptorValues(runtimes, publicView);
  for (const privateValue of [
    rawAdapter,
    preparedBinding,
    preparedExecutor,
    preparedEnvironment,
    privateSentinel,
    privateSentinel.value,
    environmentSentinel,
    rawRequestSentinel,
  ]) {
    assert.equal(reachable.has(privateValue), false);
  }

  preparedBinding.execute = async () => {
    replacementPreparedCalls += 1;
    return {
      schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
      status: "completed",
      output: "replacement-prepared-result",
    };
  };

  const output = await runtimes.execute({
    runId: "private-view",
    node: {
      ...CODE_MODE_NODE,
      runtime: { kind: "private-view-test" },
    },
    task: { taskId: "inspect", nodeId: CODE_MODE_NODE.id, capability: "delegate" },
    input: { privateSentinel: rawRequestSentinel },
    surface: { codeMode: { inputMode: "external" } },
    execute: async () => {
      nativeCalls += 1;
      return "native-result";
    },
  });
  assert.equal(output, "canonical-prepared-result");
  assert.equal(preparedCalls, 1);
  assert.equal(replacementPreparedCalls, 0);
  assert.equal(envelopeCalls, 0);
  assert.equal(nativeCalls, 0);
  assert.equal(observedRawRequest, false);
});

test("runtime SDK names the exact runtime adapter public view", () => {
  const runtimes = new NodeRuntimeRegistry([{
    kind: "sdk-public-view",
    executeEnvelope: async (envelope) => ({
      schemaVersion: envelope.schemaVersion,
      status: "completed",
      output: "sdk-public-view",
    }),
  }]);
  const publicView: NodeRuntimeAdapterView = runtimes.adapter("sdk-public-view");

  assert.equal(publicView.kind, "sdk-public-view");
  assert.deepEqual(Reflect.ownKeys(publicView), ["kind"]);
});

test("registration rejects non-string kinds before trim or private retention", async () => {
  let selfReturningTrimCalls = 0;
  let proxyPropertyReads = 0;
  const selfReturningTrim = {
    trim() {
      selfReturningTrimCalls += 1;
      return this;
    },
  };
  const stringWrapper = new String("wrapped-runtime-kind");
  const proxiedKind = new Proxy({ private: true }, {
    get(target, property, receiver) {
      proxyPropertyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const cases = [
    { label: "self-returning-trim", kind: selfReturningTrim },
    { label: "string-wrapper", kind: stringWrapper },
    { label: "proxy", kind: proxiedKind },
  ] as const;

  for (const testCase of cases) {
    const privateSentinel = { label: testCase.label };
    const preparedEnvironment = {
      ROSTER_INVALID_KIND_PRIVATE: testCase.label,
    };
    let envelopeCalls = 0;
    let preparedCalls = 0;
    let nativeCalls = 0;
    const executeEnvelope = async () => {
      envelopeCalls += 1;
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed" as const,
        output: privateSentinel,
      };
    };
    const preparedExecutor = async () => {
      preparedCalls += 1;
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed" as const,
        output: privateSentinel,
      };
    };
    const rawAdapter = {
      kind: testCase.kind,
      supportsCodeMode: true,
      executeEnvelope,
    };
    const preparedBinding = {
      environment: preparedEnvironment,
      execute: preparedExecutor,
    };
    bindPreparedNodeRuntimeExecutor(
      rawAdapter as unknown as NodeRuntimeAdapter,
      preparedBinding,
    );
    const runtimes = new NodeRuntimeRegistry([]);

    assert.throws(
      () => runtimes.register(rawAdapter as unknown as NodeRuntimeAdapter),
      /kind must be a string/u,
    );
    assert.deepEqual(Reflect.ownKeys(runtimes), []);
    const reachable = reachableOwnDescriptorValues(runtimes);
    for (const privateValue of [
      testCase.kind,
      rawAdapter,
      executeEnvelope,
      preparedBinding,
      preparedEnvironment,
      preparedExecutor,
      privateSentinel,
    ]) {
      assert.equal(reachable.has(privateValue), false);
    }
    await assert.rejects(() => runtimes.execute({
      runId: `invalid-kind-${testCase.label}`,
      node: {
        ...CODE_MODE_NODE,
        runtime: { kind: `invalid-kind-${testCase.label}` },
      },
      task: {
        taskId: `invalid-kind-${testCase.label}`,
        nodeId: CODE_MODE_NODE.id,
        capability: "delegate",
      },
      surface: { codeMode: {} },
      execute: async () => {
        nativeCalls += 1;
        return "native";
      },
    }), /No node runtime adapter registered/u);
    assert.equal(envelopeCalls, 0);
    assert.equal(preparedCalls, 0);
    assert.equal(nativeCalls, 0);
  }
  assert.equal(selfReturningTrimCalls, 0);
  assert.equal(proxyPropertyReads, 0);
});

test("registration rejects non-executable hooks and malformed prepared bindings fail closed", async () => {
  const cases = [
    {
      label: "execute",
      adapterProperty: "execute",
      adapterValue: true,
      error: "Node runtime adapter invalid-registration-execute execute must be a function",
    },
    {
      label: "execute-envelope",
      adapterProperty: "executeEnvelope",
      adapterValue: { private: true },
      error: "Node runtime adapter invalid-registration-execute-envelope executeEnvelope must be a function",
    },
    {
      label: "validate-runtime",
      adapterProperty: "validateRuntime",
      adapterValue: "validate",
      error: "Node runtime adapter invalid-registration-validate-runtime validateRuntime must be a function",
    },
    {
      label: "prepared-execute",
      preparedExecute: 1,
      error: "Prepared node runtime binding invalid-registration-prepared-execute execute must be a function",
    },
    {
      label: "null-environment",
      preparedEnvironment: null,
      error:
        "Prepared node runtime binding invalid-registration-null-environment environment must be a non-null, non-array object",
    },
    {
      label: "string-environment",
      preparedEnvironment: "PRIVATE_ENVIRONMENT",
      error:
        "Prepared node runtime binding invalid-registration-string-environment environment must be a non-null, non-array object",
    },
    {
      label: "array-environment",
      preparedEnvironment: ["PRIVATE_ENVIRONMENT"],
      error:
        "Prepared node runtime binding invalid-registration-array-environment environment must be a non-null, non-array object",
    },
  ] as const;

  for (const testCase of cases) {
    const kind = `invalid-registration-${testCase.label}`;
    let executeCalls = 0;
    let envelopeCalls = 0;
    let validateCalls = 0;
    let preparedCalls = 0;
    let nativeCalls = 0;
    const rawAdapter: Record<PropertyKey, unknown> = {
      kind,
      execute: async () => {
        executeCalls += 1;
        return "execute";
      },
      executeEnvelope: async () => {
        envelopeCalls += 1;
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed" as const,
          output: "envelope",
        };
      },
      validateRuntime: () => {
        validateCalls += 1;
      },
    };
    if ("adapterProperty" in testCase) {
      rawAdapter[testCase.adapterProperty] = testCase.adapterValue;
    }
    const adapter = rawAdapter as unknown as NodeRuntimeAdapter;
    let preparedBinding: Record<PropertyKey, unknown> | undefined;
    if ("preparedExecute" in testCase || "preparedEnvironment" in testCase) {
      preparedBinding = {
        execute: "preparedExecute" in testCase
          ? testCase.preparedExecute
          : async () => {
            preparedCalls += 1;
            return {
              schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
              status: "completed" as const,
              output: "prepared",
            };
          },
        ...("preparedEnvironment" in testCase
          ? { environment: testCase.preparedEnvironment }
          : {}),
      };
      bindPreparedNodeRuntimeExecutor(
        adapter,
        preparedBinding as unknown as Parameters<typeof bindPreparedNodeRuntimeExecutor>[1],
      );
    }
    const runtimes = new NodeRuntimeRegistry([]);

    assert.throws(
      () => runtimes.register(adapter),
      { name: "Error", message: testCase.error },
    );
    assert.throws(
      () => runtimes.adapter(kind),
      { name: "Error", message: `No node runtime adapter registered for ${kind}` },
    );
    assert.deepEqual(Reflect.ownKeys(runtimes), []);
    assert.deepEqual(Object.getOwnPropertyDescriptors(runtimes), {});
    const reachable = reachableOwnDescriptorValues(runtimes);
    assert.equal(reachable.has(rawAdapter), false);
    if (preparedBinding) assert.equal(reachable.has(preparedBinding), false);
    await assert.rejects(() => runtimes.execute({
      runId: kind,
      node: { ...CODE_MODE_NODE, runtime: { kind } },
      task: { taskId: kind, nodeId: CODE_MODE_NODE.id, capability: "delegate" },
      surface: { codeMode: {} },
      execute: async () => {
        nativeCalls += 1;
        return "native";
      },
    }), { name: "Error", message: `No node runtime adapter registered for ${kind}` });
    assert.deepEqual({
      executeCalls,
      envelopeCalls,
      validateCalls,
      preparedCalls,
      nativeCalls,
    }, {
      executeCalls: 0,
      envelopeCalls: 0,
      validateCalls: 0,
      preparedCalls: 0,
      nativeCalls: 0,
    });
  }
});

test("registration rejects non-boolean code-mode support without retaining private objects", async () => {
  const cases = [
    "raw-adapter",
    "prepared-executor",
    "prepared-environment",
    "another-object",
  ] as const;

  for (const testCase of cases) {
    let adapterCalls = 0;
    let preparedCalls = 0;
    let nativeCalls = 0;
    const kind = `invalid-support-${testCase}`;
    const preparedEnvironment: NodeJS.ProcessEnv = {
      ROSTER_PRIVATE_ENVIRONMENT: "PRIVATE",
    };
    const anotherObject = { private: true };
    const rawAdapter = {
      kind,
      executeEnvelope: async () => {
        adapterCalls += 1;
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed" as const,
          output: "adapter",
        };
      },
    };
    const preparedExecutor = async (): Promise<{
      readonly schemaVersion: typeof NODE_EXECUTION_SCHEMA_VERSION;
      readonly status: "completed";
      readonly output: string;
    }> => {
      preparedCalls += 1;
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "prepared",
      };
    };
    const preparedBinding = {
      environment: preparedEnvironment,
      execute: preparedExecutor,
    };
    const supportValue: unknown = testCase === "raw-adapter"
      ? rawAdapter
      : testCase === "prepared-executor"
        ? preparedExecutor
        : testCase === "prepared-environment"
          ? preparedEnvironment
          : anotherObject;
    Object.defineProperty(rawAdapter, "supportsCodeMode", {
      value: supportValue,
      enumerable: true,
    });
    bindPreparedNodeRuntimeExecutor(
      rawAdapter as unknown as NodeRuntimeAdapter,
      preparedBinding,
    );
    const runtimes = new NodeRuntimeRegistry([]);

    assert.throws(
      () => runtimes.register(rawAdapter as unknown as NodeRuntimeAdapter),
      /supportsCodeMode must be a boolean/u,
    );
    assert.throws(() => runtimes.adapter(kind), /No node runtime adapter registered/u);
    await assert.rejects(() => runtimes.execute({
      runId: kind,
      node: { ...CODE_MODE_NODE, runtime: { kind } },
      task: { taskId: kind, nodeId: CODE_MODE_NODE.id, capability: "delegate" },
      surface: { codeMode: {} },
      execute: async () => {
        nativeCalls += 1;
        return "native";
      },
    }), /No node runtime adapter registered/u);
    assert.equal(adapterCalls, 0);
    assert.equal(preparedCalls, 0);
    assert.equal(nativeCalls, 0);
  }
});

test("registration rejects accessor-backed prepared environments without invoking getters", async () => {
  let environmentState = "BEFORE_REGISTRATION";
  let getterCalls = 0;
  let adapterCalls = 0;
  let preparedCalls = 0;
  let nativeCalls = 0;
  const environment: NodeJS.ProcessEnv = {};
  Object.defineProperty(environment, "ROSTER_DYNAMIC_VALUE", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return environmentState;
    },
  });
  const adapter: NodeRuntimeAdapter = {
    kind: "accessor-prepared-environment",
    supportsCodeMode: true,
    executeEnvelope: async () => {
      adapterCalls += 1;
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "adapter",
      };
    },
  };
  bindPreparedNodeRuntimeExecutor(adapter, {
    environment,
    execute: async () => {
      preparedCalls += 1;
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "prepared",
      };
    },
  });
  const runtimes = new NodeRuntimeRegistry([]);

  assert.throws(
    () => runtimes.register(adapter),
    /environment ROSTER_DYNAMIC_VALUE must be an own data property/u,
  );
  environmentState = "AFTER_REGISTRATION";
  assert.equal(getterCalls, 0);
  assert.throws(
    () => runtimes.adapter(adapter.kind),
    /No node runtime adapter registered/u,
  );
  await assert.rejects(() => runtimes.execute({
    runId: "accessor-prepared-environment",
    node: { ...CODE_MODE_NODE, runtime: { kind: adapter.kind } },
    task: {
      taskId: "accessor-prepared-environment",
      nodeId: CODE_MODE_NODE.id,
      capability: "delegate",
    },
    surface: { codeMode: {} },
    execute: async () => {
      nativeCalls += 1;
      return "native";
    },
  }), /No node runtime adapter registered/u);
  assert.equal(getterCalls, 0);
  assert.equal(adapterCalls, 0);
  assert.equal(preparedCalls, 0);
  assert.equal(nativeCalls, 0);
});

test("registration rejects symbol, non-primitive, and malformed prepared environment entries", () => {
  const symbolEnvironment: NodeJS.ProcessEnv = {};
  Object.defineProperty(symbolEnvironment, Symbol("private"), {
    value: "PRIVATE",
    enumerable: true,
  });
  const nonPrimitiveEnvironment: NodeJS.ProcessEnv = {};
  Object.defineProperty(nonPrimitiveEnvironment, "ROSTER_PRIVATE_OBJECT", {
    value: { private: true },
    enumerable: true,
  });
  const malformedEnvironment = new Proxy(Object.create(null) as NodeJS.ProcessEnv, {
    ownKeys: () => ["ROSTER_MALFORMED"],
    getOwnPropertyDescriptor: () => undefined,
  });
  const cases = [
    { name: "symbol", environment: symbolEnvironment, error: /keys must be strings/u },
    {
      name: "non-primitive",
      environment: nonPrimitiveEnvironment,
      error: /ROSTER_PRIVATE_OBJECT must be a string or undefined/u,
    },
    {
      name: "malformed",
      environment: malformedEnvironment,
      error: /ROSTER_MALFORMED must be an own data property/u,
    },
  ] as const;

  for (const testCase of cases) {
    const adapter: NodeRuntimeAdapter = {
      kind: `invalid-environment-${testCase.name}`,
      supportsCodeMode: true,
      executeEnvelope: async () => ({
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "adapter",
      }),
    };
    bindPreparedNodeRuntimeExecutor(adapter, {
      environment: testCase.environment,
      execute: async () => ({
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "prepared",
      }),
    });
    const runtimes = new NodeRuntimeRegistry([]);
    assert.throws(() => runtimes.register(adapter), testCase.error);
    assert.throws(
      () => runtimes.adapter(adapter.kind),
      /No node runtime adapter registered/u,
    );
  }
});

test("prepared environment and executor remain registration snapshots after source mutation", async () => {
  const sourceEnvironment: NodeJS.ProcessEnv = {
    ROSTER_SNAPSHOT_VALUE: "BEFORE_REGISTRATION",
  };
  let originalPreparedCalls = 0;
  let replacementPreparedCalls = 0;
  let nativeCalls = 0;
  const originalPreparedExecutor = async (
    transport: Parameters<Parameters<typeof bindPreparedNodeRuntimeExecutor>[1]["execute"]>[0],
  ) => {
    originalPreparedCalls += 1;
    return {
      schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
      status: "completed" as const,
      output: transport.environment.ROSTER_SNAPSHOT_VALUE,
    };
  };
  const adapter: NodeRuntimeAdapter = {
    kind: "prepared-environment-snapshot",
    supportsCodeMode: true,
    executeEnvelope: async () => ({
      schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
      status: "completed",
      output: "adapter",
    }),
  };
  const binding = {
    environment: sourceEnvironment,
    execute: originalPreparedExecutor,
  };
  bindPreparedNodeRuntimeExecutor(adapter, binding);
  const runtimes = new NodeRuntimeRegistry([adapter]);

  sourceEnvironment.ROSTER_SNAPSHOT_VALUE = "AFTER_REGISTRATION";
  binding.environment = { ROSTER_SNAPSHOT_VALUE: "REPLACED_BINDING" };
  binding.execute = async () => {
    replacementPreparedCalls += 1;
    return {
      schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
      status: "completed",
      output: "replacement",
    };
  };

  const output = await runtimes.execute({
    runId: "prepared-environment-snapshot",
    node: { ...CODE_MODE_NODE, runtime: { kind: adapter.kind } },
    task: {
      taskId: "prepared-environment-snapshot",
      nodeId: CODE_MODE_NODE.id,
      capability: "delegate",
    },
    surface: { codeMode: {} },
    execute: async () => {
      nativeCalls += 1;
      return "native";
    },
  });
  assert.equal(output, "BEFORE_REGISTRATION");
  assert.equal(originalPreparedCalls, 1);
  assert.equal(replacementPreparedCalls, 0);
  assert.equal(nativeCalls, 0);
});

test("non-code-mode envelope and roster-native execution paths remain unchanged", async () => {
  const nativeOutput = { answer: "same-reference" };
  const native = await new NodeRuntimeRegistry().execute({
    runId: "native-unchanged",
    node: { ...CODE_MODE_NODE, runtime: { kind: "roster-native" } },
    task: { taskId: "native", nodeId: CODE_MODE_NODE.id, capability: "delegate" },
    input: { inline: "still inline" },
    execute: async () => nativeOutput,
  });
  assert.strictEqual(native, nativeOutput);

  let commandInput = "";
  const adapter = createCommandNodeRuntimeAdapter({
    environment: { ROSTER_NON_CODE_ENV: "unchanged" },
    runner: async (execution) => {
      commandInput = execution.stdin;
      assert.equal(execution.env?.ROSTER_NON_CODE_ENV, "unchanged");
      assert.equal(execution.env?.ROSTER_CODE_TOOL_MANIFEST, undefined);
      assert.deepEqual(
        (JSON.parse(execution.stdin) as { readonly input?: unknown }).input,
        { inline: "still inline" },
      );
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: nativeOutput,
        }),
      };
    },
  });
  const command = await new NodeRuntimeRegistry([adapter]).execute({
    runId: "command-unchanged",
    node: { ...CODE_MODE_NODE, runtime: { kind: "shell", command: ["worker"] } },
    task: { taskId: "command", nodeId: CODE_MODE_NODE.id, capability: "delegate" },
    input: { inline: "still inline" },
    execute: async () => ({ answer: "native" }),
  });
  assert.deepEqual(command, nativeOutput);
  assert.equal(commandInput.endsWith("\n"), true);
});

test("generic shell workers receive the same code-mode client and an externalized envelope", async () => {
  const inputSecret = "SHELL_INPUT_MUST_STAY_OUTSIDE_THE_ENVELOPE";
  let clientDirectory = "";
  const adapter = createCommandNodeRuntimeAdapter({
    environment: { ROSTER_TEST_ENV: "present" },
    runner: async (execution) => {
      assert.equal(execution.env?.ROSTER_TEST_ENV, "present");
      assert.equal(execution.env?.ROSTER_CODE_TOOL_SOCKET, undefined);
      assert.ok(execution.env?.ROSTER_CODE_TOOL_MAILBOX_DIR);
      clientDirectory = (execution.env?.PATH ?? "").split(delimiter)[0] ?? "";
      assert.doesNotMatch(execution.stdin, new RegExp(inputSecret));
      const envelope = JSON.parse(execution.stdin) as {
        readonly input?: { readonly contextHandle?: unknown };
      };
      assert.equal(typeof envelope.input?.contextHandle, "string");
      const listed = await executeClient(execution, ["list"]);
      assert.equal(listed.exitCode, 0);
      assert.match(listed.stdout, /task\.input/u);
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: { answer: "shell" },
        }),
      };
    },
  });
  const node: WorkspaceNode = {
    ...CODE_MODE_NODE,
    runtime: { kind: "shell", command: ["bounded-worker", "--json"] },
  };
  const output = await new NodeRuntimeRegistry([adapter]).execute({
    runId: "code-mode-shell",
    node,
    task: { taskId: "inspect", nodeId: node.id, capability: "delegate" },
    input: { secret: inputSecret },
    surface: { codeMode: { inputMode: "external" } },
    resultContract: {
      mode: "json",
      outputKey: "answer",
      schema: { type: "object", required: ["answer"] },
    },
    validateOutput: (candidate) => Boolean(candidate)
      && candidate !== null
      && typeof candidate === "object"
      && "answer" in candidate,
    execute: async () => ({ answer: "native" }),
  });
  assert.deepEqual(output, { answer: "shell" });
  assert.equal(await stat(clientDirectory).then(() => true, () => false), false);
});

test("code mode rejects oversized configuration and context before launching a worker", async () => {
  let launched = false;
  const adapter = createCommandNodeRuntimeAdapter({
    runner: async () => {
      launched = true;
      throw new Error("worker must not launch");
    },
  });
  const runtimes = new NodeRuntimeRegistry([adapter]);
  const node: WorkspaceNode = {
    ...CODE_MODE_NODE,
    runtime: { kind: "shell", command: ["bounded-worker"] },
  };
  const request = {
    runId: "bounded-code-mode",
    node,
    task: { taskId: "inspect", nodeId: node.id, capability: "delegate" },
    input: { body: "x".repeat(2_048) },
    execute: async () => ({ answer: "native" }),
  };
  await assert.rejects(() => runtimes.execute({
    ...request,
    surface: { codeMode: { maxFunctionCalls: 129 } },
  }), /maxFunctionCalls exceeds hard maximum 128/u);
  await assert.rejects(() => runtimes.execute({
    ...request,
    surface: { codeMode: { inputMode: "external", maxValueBytes: 1_024 } },
  }), /task\.input exceeded maxValueBytes=1024/u);
  assert.equal(launched, false);
});

test("code mode fails closed for deliberately tool-free and remote runtimes", async () => {
  let piLaunched = false;
  const pi = new NodeRuntimeRegistry([createPiAgentNodeRuntimeAdapter({
    runner: async () => {
      piLaunched = true;
      return { exitCode: 0, stdout: '{"answer":"unexpected"}', stderr: "" };
    },
  })]);
  for (const metadata of [
    { noTools: true },
    { noBuiltinTools: true },
    { tools: ["read", "write"] },
    { excludeTools: ["bash"] },
  ]) {
    await assert.rejects(() => pi.execute({
      runId: "tool-free-pi",
      node: {
        ...CODE_MODE_NODE,
        runtime: {
          kind: "pi-agent",
          metadata: metadata as unknown as Readonly<Record<string, JsonValue>>,
        },
      },
      task: { taskId: "inspect", nodeId: CODE_MODE_NODE.id, capability: "delegate" },
      input: { context: "external" },
      surface: { codeMode: {} },
      execute: async () => ({ answer: "native" }),
    }), /cannot use code mode without its bash tool/u);
  }
  assert.equal(piLaunched, false);

  const remote = new NodeRuntimeRegistry([{
    kind: "a2a",
    executeEnvelope: async () => {
      throw new Error("remote transport must not launch");
    },
  }]);
  await assert.rejects(() => remote.execute({
    runId: "remote-code-mode",
    node: {
      ...CODE_MODE_NODE,
      runtime: { kind: "a2a", endpoint: "https://example.invalid/a2a" },
    },
    task: { taskId: "inspect", nodeId: CODE_MODE_NODE.id, capability: "delegate" },
    surface: { codeMode: {} },
    execute: async () => ({ answer: "native" }),
  }), /does not support code mode/u);
});

test("Pi exposes fenced Roster functions through a native read-only tool bridge", async () => {
  const runId = "pi-native-function-run";
  const trustedExtension = "/trusted/roster-pi-extension.mjs";
  const node: WorkspaceNode = {
    ...CODE_MODE_NODE,
    runtime: {
      kind: "pi-agent",
      metadata: {
        extensions: [trustedExtension],
        tools: ["read"],
        projectTrust: "no-approve",
      },
    },
  };
  const task = { taskId: "investigate", nodeId: node.id, capability: "delegate" } as const;
  const definition = createDynamicTaskDefinition({
    taskId: task.taskId,
    semanticKey: "pi-native-function-bridge",
    nodeId: task.nodeId,
    capability: task.capability,
    objective: "Exercise the admitted native Pi function bridge.",
    handler: { kind: "roster.runtime.direct", version: "1" },
    acceptance: { policyId: "roster.runtime.direct", policyVersion: "1" },
    result: { mode: "none" },
    dependencies: [],
    join: { kind: "all-success" },
    inputs: {
      inputVersions: {},
      dataReferences: [],
      frontierVersion: "pi-native-function-frontier",
      topologyVersion: "pi-native-function-topology",
      catalogVersion: "pi-native-function-catalog",
    },
    runtimeBindingEpoch: 0,
    retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
    timeoutMs: 0,
    sideEffect: "pure",
    estimatedCostMicros: 0,
  });
  const grant = createTaskExecutionGrant({
    runId,
    definition,
    attempt: 1,
    fence: 1,
    policyVersion: "pi-native-function-policy",
    policy: { maxTokens: 1_000, maxCostMicros: 0 },
    functionAccess: {
      functionGrants: [SHARED_RUNTIME_TOOL.id],
      allowedEffects: ["read"],
    },
    workspaceOperations: ["read"],
    tools: [SHARED_RUNTIME_TOOL],
    maxFunctionCalls: 3,
    riskClass: "read-only",
    rationale: "Admit exactly three native Pi function calls for this task.",
  });
  const invoked: Array<{
    readonly functionId: string;
    readonly value: JsonValue;
    readonly control: { readonly executionId: string; readonly runId: string; readonly nodeId: string; readonly taskId: string };
  }> = [];
  const runtimes = new NodeRuntimeRegistry([createPiAgentNodeRuntimeAdapter({
    runner: async (execution) => {
      const toolsIndex = execution.args.indexOf("--tools");
      assert.ok(toolsIndex >= 0);
      const tools = (execution.args[toolsIndex + 1] ?? "").split(",");
      assert.ok(tools.includes("read"));
      assert.ok(tools.includes("roster_workspace_surface_check"));
      assert.ok(!tools.includes("bash"));
      assert.ok(!tools.includes("write"));
      assert.ok(!tools.includes("edit"));
      assert.equal(execution.args.filter((argument) => argument === "--no-extensions").length, 1);
      const extensionPaths = execution.args.flatMap((argument, index) =>
        execution.args[index - 1] === "--extension" ? [argument] : []);
      assert.equal(extensionPaths.length, 2);
      assert.equal(extensionPaths[1], trustedExtension);
      const bridgePath = extensionPaths.find((path) => path.includes("roster-pi-function-bridge"));
      assert.ok(bridgePath);
      const bridgeModule = await import(`${pathToFileURL(bridgePath).href}?test=${randomUUID()}`) as {
        readonly default: (pi: { registerTool: (tool: unknown) => void }) => void;
      };
      let registered: {
        readonly name: string;
        readonly execute: (
          toolCallId: string,
          params: JsonValue,
          signal: AbortSignal,
        ) => Promise<{ readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }> }>;
      } | undefined;
      bridgeModule.default({ registerTool: (tool) => { registered = tool as typeof registered; } });
      assert.equal(registered?.name, "roster_workspace_surface_check");
      const bridgeEnvironmentKeys = [
        "PATH",
        "ROSTER_CODE_TOOL_MAILBOX_DIR",
        "ROSTER_CODE_TOOL_MANIFEST",
        "ROSTER_CODE_TOOL_GENERATION",
        "ROSTER_CODE_TOOL_MARKER",
        "ROSTER_CODE_TOOL_VALUE_DIR",
      ] as const;
      const previousEnvironment = Object.fromEntries(
        bridgeEnvironmentKeys.map((key) => [key, process.env[key]]),
      );
      try {
        for (const key of bridgeEnvironmentKeys) {
          const value = execution.env?.[key];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        for (let call = 1; call <= 3; call += 1) {
          const result = await registered!.execute(
            `tool-call-${String(call)}`,
            { message: `LLM-authored progress ${String(call)}` },
            new AbortController().signal,
          );
          assert.match(result.content[0]?.text ?? "", /delivered/u);
        }
        await assert.rejects(() => registered!.execute(
          "tool-call-4",
          { message: "Unadmitted fourth update" },
          new AbortController().signal,
        ), /Roster function call failed/u);
      } finally {
        for (const key of bridgeEnvironmentKeys) {
          const value = previousEnvironment[key];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"answer\\":\\"pi-native-bridge\\"}"}]}}',
      };
    },
  })]);
  const output = await runtimes.execute({
    runId,
    node,
    task,
    grant,
    surface: { tools: [SHARED_RUNTIME_TOOL] },
    resultContract: {
      mode: "json",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["answer"],
        properties: { answer: { type: "string" } },
      },
    },
    invokeFunction: async (invocation, control) => {
      invoked.push({ functionId: invocation.functionId, value: invocation.value, control });
      return {
        status: "completed",
        functionId: invocation.functionId,
        providerId: "test-provider",
        output: { state: "visible" },
      };
    },
    execute: async () => ({ answer: "native" }),
  });
  assert.deepEqual(output, { answer: "pi-native-bridge" });
  assert.equal(invoked.length, 3);
  assert.ok(invoked.every(({ functionId }) => functionId === SHARED_RUNTIME_TOOL.id));
  assert.deepEqual(invoked.map(({ value }) => value), [
    { message: "LLM-authored progress 1" },
    { message: "LLM-authored progress 2" },
    { message: "LLM-authored progress 3" },
  ]);
  assert.ok(invoked.every(({ control }) => /^node_execution_[a-f0-9]{28}$/u.test(control.executionId)));
  assert.ok(invoked.every(({ control }) => control.runId === runId));
  assert.ok(invoked.every(({ control }) => control.nodeId === node.id));
  assert.ok(invoked.every(({ control }) => control.taskId === task.taskId));
});

test("canceling the parent execution aborts an in-flight worker function", async () => {
  const descriptor = workerFunctionDescriptor();
  const directory = new RosterFunctionDirectory([descriptor]);
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  let providerAborted = false;
  directory.bindProvider({
    providerId: "cancelable-roster-scheduler",
    functionId: descriptor.id,
    epoch: 1,
    invoke: async (_value, control) => new Promise((_resolve, reject) => {
      startedResolve?.();
      control.signal.addEventListener("abort", () => {
        providerAborted = true;
        reject(control.signal.reason);
      }, { once: true });
    }),
  });
  const plane = createRosterFunctionExecutionPlane({
    directory,
    access: () => ({
      functionGrants: [descriptor.id],
      allowedEffects: ["external"],
    }),
  });
  const task = {
    taskId: "cancel-root",
    nodeId: CODE_MODE_NODE.id,
    capability: "delegate",
  };
  const controller = new AbortController();
  const adapter = createCodexCliNodeRuntimeAdapter({
    runner: async (execution) => {
      const searched = await executeClient(
        execution,
        ["call", ROSTER_CATALOG_SEARCH_FUNCTION_ID],
        JSON.stringify({ query: "delegate-test" }),
      );
      const searchHandle = contextHandle(searched.stdout);
      const materialized = await executeClient(execution, ["materialize", searchHandle]);
      const catalogPath = (JSON.parse(materialized.stdout) as { readonly path?: unknown }).path;
      assert.equal(typeof catalogPath, "string");
      const catalog = JSON.parse(await readFile(catalogPath as string, "utf8")) as {
        readonly catalogVersion: string;
        readonly entries: ReadonlyArray<{
          readonly id: string;
          readonly version: string;
          readonly providers: ReadonlyArray<{ readonly providerId: string; readonly epoch: number }>;
        }>;
      };
      const entry = catalog.entries.find((candidate) => candidate.id === descriptor.id);
      const provider = entry?.providers[0];
      assert.ok(entry);
      assert.ok(provider);
      const call = executeClient(
        execution,
        ["call", ROSTER_CATALOG_INVOKE_FUNCTION_ID],
        JSON.stringify({
          operation: "call",
          catalogVersion: catalog.catalogVersion,
          functionId: entry.id,
          functionVersion: entry.version,
          providerId: provider.providerId,
          providerEpoch: provider.epoch,
          value: {
            idempotencyKey: "cancel-child",
            objective: "Wait until the parent is canceled.",
            childCapability: "inspect",
            outputContract: true,
          },
        }),
      );
      await started;
      controller.abort(new Error("operator canceled recursive execution"));
      await call;
      throw new Error("canceled tool call unexpectedly completed");
    },
  });

  await assert.rejects(() => new NodeRuntimeRegistry([adapter]).execute({
    runId: "cancel-code-mode",
    node: CODE_MODE_NODE,
    task,
    surface: {
      tools: plane.functionTools(CODE_MODE_NODE, task),
      codeMode: {},
    },
    invokeFunction: plane.functionInvoker(CODE_MODE_NODE, task),
    signal: controller.signal,
    execute: async () => ({ answer: "native" }),
  }), /operator canceled recursive execution|Node command was aborted/u);
  assert.equal(providerAborted, true);
});

const directMailboxEnvelope = (
  executionId = "direct-mailbox-test",
  options: {
    readonly input?: JsonValue;
    readonly inputMode?: "inline" | "external";
    readonly tools?: ReadonlyArray<RosterFunctionDescriptor>;
  } = {},
): NodeExecutionEnvelope => ({
  schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
  executionId,
  runId: "direct-mailbox-run",
  node: { id: "mailbox-node", name: "Mailbox Node", capabilities: ["delegate"] },
  runtime: { kind: "shell", command: ["worker"] },
  task: { taskId: "mailbox-task", nodeId: "mailbox-node", capability: "delegate" },
  ...(options.input !== undefined ? { input: options.input } : {}),
  resultContract: { mode: "json", outputKey: "answer", schema: { type: "object" } },
  surface: createNodeExecutionSurface({
    tools: options.tools,
    codeMode: {
      schemaVersion: "roster.node-code-mode.v3",
      inputMode: options.inputMode ?? "inline",
      maxFunctionCalls: 4,
      maxContextValues: 8,
      maxContextBytes: 64 * 1_024,
      maxValueBytes: 16 * 1_024,
      maxObservationBytes: 1_024,
      maxRequestBytes: 16 * 1_024,
    },
  }),
});

test("code-mode consultation guidance separates peer identity from function discovery", () => {
  const base = directMailboxEnvelope("consultation-prompt", {
    input: {
      eligiblePeers: [{
        nodeId: "quality-peer",
        name: "Quality Peer",
        capabilities: ["respond"],
      }],
    },
  });
  const tool = (id: string): RosterFunctionTool => ({
    id,
    version: "1",
    capability: "roster.catalog",
    description: `Use ${id}`,
    inputSchema: true,
    outputSchema: true,
    effects: ["read"],
  });
  const prompt = compileNodeExecutionPrompt({
    ...base,
    grant: {
      functionAccess: { functionGrants: ["roster::consult"] },
    } as NodeExecutionEnvelope["grant"],
    surface: {
      ...base.surface,
      tools: [
        tool(ROSTER_CATALOG_SEARCH_FUNCTION_ID),
        tool(ROSTER_CATALOG_INVOKE_FUNCTION_ID),
      ],
    },
  });

  assert.match(prompt, /inspect the `task\.input` context handle to read `eligiblePeers`/u);
  assert.match(prompt, /Do not search the function catalog for peer identities/u);
  assert.match(prompt, /Search it for `consult` without a capability filter/u);
  assert.match(prompt, /call `roster::catalog\.invoke`/u);
});

test("direct A2A code-mode execution fails before network access", async () => {
  let requests = 0;
  const adapter = createA2ANodeRuntimeAdapter({
    fetch: async () => {
      requests += 1;
      throw new Error("network must not be reached");
    },
  });
  await assert.rejects(() => adapter.executeEnvelope!({
    ...directMailboxEnvelope("direct-a2a-code-mode"),
    runtime: { kind: "a2a", endpoint: "https://example.invalid/execute" },
  }, {}), /does not support code mode/u);
  assert.equal(requests, 0);
});

const mailboxRequestIdForTest = (): string => randomUUID();

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const waitUntilAsync = async (predicate: () => Promise<boolean>, label: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const throwingWatcher = (code: "EMFILE" | "ENOSPC") => (): NodeCodeModeWatcher => {
  throw Object.assign(new Error(`watcher ${code}`), { code });
};

test("undefined cleanup failures are normalized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-failure-truth-"));
  try {
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope(),
      directory,
      watcherFactory: throwingWatcher("EMFILE"),
      removeFile: async () => { throw undefined; },
      directoryReader: async () => [],
    });
    await assert.rejects(prepared.close(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { readonly originalValue?: unknown }).originalValue, undefined);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("late normal scan failures are the close failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-late-scan-failure-"));
  const lateFailure = new Error("late scan failure");
  let scans = 0;
  let releaseScan: (() => void) | undefined;
  try {
    const heldScan = new Promise<ReadonlyArray<string>>((_resolve, reject) => {
      releaseScan = () => reject(lateFailure);
    });
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope(),
      directory,
      watcherFactory: throwingWatcher("EMFILE"),
      directoryReader: async () => {
        scans += 1;
        return scans === 1 ? heldScan : [];
      },
    });
    await waitUntil(() => scans === 1, "held late-failure scan");
    const closing = prepared.close();
    releaseScan?.();
    await assert.rejects(closing, (error: unknown) => error === lateFailure);
  } finally {
    releaseScan?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fallback reaches its exact scan cap and reports the cap failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-scan-cap-"));
  const delays: number[] = [];
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const scheduler: NodeCodeModeScheduler = {
    setTimeout: (callback, delayMs) => {
      delays.push(delayMs);
      const id = ++nextTimer;
      timers.set(id, callback);
      queueMicrotask(() => {
        const next = timers.get(id);
        timers.delete(id);
        next?.();
      });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimeout: (timer) => { timers.delete(timer as unknown as number); },
  };
  try {
    let scans = 0;
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope(),
      directory,
      watcherFactory: throwingWatcher("EMFILE"),
      scheduler,
      directoryReader: async () => {
        scans += 1;
        return [];
      },
    });
    await waitUntil(() => scans === 128, "the configured mailbox scan cap");
    assert.equal(scans, 128);
    assert.deepEqual(delays.slice(0, 6), [50, 100, 200, 400, 500, 500]);
    await assert.rejects(prepared.close(), /scan exhausted scanCount=128/u);
    await assert.rejects(stat(prepared.environment.ROSTER_CODE_TOOL_MARKER!), /ENOENT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("watcher setup failure has a bounded cleanup deadline and dual-error report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-setup-failure-"));
  try {
    const started = Date.now();
    await assert.rejects(() => prepareNodeCodeMode({
      envelope: directMailboxEnvelope(),
      directory,
      watcherFactory: () => { throw new Error("synchronous watcher setup failure"); },
      removeFile: async () => new Promise<void>(() => undefined),
    }), (error: unknown) => {
      assert.match(String(error), /synchronous watcher setup failure/u);
      assert.match(String((error as { readonly cleanupError?: unknown }).cleanupError), /setup cleanup did not settle/u);
      return true;
    });
    assert.ok(Date.now() - started < 1_400);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pre-close fallback ENOENT is retained as the exact failure and is not retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-enoent-"));
  const failure = Object.assign(new Error("distinctive pre-close ENOENT"), { code: "ENOENT" });
  let calls = 0;
  try {
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope(),
      directory,
      watcherFactory: throwingWatcher("EMFILE"),
      directoryReader: async () => {
        calls += 1;
        if (calls === 1) throw failure;
        return [];
      },
    });
    await waitUntil(() => calls === 1, "first fallback scan");
    await assert.rejects(prepared.close(), (error: unknown) => error === failure);
    assert.equal(calls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("teardown directory-reader ENOENT is idempotent after generation removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-teardown-enoent-"));
  let reads = 0;
  try {
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope(),
      directory,
      watcherFactory: throwingWatcher("EMFILE"),
      directoryReader: async (mailboxDirectory) => {
        reads += 1;
        if (reads === 1) return [];
        const generationDirectory = dirname(mailboxDirectory);
        await waitUntilAsync(
          async () => !(await stat(generationDirectory).then(() => true, () => false)),
          "generation removal before teardown read",
        );
        throw Object.assign(new Error("teardown generation disappeared"), { code: "ENOENT" });
      },
    });
    await waitUntil(() => reads === 1, "initial fallback scan");
    await prepared.close();
    assert.equal(reads, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("close bounds marker invalidation, scan, and mailbox drain by one absolute second", async () => {
  const markerDirectory = await mkdtemp(join(tmpdir(), "roster-code-mode-marker-close-"));
  try {
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope(),
      directory: markerDirectory,
      watcherFactory: throwingWatcher("EMFILE"),
      removeFile: async () => new Promise<void>(() => undefined),
    });
    const started = Date.now();
    await assert.rejects(prepared.close(), /marker invalidation did not settle/u);
    assert.ok(Date.now() - started < 1_400);
  } finally {
    await rm(markerDirectory, { recursive: true, force: true });
  }

  const scanDirectory = await mkdtemp(join(tmpdir(), "roster-code-mode-scan-close-"));
  let releaseScan: (() => void) | undefined;
  try {
    const heldScan = new Promise<ReadonlyArray<string>>((resolve) => { releaseScan = () => resolve([]); });
    let scans = 0;
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope(),
      directory: scanDirectory,
      watcherFactory: throwingWatcher("ENOSPC"),
      directoryReader: async () => {
        scans += 1;
        return heldScan;
      },
    });
    await waitUntil(() => scans === 1, "held scan");
    let settled = false;
    const closing = prepared.close().finally(() => { settled = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false);
    releaseScan?.();
    await closing;
  } finally {
    releaseScan?.();
    await rm(scanDirectory, { recursive: true, force: true });
  }
});

test("never-settling fallback scan rejects at the shared shutdown deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-never-scan-"));
  const never = new Promise<ReadonlyArray<string>>(() => undefined);
  try {
    let scans = 0;
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope(),
      directory,
      watcherFactory: throwingWatcher("EMFILE"),
      directoryReader: async () => {
        scans += 1;
        return never;
      },
    });
    await waitUntil(() => scans === 1, "never-settling scan");
    const started = Date.now();
    await assert.rejects(prepared.close(), /mailbox scan did not settle before shutdown budget=1000ms/u);
    assert.ok(Date.now() - started < 1_400);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normal held scan stays pending until released and cleanup reads an empty mailbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-held-scan-"));
  let release: (() => void) | undefined;
  let calls = 0;
  const held = new Promise<ReadonlyArray<string>>((resolve) => { release = () => resolve([]); });
  try {
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope(),
      directory,
      watcherFactory: throwingWatcher("EMFILE"),
      directoryReader: async () => {
        calls += 1;
        return calls === 1 ? held : [];
      },
    });
    await waitUntil(() => calls === 1, "held normal scan");
    let settled = false;
    const closing = prepared.close().finally(() => { settled = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false);
    release?.();
    await closing;
    assert.equal(calls, 2);
  } finally {
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("combined fallback scan and mailbox job share one in-process close deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-combined-close-"));
  let emitError: ((error: Error) => void) | undefined;
  let dispatch!: (filename: string | Buffer | null) => void;
  let scans = 0;
  let releaseScan: (() => void) | undefined;
  let releaseJob: (() => void) | undefined;
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const descriptor = workerFunctionDescriptor();
  const watcher: NodeCodeModeWatcher = {
    close: () => undefined,
    on: (_event, listener) => { emitError = listener; return watcher; },
  };
  let releaseScanTimer: NodeJS.Timeout | undefined;
  let releaseJobTimer: NodeJS.Timeout | undefined;
  try {
    const heldScan = new Promise<ReadonlyArray<string>>((resolve) => { releaseScan = () => resolve([]); });
    const heldJob = new Promise<{
      readonly status: "completed";
      readonly functionId: string;
      readonly providerId: string;
      readonly output: JsonValue;
    }>((resolve) => {
      releaseJob = () => resolve({
        status: "completed",
        functionId: descriptor.id,
        providerId: "combined-provider",
        output: { late: true },
      });
    });
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope("combined-close", { tools: [descriptor] }),
      directory,
      watcherFactory: (_path, callback) => { dispatch = callback; return watcher; },
      directoryReader: async () => {
        scans += 1;
        return scans === 1 ? heldScan : [];
      },
      invokeFunction: async () => {
        startedResolve?.();
        return heldJob;
      },
    });
    const generationDirectory = prepared.clientDirectory;
    emitError?.(Object.assign(new Error("watcher resource limit"), { code: "EMFILE" }));
    await waitUntil(() => scans === 1, "combined held fallback scan");
    const mailbox = prepared.environment.ROSTER_CODE_TOOL_MAILBOX_DIR;
    assert.ok(mailbox);
    const requestId = mailboxRequestIdForTest();
    const requestName = `request-${requestId}.json`;
    await writeFile(join(mailbox, requestName), JSON.stringify({
      expectedGeneration: prepared.environment.ROSTER_CODE_TOOL_GENERATION,
      op: "call",
      functionId: descriptor.id,
      value: {},
    }));
    dispatch(requestName);
    await started;
    const closeStarted = Date.now();
    const closing = prepared.close();
    releaseScanTimer = setTimeout(() => releaseScan?.(), 600);
    releaseJobTimer = setTimeout(() => releaseJob?.(), 1_200);
    await assert.rejects(closing, /mailbox jobs did not settle before shutdown budget=1000ms/u);
    const elapsed = Date.now() - closeStarted;
    assert.ok(elapsed >= 900 && elapsed < 1_300, `close elapsed ${elapsed}ms`);
    await waitUntilAsync(async () => (await stat(generationDirectory).then(() => true, () => false)) === false, "combined eventual teardown");
  } finally {
    if (releaseScanTimer) clearTimeout(releaseScanTimer);
    if (releaseJobTimer) clearTimeout(releaseJobTimer);
    releaseScan?.();
    releaseJob?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("child process stays live through the combined close deadline and exits normally", async () => {
  const modulePath = join(process.cwd(), "src/engine/runtime/node-code-mode.ts");
  const envelope = directMailboxEnvelope("combined-child-close", {
    tools: [workerFunctionDescriptor()],
  });
  const descriptor = workerFunctionDescriptor();
  const source = `
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
const { prepareNodeCodeMode } = await import(${JSON.stringify(modulePath)});
const envelope = ${JSON.stringify(envelope)};
const descriptor = ${JSON.stringify(descriptor)};
const parent = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "roster-code-mode-child-close-"));
let emitError;
let dispatch;
let scans = 0;
let releaseScan;
let startedResolve;
const started = new Promise((resolve) => { startedResolve = resolve; });
const watcher = { close() {}, on(_event, listener) { emitError = listener; return watcher; } };
const heldScan = new Promise((resolve) => { releaseScan = () => resolve([]); });
const heldJob = new Promise(() => {});
const prepared = await prepareNodeCodeMode({
  envelope,
  directory: parent,
  watcherFactory(_path, callback) { dispatch = callback; return watcher; },
  directoryReader: async () => { scans += 1; return scans === 1 ? heldScan : []; },
  invokeFunction: async () => { startedResolve(); return heldJob; },
});
emitError(Object.assign(new Error("watcher resource limit"), { code: "EMFILE" }));
while (scans < 1) await new Promise((resolve) => setTimeout(resolve, 5));
const mailbox = prepared.environment.ROSTER_CODE_TOOL_MAILBOX_DIR;
const requestId = randomUUID();
const requestName = "request-" + requestId + ".json";
await writeFile(join(mailbox, requestName), JSON.stringify({ expectedGeneration: prepared.environment.ROSTER_CODE_TOOL_GENERATION, op: "call", functionId: descriptor.id, value: {} }));
dispatch(requestName);
await started;
process.stdout.write("ROSTER_CHILD_READY\\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
const scanReleaseTimer = setTimeout(() => releaseScan(), 600);
scanReleaseTimer.unref();
const startedAt = Date.now();
try { await prepared.close(); process.stdout.write(JSON.stringify({ type: "result", unexpected: true }) + "\\n"); process.exitCode = 13; }
catch (error) { process.stdout.write(JSON.stringify({ type: "result", message: String(error), elapsed: Date.now() - startedAt, pid: process.pid }) + "\\n"); }
await rm(parent, { recursive: true, force: true });
`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutLines: string[] = [];
  let stdoutRemainder = "";
  const stderr: Buffer[] = [];
  let ready = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutRemainder += chunk.toString("utf8");
    const lines = stdoutRemainder.split("\n");
    stdoutRemainder = lines.pop() ?? "";
    for (const line of lines) {
      const normalized = line.trim();
      if (normalized) stdoutLines.push(normalized);
      if (normalized === "ROSTER_CHILD_READY" && !ready) {
        ready = true;
        resolveReady();
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.once("close", () => {
    if (!ready) rejectReady(new Error(
      `child exited before readiness: ${Buffer.concat(stderr).toString("utf8")}`,
    ));
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let startupWatchdogFired = false;
  let shutdownWatchdogFired = false;
  const startupWatchdog = setTimeout(() => {
    startupWatchdogFired = true;
    child.kill("SIGKILL");
  }, 10_000);
  let shutdownWatchdog: NodeJS.Timeout | undefined;
  let exitCode: number | null;
  try {
    await readyPromise;
    clearTimeout(startupWatchdog);
    shutdownWatchdog = setTimeout(() => {
      shutdownWatchdogFired = true;
      child.kill("SIGKILL");
    }, 2_500);
    child.stdin.end("GO\n");
    exitCode = await exited;
  } finally {
    clearTimeout(startupWatchdog);
    if (shutdownWatchdog) clearTimeout(shutdownWatchdog);
  }
  if (stdoutRemainder.trim()) stdoutLines.push(stdoutRemainder.trim());
  assert.equal(startupWatchdogFired, false);
  assert.equal(shutdownWatchdogFired, false);
  assert.equal(exitCode, 0, Buffer.concat(stderr).toString("utf8"));
  let output: {
    readonly message?: string;
    readonly elapsed?: number;
    readonly pid?: number;
  } | undefined;
  for (const line of [...stdoutLines].reverse()) {
    try {
      const candidate = JSON.parse(line) as typeof output;
      if (candidate && typeof candidate === "object" && "type" in candidate && candidate.type === "result") {
        output = candidate;
        break;
      }
    } catch {
      // Ignore non-JSON child output while locating the final result line.
    }
  }
  assert.ok(output, `child output did not contain a final result: ${stdoutLines.join("\n")}`);
  const result = output as {
    readonly message?: string;
    readonly elapsed?: number;
    readonly pid?: number;
  };
  assert.match(result.message ?? "", /mailbox jobs did not settle before shutdown budget=1000ms/u);
  assert.ok((result.elapsed ?? 0) >= 900 && (result.elapsed ?? Infinity) < 1_400);
  assert.equal(typeof result.pid, "number");
  let helperAlive = false;
  try {
    process.kill(result.pid as number, 0);
    helperAlive = true;
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
  }
  assert.equal(helperAlive, false);
});

test("dual cleanup failures preserve every primary throw shape", async () => {
  const cleanup = new Error("cleanup failure");
  const values: ReadonlyArray<unknown> = [
    new Error("error primary"),
    Object.freeze(new Error("frozen error")),
    Object.freeze({ primary: true }),
    "primitive primary",
    undefined,
    null,
  ];
  for (const primary of values) {
    const prepared = { close: async (): Promise<void> => { throw cleanup; } };
    let thrown: unknown;
    try {
      await executeWithPreparedNodeCodeMode(prepared, async () => { throw primary; });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown !== undefined || primary === undefined);
    if (primary instanceof Error && Object.isExtensible(primary)) {
      assert.equal(thrown, primary);
      assert.equal((primary as Error & { readonly cleanupError?: unknown }).cleanupError, cleanup);
    } else {
      assert.ok(thrown instanceof AggregateError);
      assert.equal((thrown as AggregateError & { readonly primaryError?: unknown }).primaryError, primary);
      assert.equal((thrown as AggregateError & { readonly cleanupError?: unknown }).cleanupError, cleanup);
      assert.equal((thrown as AggregateError).cause, primary);
    }
  }
  assert.equal(await executeWithPreparedNodeCodeMode(undefined, async () => "ok"), "ok");
  let noModeError: unknown;
  try {
    await executeWithPreparedNodeCodeMode(undefined, async () => { throw null; });
  } catch (error) {
    noModeError = error;
  }
  assert.equal(noModeError, null);
});

test("prepared execution cleanup runs exactly once", async () => {
  let closes = 0;
  const prepared = {
    close: async (): Promise<void> => {
      closes += 1;
    },
  };
  assert.equal(await executeWithPreparedNodeCodeMode(prepared, async () => "ok"), "ok");
  assert.equal(closes, 1);
});

const corruptMailbox = async (execution: CommandExecution): Promise<void> => {
  const mailbox = execution.env?.ROSTER_CODE_TOOL_MAILBOX_DIR;
  assert.ok(mailbox);
  await rm(mailbox, { recursive: true, force: true });
  await writeFile(mailbox, "adapter sentinel");
};

for (const runtimeCase of [
  ...LOCAL_RUNTIME_CASES,
  {
    kind: "shell" as const,
    adapter: (runner: (execution: CommandExecution) => Promise<CommandExecutionResult>) =>
      createCommandNodeRuntimeAdapter({ runner }),
    result: {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ schemaVersion: NODE_EXECUTION_SCHEMA_VERSION, status: "completed", output: { answer: "shell" } }),
    },
  },
]) {
  test(`${runtimeCase.kind} preserves primary and cleanup failures through the real result path`, async () => {
    const adapter = runtimeCase.adapter(async (execution) => {
      await corruptMailbox(execution);
      return { exitCode: 23, stderr: "real worker failure", stdout: "" };
    });
    await assert.rejects(() => new NodeRuntimeRegistry([adapter]).execute({
      runId: `primary-cleanup-${runtimeCase.kind}`,
      node: {
        ...CODE_MODE_NODE,
        runtime: runtimeCase.kind === "shell"
          ? { kind: "shell", command: ["worker"] }
          : { kind: runtimeCase.kind },
      },
      task: { taskId: "primary-cleanup", nodeId: CODE_MODE_NODE.id, capability: "delegate" },
      surface: { codeMode: {} },
      execute: async () => ({ answer: "native" }),
    }), (error: unknown) => {
      assert.match(String(error instanceof Error ? error.message : error), /exited with code 23/u);
      assert.match(String((error as { readonly cleanupError?: unknown }).cleanupError), /ENOENT|ENOTDIR|not a directory/u);
      return true;
    });
  });
}

test("host generation fencing rejects stale requests after adapter-owned directory reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-generation-"));
  const descriptor = workerFunctionDescriptor();
  let invocations = 0;
  let dispatch!: (filename: string | Buffer | null) => void;
  const watcher: NodeCodeModeWatcher = { close: () => undefined, on: () => watcher };
  try {
    const first = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope("generation-one", { tools: [descriptor] }),
      directory,
      watcherFactory: (_path, callback) => { dispatch = callback; return watcher; },
    });
    const firstGeneration = first.environment.ROSTER_CODE_TOOL_GENERATION;
    await first.close();
    const second = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope("generation-two", { tools: [descriptor] }),
      directory,
      watcherFactory: (_path, callback) => { dispatch = callback; return watcher; },
      invokeFunction: async () => {
        invocations += 1;
        return {
          status: "completed" as const,
          functionId: descriptor.id,
          providerId: "stale-host-provider",
          output: { unexpected: true },
        };
      },
    });
    const mailbox = second.environment.ROSTER_CODE_TOOL_MAILBOX_DIR;
    assert.ok(mailbox);
    const requestId = mailboxRequestIdForTest();
    const requestName = `request-${requestId}.json`;
    await writeFile(join(mailbox, requestName), JSON.stringify({
      expectedGeneration: firstGeneration,
      op: "call",
      functionId: descriptor.id,
      value: {},
    }));
    dispatch(requestName);
    const responsePath = join(mailbox, `response-${requestId}.json`);
    let response = "";
    await waitUntilAsync(async () => {
      try {
        response = await readFile(responsePath, "utf8");
        return true;
      } catch {
        return false;
      }
    }, "stale response");
    const parsed = JSON.parse(response) as { readonly ok?: boolean; readonly error?: string };
    assert.equal(parsed.ok, false);
    assert.match(parsed.error ?? "", /generation mismatch/u);
    assert.equal(invocations, 0);
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("delayed generation-one cleanup cannot remove generation-two resources or client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-generation-cleanup-"));
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let firstMarker = "";
  try {
    const first = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope("generation-cleanup-one"),
      directory,
      removeFile: async (path) => path === firstMarker ? delayed : undefined,
    });
    firstMarker = first.environment.ROSTER_CODE_TOOL_MARKER ?? "";
    const closing = first.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const second = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope("generation-cleanup-two"),
      directory,
    });
    const listed = await executeClient({ env: second.environment } as CommandExecution, ["list"]);
    assert.equal(listed.exitCode, 0);
    release?.();
    await closing;
    const stillUsable = await executeClient({ env: second.environment } as CommandExecution, ["list"]);
    assert.equal(stillUsable.exitCode, 0);
    await second.close();
  } finally {
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale admitted invocation cannot publish output into a reused generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-stale-call-"));
  const descriptor = workerFunctionDescriptor();
  const watcher: NodeCodeModeWatcher = { close: () => undefined, on: () => watcher };
  let dispatch!: (filename: string | Buffer | null) => void;
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  let release: (() => void) | undefined;
  const held = new Promise<{
    readonly status: "completed";
    readonly functionId: string;
    readonly providerId: string;
    readonly output: JsonValue;
  }>((resolve) => {
    release = () => resolve({
      status: "completed",
      functionId: descriptor.id,
      providerId: "stale-provider",
      output: { stale: true },
    });
  });
  let invocations = 0;
  try {
    const first = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope("stale-one", { tools: [descriptor] }),
      directory,
      watcherFactory: (_path, callback) => { dispatch = callback; return watcher; },
      invokeFunction: async () => {
        invocations += 1;
        startedResolve?.();
        return held;
      },
    });
    const firstMailbox = first.environment.ROSTER_CODE_TOOL_MAILBOX_DIR;
    assert.ok(firstMailbox);
    const requestId = mailboxRequestIdForTest();
    const requestName = `request-${requestId}.json`;
    await writeFile(join(firstMailbox, requestName), JSON.stringify({
      expectedGeneration: first.environment.ROSTER_CODE_TOOL_GENERATION,
      op: "call",
      functionId: descriptor.id,
      value: {},
    }));
    dispatch(requestName);
    await started;
    const closing = first.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const second = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope("stale-two", { tools: [descriptor] }),
      directory,
      invokeFunction: async () => ({
        status: "completed" as const,
        functionId: descriptor.id,
        providerId: "current-provider",
        output: { current: true },
      }),
    });
    const before = await executeClient({ env: second.environment } as CommandExecution, ["list"]);
    assert.equal(before.exitCode, 0);
    const secondManifestPath = second.environment.ROSTER_CODE_TOOL_MANIFEST;
    const secondValueDirectory = second.environment.ROSTER_CODE_TOOL_VALUE_DIR;
    const secondMailbox = second.environment.ROSTER_CODE_TOOL_MAILBOX_DIR;
    assert.ok(secondManifestPath);
    assert.ok(secondValueDirectory);
    assert.ok(secondMailbox);
    const manifestBefore = await readFile(secondManifestPath, "utf8");
    const valuesBefore = await readdir(secondValueDirectory);
    release?.();
    await closing;
    assert.equal(invocations, 1);
    const after = await executeClient({ env: second.environment } as CommandExecution, ["list"]);
    assert.equal(after.exitCode, 0);
    assert.doesNotMatch(after.stdout, /stale/u);
    assert.equal(await readFile(secondManifestPath, "utf8"), manifestBefore);
    assert.deepEqual(await readdir(secondValueDirectory), valuesBefore);
    const secondMailboxEntries = await readdir(secondMailbox);
    assert.equal(secondMailboxEntries.some((entry) => entry.includes(requestId)), false);
    assert.equal(await stat(join(firstMailbox, `response-${requestId}.json`)).then(() => true, () => false), false);
    assert.equal(await stat(join(firstMailbox, `response-${requestId}.json.pending`)).then(() => true, () => false), false);
    const call = await executeClient(
      { env: second.environment } as CommandExecution,
      ["call", descriptor.id],
      "{}",
    );
    assert.equal(call.exitCode, 0);
    await second.close();
  } finally {
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("owned directory cleanup is eventual after a timed-out mailbox job settles", async () => {
  const descriptor = workerFunctionDescriptor();
  const watcher: NodeCodeModeWatcher = { close: () => undefined, on: () => watcher };
  let dispatch!: (filename: string | Buffer | null) => void;
  let release: (() => void) | undefined;
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const held = new Promise<{
    readonly status: "completed";
    readonly functionId: string;
    readonly providerId: string;
    readonly output: JsonValue;
  }>((resolve) => {
    release = () => resolve({
      status: "completed",
      functionId: descriptor.id,
      providerId: "eventual-provider",
      output: { late: true },
    });
  });
  const prepared = await prepareNodeCodeMode({
    envelope: directMailboxEnvelope("owned-eventual", { tools: [descriptor] }),
    watcherFactory: (_path, callback) => { dispatch = callback; return watcher; },
    invokeFunction: async () => {
      startedResolve?.();
      return held;
    },
  });
  const directory = prepared.clientDirectory;
  try {
    const mailbox = prepared.environment.ROSTER_CODE_TOOL_MAILBOX_DIR;
    assert.ok(mailbox);
    const requestId = mailboxRequestIdForTest();
    const requestName = `request-${requestId}.json`;
    await writeFile(join(mailbox, requestName), JSON.stringify({
      expectedGeneration: prepared.environment.ROSTER_CODE_TOOL_GENERATION,
      op: "call",
      functionId: descriptor.id,
      value: {},
    }));
    dispatch(requestName);
    const start = Date.now();
    await waitUntilAsync(async () => (await stat(join(mailbox, requestName)).then(() => true, () => false)) === true, "owned mailbox job");
    await started;
    const closing = prepared.close();
    await assert.rejects(closing, /mailbox jobs did not settle before shutdown budget=1000ms/u);
    assert.ok(Date.now() - start < 1_400);
    assert.equal(await stat(directory).then(() => true, () => false), true);
    release?.();
    await waitUntilAsync(async () => (await stat(directory).then(() => true, () => false)) === false, "eventual owned-directory cleanup");
  } finally {
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("supplied parent keeps its sentinel while eventual cleanup removes the generation child", async () => {
  const parent = await mkdtemp(join(tmpdir(), "roster-code-mode-parent-cleanup-"));
  const sentinel = join(parent, "parent-sentinel.txt");
  await writeFile(sentinel, "keep");
  const descriptor = workerFunctionDescriptor();
  const watcher: NodeCodeModeWatcher = { close: () => undefined, on: () => watcher };
  let dispatch!: (filename: string | Buffer | null) => void;
  let release: (() => void) | undefined;
  let startedResolve: (() => void) | undefined;
  let markerPath = "";
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  try {
    let falseRejections = 0;
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const ordinary = await prepareNodeCodeMode({
        envelope: directMailboxEnvelope(`ordinary-parent-close-${iteration}`),
        directory: parent,
        watcherFactory: throwingWatcher("EMFILE"),
      });
      try {
        await ordinary.close();
      } catch {
        falseRejections += 1;
      }
    }
    assert.equal(falseRejections, 0);
    assert.equal(await readFile(sentinel, "utf8"), "keep");

    const held = new Promise<{
      readonly status: "completed";
      readonly functionId: string;
      readonly providerId: string;
      readonly output: JsonValue;
    }>((resolve) => {
      release = () => resolve({
        status: "completed",
        functionId: descriptor.id,
        providerId: "parent-provider",
        output: { late: true },
      });
    });
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope("parent-cleanup", { tools: [descriptor] }),
      directory: parent,
      watcherFactory: (_path, callback) => { dispatch = callback; return watcher; },
      removeFile: async (path) => path === markerPath || path.includes("mailbox")
        ? undefined
        : new Promise<void>(() => undefined),
      invokeFunction: async () => {
        startedResolve?.();
        return held;
      },
    });
    markerPath = prepared.environment.ROSTER_CODE_TOOL_MARKER ?? "";
    const child = prepared.clientDirectory;
    const mailbox = prepared.environment.ROSTER_CODE_TOOL_MAILBOX_DIR;
    assert.ok(mailbox);
    const requestId = mailboxRequestIdForTest();
    const requestName = `request-${requestId}.json`;
    await writeFile(join(mailbox, requestName), JSON.stringify({
      expectedGeneration: prepared.environment.ROSTER_CODE_TOOL_GENERATION,
      op: "call",
      functionId: descriptor.id,
      value: {},
    }));
    dispatch(requestName);
    await started;
    const closing = prepared.close();
    await assert.rejects(closing, /mailbox jobs did not settle before shutdown budget=1000ms/u);
    assert.equal(await stat(child).then(() => true, () => false), true);
    release?.();
    await waitUntilAsync(async () => (await stat(child).then(() => true, () => false)) === false, "supplied generation child cleanup");
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    release?.();
    await rm(parent, { recursive: true, force: true });
  }
});

test("command success still reports a cleanup failure from its real result path", async () => {
  const adapter = createCommandNodeRuntimeAdapter({
    runner: async (execution) => {
      await corruptMailbox(execution);
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: { answer: "command" },
        }),
      };
    },
  });
  await assert.rejects(() => new NodeRuntimeRegistry([adapter]).execute({
    runId: "command-cleanup-success",
    node: { ...CODE_MODE_NODE, runtime: { kind: "shell", command: ["worker"] } },
    task: { taskId: "cleanup", nodeId: CODE_MODE_NODE.id, capability: "delegate" },
    surface: { codeMode: {} },
    execute: async () => ({ answer: "native" }),
  }), /ENOENT|ENOTDIR|not a directory/u);
});

test("an in-flight real client exits after close and leaves no exact request files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-client-close-"));
  const descriptor = workerFunctionDescriptor();
  const watcher: NodeCodeModeWatcher = { close: () => undefined, on: () => watcher };
  let dispatch!: (filename: string | Buffer | null) => void;
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  let finish: (() => void) | undefined;
  const clientController = new AbortController();
  try {
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope("direct-mailbox-test", { tools: [descriptor] }),
      directory,
      watcherFactory: (_path, callback) => { dispatch = callback; return watcher; },
      invokeFunction: async () => new Promise((resolve) => {
        startedResolve?.();
        finish = () => resolve({
          status: "completed",
          functionId: descriptor.id,
          providerId: "held-provider",
          output: {},
        });
      }),
    });
    const mailbox = prepared.environment.ROSTER_CODE_TOOL_MAILBOX_DIR;
    assert.ok(mailbox);
    const client = executeClient({ env: prepared.environment, signal: clientController.signal } as CommandExecution, ["call", descriptor.id], "{}");
    let requestName = "";
    await waitUntilAsync(async () => {
      const entries = await readdir(mailbox);
      requestName = entries.find((entry) => /^request-[0-9a-f-]+\.json$/u.test(entry)) ?? "";
      return Boolean(requestName);
    }, "real client request");
    dispatch(requestName);
    await started;
    const closing = prepared.close();
    const clientStarted = Date.now();
    const clientExitDeadline = setTimeout(() => clientController.abort(new Error("real client shutdown exceeded 500ms")), 500);
    let result: CommandExecutionResult;
    try {
      result = await client;
    } finally {
      clearTimeout(clientExitDeadline);
    }
    assert.ok(Date.now() - clientStarted < 500, "real client did not exit within its short shutdown bound");
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /generation is no longer active/u);
    await assert.rejects(closing, /mailbox jobs did not settle before shutdown budget=1000ms/u);
    finish?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const remaining = await readdir(mailbox).catch(() => [] as string[]);
    const responseName = requestName.replace(/^request-/u, "response-");
    assert.equal(remaining.some((entry) => [
      requestName,
      `${requestName}.pending`,
      responseName,
      `${responseName}.pending`,
    ].includes(entry)), false);
  } finally {
    clientController.abort();
    finish?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fallback backoff caps at 500ms and remains single-flight", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-backoff-"));
  const times: number[] = [];
  let active = 0;
  let maximumActive = 0;
  try {
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope(),
      directory,
      watcherFactory: throwingWatcher("ENOSPC"),
      directoryReader: async () => {
        times.push(Date.now());
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return [];
      },
    });
    await waitUntil(() => times.length >= 6, "capped fallback scans");
    assert.equal(maximumActive, 1);
    assert.ok(times[1]! - times[0]! >= 35);
    assert.ok(times[2]! - times[1]! >= 75);
    assert.ok(times[3]! - times[2]! >= 150);
    assert.ok(times[4]! - times[3]! >= 350);
    assert.ok(times[5]! - times[4]! >= 450);
    assert.ok(times[5]! - times[4]! < 750);
    await prepared.close();
    const count = times.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    assert.equal(times.length, count);
    assert.ok(times.length <= 128);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repeated asynchronous watcher resource errors enter fallback only once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-repeated-errors-"));
  let emitError: ((error: Error) => void) | undefined;
  let closeCount = 0;
  let scans = 0;
  let watcher!: NodeCodeModeWatcher;
  watcher = {
    close: () => { closeCount += 1; },
    on: (_event, listener) => { emitError = listener; return watcher; },
  };
  try {
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope(),
      directory,
      watcherFactory: () => watcher,
      directoryReader: async () => {
        scans += 1;
        return [];
      },
    });
    const first = Object.assign(new Error("resource limit"), { code: "EMFILE" });
    emitError?.(first);
    emitError?.(Object.assign(new Error("resource limit again"), { code: "EMFILE" }));
    emitError?.(Object.assign(new Error("disk watcher limit"), { code: "ENOSPC" }));
    await waitUntil(() => scans >= 1, "fallback after repeated resource errors");
    await prepared.close();
    assert.equal(closeCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exact cleanup leaves adapter-owned sentinels and non-Roster files intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-code-mode-ownership-"));
  const sentinel = join(directory, "adapter-sentinel.txt");
  const mailboxSentinel = join(directory, "mailbox", "response-not-a-uuid.json");
  const valueSentinel = join(directory, "values", "context_bad.json");
  const watcher: NodeCodeModeWatcher = { close: () => undefined, on: () => watcher };
  try {
    await mkdir(join(directory, "mailbox"), { recursive: true });
    await mkdir(join(directory, "values"), { recursive: true });
    await writeFile(sentinel, "keep");
    await writeFile(mailboxSentinel, "keep");
    await writeFile(valueSentinel, "keep");
    const prepared = await prepareNodeCodeMode({
      envelope: directMailboxEnvelope("direct-mailbox-test", {
        input: { kept: true },
        inputMode: "external",
      }),
      directory,
      watcherFactory: () => watcher,
    });
    const mailbox = prepared.environment.ROSTER_CODE_TOOL_MAILBOX_DIR;
    const values = prepared.environment.ROSTER_CODE_TOOL_VALUE_DIR;
    const marker = prepared.environment.ROSTER_CODE_TOOL_MARKER;
    const manifest = prepared.environment.ROSTER_CODE_TOOL_MANIFEST;
    assert.ok(mailbox);
    assert.ok(values);
    assert.ok(marker);
    assert.ok(manifest);
    const modulePath = join(prepared.clientDirectory, "roster-tool.mjs");
    const launcherPath = join(prepared.clientDirectory, process.platform === "win32" ? "roster-tool.cmd" : "roster-tool");
    const inputHandle = prepared.envelope.surface.codeMode?.contextValues
      ?.find((value) => value.label === "task.input")?.handle;
    assert.ok(inputHandle);
    const ownedValue = join(values, `${inputHandle}.json`);
    const requestId = mailboxRequestIdForTest();
    const request = join(mailbox, `request-${requestId}.json`);
    const pending = join(mailbox, `response-${requestId}.json.pending`);
    const response = join(mailbox, `response-${requestId}.json`);
    await writeFile(request, "{}");
    await writeFile(pending, "{}");
    await writeFile(response, "{}");
    await prepared.close();
    for (const ownedPath of [request, pending, response, marker, manifest, modulePath, launcherPath, ownedValue]) {
      await assert.rejects(stat(ownedPath));
    }
    await assert.rejects(stat(prepared.clientDirectory));
    assert.equal(await readFile(sentinel, "utf8"), "keep");
    assert.equal(await readFile(mailboxSentinel, "utf8"), "keep");
    assert.equal(await readFile(valueSentinel, "utf8"), "keep");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("watcher setup preserves its primary error when exact-once close also fails", async () => {
  const parent = await mkdtemp(join(tmpdir(), "roster-code-mode-watcher-setup-"));
  const sentinel = join(parent, "parent-sentinel.txt");
  const primary = new Error("watcher error listener setup failed");
  const cleanup = new Error("watcher close failed");
  let closeCalls = 0;
  let watcher!: NodeCodeModeWatcher;
  watcher = {
    close: () => {
      closeCalls += 1;
      throw cleanup;
    },
    on: () => {
      throw primary;
    },
  };
  try {
    await writeFile(sentinel, "keep");
    await assert.rejects(() => prepareNodeCodeMode({
      directory: parent,
      envelope: directMailboxEnvelope("watcher-setup-close-failure", {
        input: { sentinel: "RAW_TASK_INPUT_MUST_BE_REMOVED" },
        inputMode: "external",
      }),
      watcherFactory: () => watcher,
    }), (error: unknown) => {
      assert.equal(error, primary);
      assert.equal(
        (error as Error & { readonly cleanupError?: unknown }).cleanupError,
        cleanup,
      );
      return true;
    });
    assert.equal(closeCalls, 1);
    assert.deepEqual(await readdir(parent), ["parent-sentinel.txt"]);
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("asynchronous watcher failure keeps close failure as exact-once cleanup evidence", async () => {
  const parent = await mkdtemp(join(tmpdir(), "roster-code-mode-watcher-async-"));
  const primary = new Error("asynchronous watcher failed");
  const cleanup = new Error("asynchronous watcher close failed");
  let emitError: ((error: Error) => void) | undefined;
  let closeCalls = 0;
  let watcher!: NodeCodeModeWatcher;
  watcher = {
    close: () => {
      closeCalls += 1;
      throw cleanup;
    },
    on: (_event, listener) => {
      emitError = listener;
      return watcher;
    },
  };
  try {
    const prepared = await prepareNodeCodeMode({
      directory: parent,
      envelope: directMailboxEnvelope("watcher-async-close-failure"),
      watcherFactory: () => watcher,
    });
    emitError?.(primary);
    await assert.rejects(prepared.close(), (error: unknown) => {
      assert.equal(error, primary);
      assert.equal(
        (error as Error & { readonly cleanupError?: unknown }).cleanupError,
        cleanup,
      );
      return true;
    });
    assert.equal(closeCalls, 1);
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("asynchronous watcher failure cooperatively aborts an in-flight mailbox invocation and cleans its supplied parent", async () => {
  const parent = await mkdtemp(join(tmpdir(), "roster-code-mode-watcher-in-flight-"));
  const sentinel = join(parent, "parent-sentinel.txt");
  const rawInput = { sentinel: "RAW_TASK_INPUT_MUST_BE_REMOVED" };
  const descriptor = workerFunctionDescriptor();
  const primary = new Error("asynchronous non-resource watcher failure");
  const cleanup = new Error("asynchronous watcher close cleanup failure");
  let dispatch!: (filename: string | Buffer | null) => void;
  let emitError: ((error: Error) => void) | undefined;
  let invocationSignal: AbortSignal | undefined;
  let invocationStarted = false;
  let providerDidReject = false;
  let providerRejectedReason: unknown;
  let closeCalls = 0;
  let watcher!: NodeCodeModeWatcher;
  watcher = {
    close: () => {
      closeCalls += 1;
      throw cleanup;
    },
    on: (_event, listener) => {
      emitError = listener;
      return watcher;
    },
  };
  try {
    await writeFile(sentinel, "keep");
    const prepared = await prepareNodeCodeMode({
      directory: parent,
      envelope: directMailboxEnvelope("watcher-in-flight-abort", {
        input: rawInput,
        inputMode: "external",
        tools: [descriptor],
      }),
      watcherFactory: (_path, callback) => {
        dispatch = callback;
        return watcher;
      },
      invokeFunction: async (_invocation, control) => new Promise((_resolve, reject) => {
        invocationSignal = control.signal;
        invocationStarted = true;
        const rejectOnAbort = (): void => {
          providerDidReject = true;
          providerRejectedReason = control.signal.reason;
          reject(control.signal.reason);
        };
        if (control.signal.aborted) rejectOnAbort();
        else control.signal.addEventListener("abort", rejectOnAbort, { once: true });
      }),
    });
    const generationDirectory = prepared.clientDirectory;
    const mailbox = prepared.environment.ROSTER_CODE_TOOL_MAILBOX_DIR;
    const values = prepared.environment.ROSTER_CODE_TOOL_VALUE_DIR;
    const generation = prepared.environment.ROSTER_CODE_TOOL_GENERATION;
    assert.ok(mailbox);
    assert.ok(values);
    assert.ok(generation);
    const inputHandle = prepared.envelope.surface.codeMode?.contextValues?.find(
      (value) => value.label === "task.input",
    )?.handle;
    assert.ok(inputHandle);
    const rawInputPath = join(values, `${inputHandle}.json`);
    assert.deepEqual(JSON.parse(await readFile(rawInputPath, "utf8")), rawInput);
    const requestId = mailboxRequestIdForTest();
    const requestName = `request-${requestId}.json`;
    const requestPath = join(mailbox, requestName);
    await writeFile(requestPath, JSON.stringify({
      expectedGeneration: generation,
      op: "call",
      functionId: descriptor.id,
      value: {},
    }));
    assert.doesNotThrow(() => dispatch(requestName));
    await waitUntil(() => invocationStarted, "in-flight watcher invocation start");
    assert.ok(invocationSignal);
    assert.equal(invocationSignal.aborted, false);

    assert.doesNotThrow(() => emitError?.(primary));
    assert.equal(invocationSignal.aborted, true);
    assert.equal(invocationSignal.reason, primary);
    await waitUntil(() => providerDidReject, "in-flight watcher provider abort rejection");
    assert.equal(providerRejectedReason, primary);
    await assert.rejects(prepared.close(), (error: unknown) => {
      assert.equal(error, primary);
      assert.equal(
        (error as Error & { readonly cleanupError?: unknown }).cleanupError,
        cleanup,
      );
      return true;
    });
    assert.equal(closeCalls, 1);
    await assert.rejects(stat(generationDirectory));
    await assert.rejects(stat(requestPath));
    await assert.rejects(stat(rawInputPath));
    assert.deepEqual(await readdir(parent), ["parent-sentinel.txt"]);
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("accessor command environment is rejected without allocating a code-mode generation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "roster-code-mode-environment-"));
  const previousTmpdir = process.env.TMPDIR;
  let getterCalls = 0;
  let launches = 0;
  const environment: NodeJS.ProcessEnv = {};
  Object.defineProperty(environment, "ROSTER_THROWING_ENV", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "dynamic";
    },
  });
  try {
    process.env.TMPDIR = parent;
    const adapter = createCommandNodeRuntimeAdapter({
      environment,
      runner: async () => {
        launches += 1;
        throw new Error("runner must not launch");
      },
    });
    assert.throws(
      () => new NodeRuntimeRegistry([adapter]),
      /environment ROSTER_THROWING_ENV must be an own data property/u,
    );
    assert.equal(getterCalls, 0);
    assert.equal(launches, 0);
    assert.deepEqual(await readdir(parent), []);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await rm(parent, { recursive: true, force: true });
  }
});

test("surface construction rejects a circular tool schema before allocating code mode", async () => {
  const parent = await mkdtemp(join(tmpdir(), "roster-code-mode-manifest-"));
  const circularSchema: Record<string, unknown> = { type: "object" };
  circularSchema.self = circularSchema;
  const descriptor = {
    ...workerFunctionDescriptor(),
    inputSchema: circularSchema,
  } as RosterFunctionDescriptor;
  try {
    assert.throws(() => directMailboxEnvelope("manifest-setup-failure", {
      input: { sentinel: "MANIFEST_FAILURE_INPUT_SENTINEL" },
      inputMode: "external",
      tools: [descriptor],
    }), /contains cyclic data/u);
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
