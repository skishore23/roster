import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import test from "node:test";

import { mergeSharedArtifactUpdates } from "../../src/engine/artifact/shared-crdt.ts";
import { createDomainRegistry } from "../../src/engine/orchestration/domain.ts";
import { createDynamicTaskDefinition } from "../../src/engine/orchestration/task-graph.ts";
import { compileTargetContract } from "../../src/engine/orchestration/target-contract.ts";
import type { DomainPack } from "../../src/engine/orchestration/types.ts";
import { createTaskExecutionGrant } from "../../src/engine/platform/execution-grant.ts";
import {
  NODE_EXECUTION_SCHEMA_VERSION,
  NodeRuntimeRegistry,
  type NodeExecutionTrajectory,
  type NodeRuntimeAdapter,
} from "../../src/engine/runtime/node-runtime.ts";
import { createCommandNodeRuntimeAdapter } from "../../src/engine/runtime/command-node-runtime.ts";
import {
  createClaudeCodeNodeRuntimeAdapter,
  createCodexCliNodeRuntimeAdapter,
  createHermesAgentNodeRuntimeAdapter,
  createPiAgentNodeRuntimeAdapter,
  type AgentCliTrajectoryLocator,
} from "../../src/engine/runtime/agent-cli-node-runtime.ts";
import { createA2ANodeRuntimeAdapter } from "../../src/engine/runtime/a2a-node-runtime.ts";
import { createStandardNodeRuntimeRegistry } from "../../src/engine/runtime/standard-node-runtimes.ts";
import {
  NodeRuntimeLogPendingBuffer,
  NodeRuntimeLogStore,
} from "../../src/engine/runtime/node-runtime-log.ts";
import {
  DEFAULT_CODING_PI_EXTENSION_PACKAGES,
  piExtensionPathsFromManifest,
  resolvePiExtensionPackagePaths,
} from "../../src/engine/runtime/pi-extension-packages.ts";
import {
  createRosterTaskContext,
  SharedWorkspaceLedger,
} from "../../src/engine/workspace/shared-workspace.ts";
import {
  createWorkspaceNodeRuntimeBinding,
  projectWorkspaceNodes,
  workspaceNodeSocialParticipant,
} from "../../src/engine/workspace/node.ts";
import {
  applyWorkspaceParticipantProfile,
  normalizeWorkspaceParticipantProfile,
} from "../../src/engine/workspace/participant-profile.ts";
import {
  initialOrchestrationState,
  nodeRuntimeBoundEvent,
  orchestrationConfiguredEvent,
  orchestrationWorkspaceNodes,
  reduceOrchestration,
} from "../../src/modules/orchestration.ts";

const PACK: DomainPack = {
  id: "workspace-test",
  version: "1",
  policyVersion: "workspace-test-v1",
  coordinatorId: "coordinator",
  capabilities: [
    { id: "coordinate", description: "Coordinate the workspace." },
    { id: "inspect", description: "Inspect a bounded input." },
  ],
  nodes: [
    {
      id: "coordinator",
      name: "Coordinator",
      capabilities: ["coordinate"],
      promptProfile: "coordinator",
      runtime: { kind: "roster-native", profile: "coordinator" },
    },
    {
      id: "external",
      name: "External Node",
      parentId: "coordinator",
      capabilities: ["inspect"],
      runtime: { kind: "codex-cli", profile: "repository-inspector" },
    },
  ],
  limits: { maxNodes: 4, maxTasks: 16, maxParallel: 2, maxDepth: 3 },
};

const trajectoryTranscript = async (
  locator: AgentCliTrajectoryLocator,
): Promise<string> => {
  const timestamp = "2026-07-24T12:00:00.000Z";
  if (locator.source === "codex") {
    return [
      JSON.stringify({
        timestamp,
        type: "session_meta",
        payload: { id: locator.sourceId, timestamp, cwd: "/workspace" },
      }),
      JSON.stringify({
        timestamp,
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Work." }] },
      }),
      JSON.stringify({
        timestamp,
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
      }),
    ].join("\n");
  }
  if (locator.source === "claude-code") {
    return [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        sessionId: locator.sourceId,
        timestamp,
        message: { role: "user", content: "Work." },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-1",
        sessionId: locator.sourceId,
        timestamp,
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      }),
    ].join("\n");
  }
  if (locator.source === "pi") {
    return [
      JSON.stringify({ type: "session", version: 3, id: locator.sourceId, timestamp, cwd: "/workspace" }),
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: { role: "user", content: [{ type: "text", text: "Work." }] },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp,
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      }),
    ].join("\n");
  }
  return JSON.stringify({
    session: { id: locator.sourceId, started_at: 1_774_353_600 },
    messages: [
      { id: 1, session_id: locator.sourceId, role: "user", content: "Work.", timestamp: 1_774_353_601 },
      { id: 2, session_id: locator.sourceId, role: "assistant", content: "Done.", timestamp: 1_774_353_602 },
    ],
  });
};

const isolatedRoomExecutionGrant = (input: {
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
}) => {
  const definition = createDynamicTaskDefinition({
    taskId: input.taskId,
    semanticKey: `room:${input.taskId}`,
    nodeId: input.nodeId,
    capability: "room",
    objective: "Tell the room what you will do next.",
    handler: { kind: "roster.node", version: "1" },
    acceptance: { policyId: "room-announcement", policyVersion: "1" },
    result: {
      mode: "json",
      outputKey: "announcement",
      schema: { type: "object", required: ["announcement"] },
    },
    dependencies: [],
    join: { kind: "all-success" },
    inputs: {
      inputVersions: {},
      dataReferences: [],
      frontierVersion: "room-frontier",
      topologyVersion: "room-topology",
      catalogVersion: "room-catalog",
    },
    runtimeBindingEpoch: 0,
    retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
    timeoutMs: 60_000,
    sideEffect: "pure",
    estimatedCostMicros: 3_000,
  });
  return createTaskExecutionGrant({
    runId: input.runId,
    definition,
    attempt: 1,
    fence: 1,
    policyVersion: "room-isolation.v1",
    policy: { maxTokens: 1_024, maxCostMicros: 3_000 },
    functionAccess: { functionGrants: [], scopes: [], allowedEffects: [] },
    workspaceOperations: [],
    skills: [],
    tools: [],
    maxFunctionCalls: 1,
    rationale: "The announcement has no repository or function authority.",
  });
};

test("domain nodes materialize as provider-neutral workspace nodes", () => {
  const registry = createDomainRegistry(PACK);
  assert.equal(registry.node("coordinator").runtime?.kind, "roster-native");
  assert.equal(registry.node("coordinator").runtime?.profile, "coordinator");
  assert.equal(registry.node("external").runtime?.kind, "codex-cli");
  assert.equal(registry.assertNodeAssignment("external", "inspect").id, "external");
  assert.equal(registry.nodesFor("inspect")[0]?.id, "external");
});

test("workspace participant profiles customize future node snapshots without changing runtime identity", () => {
  const original = PACK.nodes[1]!;
  const profile = normalizeWorkspaceParticipantProfile({
    workspaceId: "roster/default",
    nodeId: original.id,
    displayName: "Nova",
    role: "Interface Builder",
    bio: "Makes the room feel obvious.",
    skills: ["Accessibility", "Interaction design", "accessibility"],
    capabilities: ["review", "inspect"],
    revision: 3,
  });
  const applied = applyWorkspaceParticipantProfile(
    {
      ...original,
      metadata: { specialistSkills: [{ name: "Repository inspection", description: "Inspect code." }] },
    },
    profile,
    new Set(["inspect"]),
  );

  assert.equal(applied.id, original.id);
  assert.deepEqual(applied.runtime, original.runtime, "profile edits must not change runtime placement");
  assert.deepEqual(applied.capabilities, ["inspect"], "unsupported capability grants are ignored");
  assert.deepEqual(applied.metadata?.profileSkills, ["Accessibility", "Interaction design"]);
  assert.deepEqual(applied.metadata?.specialistSkills, [
    { name: "Repository inspection", description: "Inspect code." },
    "Accessibility",
    "Interaction design",
  ]);
  assert.deepEqual(original.capabilities, ["inspect"], "the authored node remains immutable");
  assert.deepEqual(workspaceNodeSocialParticipant(applied), {
    nodeId: "external",
    displayName: "Nova",
    fullName: "External Node",
    handle: "@nova",
    role: "Interface Builder",
    kind: "agent",
    persistent: false,
  });
});

test("runtime adapters own inner-loop execution without owning Roster coordination", async () => {
  const codexAdapter: NodeRuntimeAdapter = {
    kind: "codex-cli",
    executeEnvelope: async (envelope, control) => {
      assert.equal(JSON.stringify(envelope).includes("callback-must-stay-private"), false);
      assert.deepEqual(Object.keys(control), [
        "signal",
        "onLog",
        "onModelOutput",
        "onTrajectory",
        "invokeFunction",
        "effects",
      ]);
      return {
        schemaVersion: envelope.schemaVersion,
        status: "completed",
        output: `codex:${envelope.node.id}`,
      };
    },
  };
  const runtimes = new NodeRuntimeRegistry([codexAdapter]);
  const registry = createDomainRegistry(PACK);
  const result = await runtimes.execute({
    runId: "runtime-run",
    node: registry.node("external"),
    task: { taskId: "inspect", nodeId: "external", capability: "inspect" },
    execute: async () => "callback-must-stay-private",
  });
  assert.equal(result, "codex:external");
  assert.throws(() => runtimes.adapter("roster-native"), /No node runtime adapter/);
});

test("command runtime exchanges the versioned envelope over stdio", async () => {
  const worker = [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => input += chunk);",
    "process.stdin.on('end', () => {",
    "  const envelope = JSON.parse(input);",
    "  process.stdout.write(JSON.stringify({",
    "    schemaVersion: envelope.schemaVersion,",
    "    status: 'completed',",
    "    output: `worker:${envelope.node.id}:${envelope.input.subject}`",
    "  }));",
    "});",
  ].join("\n");
  const runtimes = new NodeRuntimeRegistry([createCommandNodeRuntimeAdapter()]);
  const result = await runtimes.execute({
    runId: "stdio-runtime",
    node: {
      id: "external",
      name: "External",
      capabilities: ["inspect"],
      runtime: { kind: "shell", command: [process.execPath, "-e", worker] },
    },
    task: { taskId: "stdio-task", nodeId: "external", capability: "inspect" },
    input: { subject: "repository" },
    execute: async () => "callback-should-not-run",
  });
  assert.equal(result, "worker:external:repository");
});

test("command runtime streams bounded process output before completion", async () => {
  const output: string[] = [];
  const worker = [
    "process.stdin.resume();",
    "process.stdout.write('first\\n');",
    "process.stderr.write('warning\\n');",
    "setTimeout(() => process.stdout.write('second\\n'), 5);",
  ].join("\n");
  const { runCommand } = await import("../../src/engine/runtime/command-node-runtime.ts");
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", worker],
    stdin: "",
    maxOutputBytes: 1_024,
    onOutput: (entry) => output.push(`${entry.stream}:${entry.text.trim()}`),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(output, ["stdout:first", "stderr:warning", "stdout:second"]);
});

test("command runtime replacement environment omits parent secrets and enforces its hard timeout", {
  skip: process.platform === "win32",
}, async () => {
  const { runCommand } = await import("../../src/engine/runtime/command-node-runtime.ts");
  const priorSecret = process.env.ROSTER_COMMAND_PARENT_SECRET;
  process.env.ROSTER_COMMAND_PARENT_SECRET = "must-not-be-inherited";
  try {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      stdin: "",
      env: { ROSTER_ALLOWED: "yes" },
      replaceEnvironment: true,
      maxOutputBytes: 8_192,
    });
    assert.equal(result.exitCode, 0);
    const childEnvironment = JSON.parse(result.stdout) as Record<string, string>;
    assert.equal(childEnvironment.ROSTER_ALLOWED, "yes");
    assert.equal(childEnvironment.ROSTER_COMMAND_PARENT_SECRET, undefined);
    await assert.rejects(runCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"],
      stdin: "",
      env: {},
      replaceEnvironment: true,
      timeoutMs: 20,
      maxOutputBytes: 1_024,
    }), /exceeded timeoutMs=20/);
  } finally {
    if (priorSecret === undefined) delete process.env.ROSTER_COMMAND_PARENT_SECRET;
    else process.env.ROSTER_COMMAND_PARENT_SECRET = priorSecret;
  }
});

test("command runtime keeps a bounded diagnostic tail below a separate hard output ceiling", async () => {
  const worker = [
    "process.stdin.resume();",
    "process.stdout.write('x'.repeat(2048));",
    "process.stdout.write('final-result\\n');",
  ].join("\n");
  const { runCommand } = await import("../../src/engine/runtime/command-node-runtime.ts");
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", worker],
    stdin: "",
    maxOutputBytes: 4_096,
    maxCaptureBytes: 1_024,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 1_024);
  assert.match(result.stdout, /final-result/);
});

test("command runtime separately fences raw transport and semantic output budgets", async () => {
  const worker = [
    "process.stdin.resume();",
    "process.stdout.write('x'.repeat(3072));",
  ].join("\n");
  const { runCommand } = await import("../../src/engine/runtime/command-node-runtime.ts");
  await assert.rejects(runCommand({
    command: process.execPath,
    args: ["-e", worker],
    stdin: "",
    maxOutputBytes: 1_024,
    maxTransportBytes: 2_048,
    outputBudgetBytes: () => 0,
  }), /exceeded maxTransportBytes=2048/);
});

test("command runtime cancellation terminates descendant processes before returning", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-command-cancel-"));
  const marker = join(directory, "orphan.txt");
  const grandchild = [
    "const { writeFileSync } = require('node:fs');",
    `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'orphan'), 250);`,
  ].join("\n");
  const worker = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' });`,
    "child.unref();",
    "process.stdout.write('ready\\n');",
    "setInterval(() => undefined, 1_000);",
  ].join("\n");
  const { runCommand } = await import("../../src/engine/runtime/command-node-runtime.ts");
  const controller = new AbortController();
  try {
    await assert.rejects(runCommand({
      command: process.execPath,
      args: ["-e", worker],
      stdin: "",
      signal: controller.signal,
      maxOutputBytes: 1_024,
      onOutput: (entry) => {
        if (entry.stream === "stdout" && entry.text.includes("ready")) {
          controller.abort(new Error("bounded task canceled"));
        }
      },
    }), /bounded task canceled/);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    assert.equal(await stat(marker).then(() => true, () => false), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("command runtime closes background helpers after a successful bounded command", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-command-success-cleanup-"));
  const marker = join(directory, "background.txt");
  const helper = [
    "const { writeFileSync } = require('node:fs');",
    "process.stdout.write('ready\\n');",
    "process.on('SIGTERM', () => {",
    `  setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, 'stopped'); process.exit(0); }, 200);`,
    "});",
    "setInterval(() => undefined, 1_000);",
  ].join("\n");
  const worker = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
    "child.stdout.once('data', () => { child.unref(); process.exit(0); });",
  ].join("\n");
  const { runCommand } = await import("../../src/engine/runtime/command-node-runtime.ts");
  try {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", worker],
      stdin: "",
      maxOutputBytes: 1_024,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(await stat(marker).then(() => true, () => false), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("command runtime closes successful helpers that inherit its output pipes", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-command-inherited-output-cleanup-"));
  const marker = join(directory, "background.txt");
  const helper = [
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {",
    `  setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, 'stopped'); process.exit(0); }, 200);`,
    "});",
    "writeFileSync(3, 'ready');",
    "setInterval(() => undefined, 1_000);",
  ].join("\n");
  const worker = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });`,
    "child.stdio[3].once('data', () => { child.stdio[3].destroy(); child.unref(); process.exit(0); });",
  ].join("\n");
  const { runCommand } = await import("../../src/engine/runtime/command-node-runtime.ts");
  try {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", worker],
      stdin: "",
      maxOutputBytes: 1_024,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(await stat(marker).then(() => true, () => false), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("command runtime force-kills successful helpers that retain output pipes", {
  skip: process.platform === "win32",
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-command-inherited-output-force-kill-"));
  const marker = join(directory, "background.txt");
  const helper = [
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {",
    `  writeFileSync(${JSON.stringify(marker)}, 'term-ignored');`,
    "});",
    "writeFileSync(3, 'ready');",
    "setInterval(() => undefined, 1_000);",
  ].join("\n");
  const worker = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });`,
    "child.stdio[3].once('data', () => { child.stdio[3].destroy(); child.unref(); process.exit(0); });",
  ].join("\n");
  const { runCommand } = await import("../../src/engine/runtime/command-node-runtime.ts");
  try {
    const startedAt = Date.now();
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", worker],
      stdin: "",
      maxOutputBytes: 1_024,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(await stat(marker).then(() => true, () => false), true);
    assert.ok(Date.now() - startedAt < 5_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("package-owned runtime kinds are validated and dispatched by their registered adapter", async () => {
  const kind = "acme-secure-worker";
  const registry = createDomainRegistry({
    ...PACK,
    nodes: PACK.nodes.map((node) => node.id === "external" ? {
      ...node,
      runtime: { kind, endpoint: "acme://worker/repository" },
    } : node),
  });
  let validated = false;
  let adapterCalls = 0;
  const runtimes = new NodeRuntimeRegistry([{
    kind,
    validateRuntime: (runtime) => {
      validated = true;
      assert.equal(runtime.endpoint, "acme://worker/repository");
    },
    executeEnvelope: async (envelope, control) => {
      adapterCalls += 1;
      assert.equal(JSON.stringify(envelope).includes("native-result"), false);
      assert.deepEqual(Object.keys(control), [
        "signal",
        "onLog",
        "onModelOutput",
        "onTrajectory",
        "invokeFunction",
        "effects",
      ]);
      return {
        schemaVersion: envelope.schemaVersion,
        status: "completed",
        output: "extension-result",
      };
    },
  }]);

  assert.equal(await runtimes.execute({
    runId: "extension-runtime",
    node: registry.node("external"),
    task: { taskId: "inspect", nodeId: "external", capability: "inspect" },
    execute: async () => "native-result",
  }), "extension-result");
  assert.equal(validated, true);
  assert.equal(adapterCalls, 1);
});

test("standard orchestration supports native, command, coding CLI, and A2A transports without extra wiring", () => {
  const runtimes = createStandardNodeRuntimeRegistry();
  for (const kind of ["roster-native", "shell", "codex-cli", "claude-code", "pi-agent", "hermes-agent", "a2a"]) {
    assert.equal(runtimes.adapter(kind).kind, kind);
  }
});

test("Pi extension packages resolve declared manifest extensions for coding workers", () => {
  assert.deepEqual(DEFAULT_CODING_PI_EXTENSION_PACKAGES, ["@cortexkit/aft-pi"]);
  assert.deepEqual(piExtensionPathsFromManifest("/tmp/pi-package", {
    pi: { extensions: ["./dist/index.js", "", "./extensions"] },
  }), [
    resolve("/tmp/pi-package", "dist/index.js"),
    resolve("/tmp/pi-package", "extensions"),
  ]);

  const resolvedExtensions = resolvePiExtensionPackagePaths(DEFAULT_CODING_PI_EXTENSION_PACKAGES);
  assert.ok(resolvedExtensions.some((extensionPath) =>
    normalize(extensionPath).endsWith(normalize("node_modules/@cortexkit/aft-pi/dist/index.js"))));
});

test("Codex runtime translates the Roster envelope to native non-interactive CLI input", async () => {
  let execution: Parameters<NonNullable<Parameters<typeof createCodexCliNodeRuntimeAdapter>[0]>["runner"]>[0] | undefined;
  let runtimeTempWasWritable = false;
  let runtimeImagePath: string | undefined;
  let runtimeImageBody: string | undefined;
  const logs: string[] = [];
  const trajectories: NodeExecutionTrajectory[] = [];
  let usage: import("../../src/engine/runtime/node-runtime.ts").NodeExecutionUsage | undefined;
  const runtimes = new NodeRuntimeRegistry([createCodexCliNodeRuntimeAdapter({
    trajectory: { readTranscript: trajectoryTranscript },
    runner: async (received) => {
      execution = received;
      runtimeTempWasWritable = typeof received.env?.TMPDIR === "string"
        && await stat(received.env.TMPDIR).then((value) => value.isDirectory(), () => false);
      const imageIndex = received.args.indexOf("--image");
      runtimeImagePath = imageIndex >= 0 ? received.args[imageIndex + 1] : undefined;
      runtimeImageBody = runtimeImagePath
        ? await readFile(runtimeImagePath, "utf8")
        : undefined;
      received.onOutput?.({ stream: "stdout", text: '{"type":"thread.started","thread_id":"thread-1"}\n' });
      return {
        exitCode: 0,
        stderr: "",
        stdout: [
          '{"type":"thread.started","thread_id":"thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"implementation_report\\":{\\"summary\\":\\"done\\"}}"}}',
          '{"type":"turn.completed","usage":{"input_tokens":300,"cached_input_tokens":240,"output_tokens":50}}',
        ].join("\n"),
      };
    },
  })]);
  const output = await runtimes.execute<{ readonly implementation_report: { readonly summary: string } }>({
    runId: "codex-native",
    node: {
      id: "implementer",
      name: "Implementer",
      capabilities: ["implement"],
      metadata: {
        repositorySkills: [{
          id: "repository-skill-review",
          name: "repository-review",
          description: "Review changes using repository policy.",
          relativePath: ".agents/skills/repository-review/SKILL.md",
        }],
      },
      runtime: {
        kind: "codex-cli",
        profile: "coding",
        metadata: {
          workingDirectory: "/tmp/repository",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          sandbox: "workspace-write",
        },
      },
    },
    task: {
      taskId: "implement",
      nodeId: "implementer",
      capability: "implement",
      objective: "Implement the change.",
    },
    target: compileTargetContract({
      id: "coding-change",
      version: "1",
      objective: "Implement the change.",
      acceptanceCriteria: ["The implementation report is verified."],
    }),
    input: { request: "change it" },
    attachments: [{
      kind: "image",
      attachmentId: "chat-layout",
      name: "layout.png",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,cG5n",
    }],
    resultContract: {
      mode: "json",
      outputKey: "implementation_report",
      schema: { type: "object", required: ["implementation_report"] },
    },
    onLog: (entry) => logs.push(entry.text.trim()),
    onTrajectory: (trajectory) => { trajectories.push(trajectory); },
    onUsage: (reported) => { usage = reported; },
    execute: async () => ({ implementation_report: { summary: "native" } }),
  });

  assert.equal(execution?.command, "codex");
  const runtimeTempDirectory = execution?.env?.TMPDIR;
  assert.ok(runtimeTempDirectory);
  assert.deepEqual(execution?.args, [
    "exec", "--json", "--color", "never", "--sandbox", "read-only",
    "--add-dir", runtimeTempDirectory,
    "--config", `shell_environment_policy.set={TMPDIR=${JSON.stringify(runtimeTempDirectory)}}`,
    "--config", "sandbox_workspace_write.exclude_tmpdir_env_var=false",
    "--skip-git-repo-check", "--profile", "coding", "--model", "gpt-5.6-sol",
    "--config", 'model_reasoning_effort="high"', "--image", runtimeImagePath, "-",
  ]);
  assert.equal(runtimeTempWasWritable, true);
  assert.equal(runtimeImageBody, "png");
  assert.equal(await stat(runtimeImagePath!).then(() => true, () => false), false);
  assert.equal(await stat(runtimeTempDirectory).then(() => true, () => false), false);
  assert.equal(execution?.cwd, "/tmp/repository");
  assert.match(execution?.stdin ?? "", /Implement the change/);
  assert.match(execution?.stdin ?? "", /Shared target:.*coding-change/);
  assert.match(execution?.stdin ?? "", /repositorySkills lists Git-owned SKILL\.md files/);
  assert.match(execution?.stdin ?? "", /operatingInstructions.*durable profile/);
  assert.match(execution?.stdin ?? "", /\.agents\/skills\/repository-review\/SKILL\.md/);
  assert.match(execution?.stdin ?? "", /Attachment chat-layout:/);
  assert.doesNotMatch(execution?.stdin ?? "", /data:image\/png;base64/);
  assert.deepEqual(logs, ["Session thread-1 started"]);
  assert.deepEqual(usage, {
    inputTokens: 300,
    cachedInputTokens: 240,
    outputTokens: 50,
    totalTokens: 350,
  });
  assert.equal(trajectories[0]?.source, "codex");
  assert.equal(trajectories[0]?.sourceGroupId, "thread-1");
  assert.deepEqual(output, { implementation_report: { summary: "done" } });
});

test("Claude Code runtime unwraps print-mode JSON without treating the CLI as a Roster worker", async () => {
  let args: ReadonlyArray<string> = [];
  const trajectories: NodeExecutionTrajectory[] = [];
  let usage: import("../../src/engine/runtime/node-runtime.ts").NodeExecutionUsage | undefined;
  const runtimes = new NodeRuntimeRegistry([createClaudeCodeNodeRuntimeAdapter({
    trajectory: { readTranscript: trajectoryTranscript },
    runner: async (received) => {
      args = received.args;
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          type: "result",
          is_error: false,
          result: '```json\n{"review_report":{"approved":true}}\n```',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 60,
            cache_creation_input_tokens: 20,
            output_tokens: 30,
          },
          total_cost_usd: 0.25,
          duration_ms: 1_500,
        }),
      };
    },
  })]);
  const output = await runtimes.execute({
    runId: "claude-native",
    node: {
      id: "reviewer",
      name: "Reviewer",
      capabilities: ["review"],
      runtime: { kind: "claude-code", metadata: { permissionMode: "plan" } },
    },
    task: { taskId: "review", nodeId: "reviewer", capability: "review" },
    input: { implementation_report: "done" },
    resultContract: {
      mode: "json",
      outputKey: "review_report",
      schema: { type: "object", required: ["review_report"] },
    },
    onTrajectory: (trajectory) => { trajectories.push(trajectory); },
    onUsage: (reported) => { usage = reported; },
    execute: async () => ({ review_report: { approved: false } }),
  });

  assert.deepEqual(args.slice(0, 7), [
    "--print", "--output-format", "stream-json", "--verbose", "--safe-mode",
    "--permission-mode", "plan",
  ]);
  assert.ok(args.includes("--include-partial-messages"));
  assert.equal(args[8], "--session-id");
  assert.match(args[9] ?? "", /^[0-9a-f-]{36}$/u);
  assert.ok(!args.includes("--no-session-persistence"));
  assert.deepEqual(usage, {
    inputTokens: 180,
    cachedInputTokens: 60,
    cacheWriteTokens: 20,
    outputTokens: 30,
    totalTokens: 210,
    costUsd: 0.25,
    durationMs: 1_500,
  });
  assert.equal(trajectories[0]?.source, "claude-code");
  assert.equal(trajectories[0]?.sourceGroupId, args[9]);
  assert.deepEqual(output, { review_report: { approved: true } });
});

test("Claude Code reports exact partial usage without replacing an interruption", async () => {
  const interruption = new Error("Roster deadline preempted the delegated runtime");
  let usage: import("../../src/engine/runtime/node-runtime.ts").NodeExecutionUsage | undefined;
  const runtimes = new NodeRuntimeRegistry([createClaudeCodeNodeRuntimeAdapter({
    runner: async (received) => {
      received.onOutput?.({
        stream: "stdout",
        text: `${JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 60,
              cache_creation_input_tokens: 20,
              output_tokens: 30,
            },
          },
        })}\n`,
      });
      throw interruption;
    },
  })]);

  await assert.rejects(
    runtimes.execute({
      runId: "claude-interrupted",
      node: {
        id: "deadline-worker",
        name: "Deadline Worker",
        capabilities: ["operate"],
        runtime: { kind: "claude-code", metadata: { permissionMode: "plan" } },
      },
      task: { taskId: "deadline", nodeId: "deadline-worker", capability: "operate" },
      resultContract: { mode: "json", outputKey: "result", schema: { type: "object" } },
      onUsage: (reported) => { usage = reported; },
      execute: async () => ({ result: "native" }),
    }),
    (error: unknown) => error === interruption,
  );

  assert.deepEqual(usage, {
    inputTokens: 180,
    cachedInputTokens: 60,
    cacheWriteTokens: 20,
    outputTokens: 30,
    totalTokens: 210,
    partial: true,
  });
});

test("Claude Code resumes one explicitly bound runtime session at a safe recovery boundary", async () => {
  const invocations: ReadonlyArray<string>[] = [];
  const adapter = createClaudeCodeNodeRuntimeAdapter({
    runner: async (execution) => {
      invocations.push(execution.args);
      execution.onOutput?.({
        stream: "stdout",
        text: '{"type":"system","subtype":"init"}\n',
      });
      return {
        exitCode: 0,
        stdout: '{"type":"result","is_error":false,"result":"{\\"message\\":\\"done\\"}"}\n',
        stderr: "",
      };
    },
  });
  const registry = new NodeRuntimeRegistry([adapter]);
  const node = {
    id: "recovery-operator",
    name: "Recovery Operator",
    capabilities: ["operate"],
    runtime: { kind: "claude-code" as const },
  };
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const binding = createWorkspaceNodeRuntimeBinding({
    nodeId: node.id,
    runtime: node.runtime,
    epoch: 1,
    topologyVersion: "recovery-topology-v1",
    sessionId,
  });
  for (const taskId of ["initial", "recovery"]) {
    await registry.execute<{ readonly message: string }>({
      runId: `run-${taskId}`,
      node,
      binding,
      task: { taskId, nodeId: node.id, capability: "operate" },
      input: { notification: taskId },
      resultContract: {
        mode: "json",
        outputKey: "turn",
        schema: { type: "object", required: ["message"] },
      },
      validateOutput: (candidate) => Boolean(candidate)
        && typeof candidate === "object"
        && !Array.isArray(candidate)
        && "message" in candidate,
      execute: async () => ({ message: "native" }),
    });
  }

  assert.deepEqual(
    invocations.map((args) => {
      const flag = args.includes("--resume") ? "--resume" : "--session-id";
      const index = args.indexOf(flag);
      return args.slice(index, index + 2);
    }),
    [["--session-id", sessionId], ["--resume", sessionId]],
  );
});

test("Pi agent runtime translates the Roster envelope to a bounded trajectory session", async () => {
  let execution: Parameters<NonNullable<Parameters<typeof createPiAgentNodeRuntimeAdapter>[0]>["runner"]>[0] | undefined;
  let runtimeImagePath: string | undefined;
  let runtimeImageBody: string | undefined;
  const trajectories: NodeExecutionTrajectory[] = [];
  let usage: import("../../src/engine/runtime/node-runtime.ts").NodeExecutionUsage | undefined;
  const runtimes = new NodeRuntimeRegistry([createPiAgentNodeRuntimeAdapter({
    environment: { SPACETIMEDB_TOKEN: "test-service-identity" },
    trajectory: { readTranscript: trajectoryTranscript },
    runner: async (received) => {
      execution = received;
      const imageArgument = received.args.find((argument) =>
        argument.startsWith("@/") && argument.includes("attachment-"));
      runtimeImagePath = imageArgument?.slice(1);
      runtimeImageBody = runtimeImagePath
        ? await readFile(runtimeImagePath, "utf8")
        : undefined;
      return {
        exitCode: 0,
        stderr: "",
        stdout: [
          '{"type":"agent_start"}',
          '{"type":"tool_execution_start","toolName":"edit","args":{"path":"README.md"}}',
          '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"final_report\\":{\\"status\\":\\"verified\\",\\"frontierHash\\":\\"frontier-pi\\"}}"}],"usage":{"input":100,"output":20,"cacheRead":30,"cacheWrite":10,"totalTokens":160,"cost":{"total":0.04}}}}',
        ].join("\n"),
      };
    },
  })]);
  const output = await runtimes.execute({
    runId: "pi-native",
    node: {
      id: "implementer",
      name: "Implementer",
      capabilities: ["implement"],
      runtime: {
        kind: "pi-agent",
        metadata: {
          workingDirectory: "/tmp/repository",
          provider: "openai",
          model: "gpt-5.6-luna",
          thinking: "low",
          extensions: ["./packages/pi-roster"],
          skills: ["/tmp/repository/.agents/skills/repository-review/SKILL.md"],
          tools: ["read", "grep"],
          excludeTools: ["ask_question"],
          noExtensions: true,
          offline: true,
          projectTrust: "no-approve",
        },
      },
    },
    task: { taskId: "implement", nodeId: "implementer", capability: "implement", objective: "Fix README typo." },
    input: { request: "fix typo" },
    attachments: [{
      kind: "image",
      attachmentId: "pi-chat-layout",
      name: "layout.png",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,cG5n",
    }],
    resultContract: {
      mode: "json",
      outputKey: "final_report",
      schema: { type: "object", required: ["final_report"] },
    },
    onTrajectory: (trajectory) => { trajectories.push(trajectory); },
    onUsage: (reported) => { usage = reported; },
    execute: async () => ({ final_report: { status: "native" } }),
  });

  assert.equal(execution?.command, "pi");
  assert.deepEqual(execution?.args.slice(0, 4), ["--print", "--mode", "json", "--session-id"]);
  const sourceId = execution?.args[4];
  assert.match(sourceId ?? "", /^[0-9a-f-]{36}$/u);
  const sessionDirectoryIndex = execution?.args.indexOf("--session-dir") ?? -1;
  assert.ok(sessionDirectoryIndex >= 0);
  const trajectorySessionDirectory = execution?.args[sessionDirectoryIndex + 1];
  assert.ok(trajectorySessionDirectory);
  assert.equal(await stat(trajectorySessionDirectory).then(() => true, () => false), false);
  const nameIndex = execution?.args.indexOf("--name") ?? -1;
  assert.ok(nameIndex >= 0);
  assert.match(execution?.args[nameIndex + 1] ?? "", /^Roster node_execution_/);
  assert.ok(execution?.args.includes("--provider"));
  assert.ok(execution?.args.includes("openai"));
  assert.ok(execution?.args.includes("--model"));
  assert.ok(execution?.args.includes("gpt-5.6-luna"));
  assert.ok(execution?.args.includes("--extension"));
  assert.ok(execution?.args.includes("./packages/pi-roster"));
  assert.ok(execution?.args.includes("--skill"));
  assert.ok(execution?.args.includes("/tmp/repository/.agents/skills/repository-review/SKILL.md"));
  assert.equal(execution?.args.includes("--tools"), false);
  assert.equal(execution?.args.includes("read,grep"), false);
  assert.ok(execution?.args.includes("--exclude-tools"));
  assert.ok(execution?.args.includes("ask_question"));
  assert.ok(execution?.args.includes("--no-extensions"));
  assert.ok(execution?.args.includes("--offline"));
  assert.ok(execution?.args.includes("--no-approve"));
  assert.ok(execution?.args.includes(`@${runtimeImagePath}`));
  assert.equal(runtimeImageBody, "png");
  assert.equal(await stat(runtimeImagePath!).then(() => true, () => false), false);
  assert.equal(execution?.cwd, "/tmp/repository");
  assert.equal(execution?.env?.SPACETIMEDB_TOKEN, "test-service-identity");
  assert.match(execution?.stdin ?? "", /Fix README typo/);
  assert.deepEqual(usage, {
    inputTokens: 140,
    cachedInputTokens: 30,
    cacheWriteTokens: 10,
    outputTokens: 20,
    totalTokens: 160,
    costUsd: 0.04,
  });
  assert.equal(trajectories[0]?.source, "pi");
  assert.equal(trajectories[0]?.sourceGroupId, sourceId);
  assert.deepEqual(output, { final_report: { status: "verified", frontierHash: "frontier-pi" } });
});

test("Pi agent runtime extracts its final result incrementally from a verbose event stream", async () => {
  let captureLimit = 0;
  let hardLimit = 0;
  let transportLimit = 0;
  let measuredBytes = 0;
  const runtimes = new NodeRuntimeRegistry([createPiAgentNodeRuntimeAdapter({
    runner: async (received) => {
      captureLimit = received.maxCaptureBytes ?? 0;
      hardLimit = received.maxOutputBytes;
      transportLimit = received.maxTransportBytes ?? 0;
      const repeatedUpdate = {
        stream: "stdout" as const,
        text: `${JSON.stringify({ type: "message_update", message: "x".repeat(32_000) })}\n`,
      };
      measuredBytes += received.outputBudgetBytes?.(repeatedUpdate) ?? Buffer.byteLength(repeatedUpdate.text);
      received.onOutput?.(repeatedUpdate);
      const toolEvent = {
        stream: "stdout",
        text: `${JSON.stringify({ type: "tool_execution_end", toolName: "inspect", detail: "x".repeat(32_000) })}\n`,
      } as const;
      measuredBytes += received.outputBudgetBytes?.(toolEvent) ?? Buffer.byteLength(toolEvent.text);
      received.onOutput?.(toolEvent);
      const finalEvent = {
        stream: "stdout",
        text: `${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ proposal: { status: "ready" } }) }],
          },
        })}\n`,
      } as const;
      measuredBytes += received.outputBudgetBytes?.(finalEvent) ?? Buffer.byteLength(finalEvent.text);
      received.onOutput?.(finalEvent);
      return { exitCode: 0, stdout: "", stderr: "", stdoutTruncated: true };
    },
  })]);
  const output = await runtimes.execute({
    runId: "pi-streaming-result",
    node: {
      id: "planner",
      name: "Planner",
      capabilities: ["propose"],
      runtime: { kind: "pi-agent" },
    },
    task: { taskId: "propose", nodeId: "planner", capability: "propose" },
    resultContract: {
      mode: "json",
      outputKey: "proposal",
      schema: { type: "object", required: ["proposal"] },
    },
    execute: async () => ({ proposal: { status: "native" } }),
  });

  assert.deepEqual(output, { proposal: { status: "ready" } });
  assert.equal(captureLimit, 1_048_576);
  assert.equal(hardLimit, 64 * 1_048_576);
  assert.equal(transportLimit, 512 * 1_048_576);
  assert.ok(measuredBytes < 35_000);
});

test("Pi agent runtime exposes assistant text deltas without turning them into diagnostics", async () => {
  const modelOutput: Array<{ readonly kind: string; readonly text: string }> = [];
  const runtimes = new NodeRuntimeRegistry([createPiAgentNodeRuntimeAdapter({
    runner: async (received) => {
      for (const delta of [
        '{"disposition":"informational","answer":"Hello',
        ' from the repository team."}',
      ]) {
        received.onOutput?.({
          stream: "stdout",
          text: `${JSON.stringify({
            type: "message_update",
            usage: {},
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta,
            },
          })}\n`,
        });
      }
      received.onOutput?.({
        stream: "stdout",
        text: `${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{
              type: "text",
              text: '{"disposition":"informational","answer":"Hello from the repository team."}',
            }],
          },
        })}\n`,
      });
      return { exitCode: 0, stdout: "", stderr: "", stdoutTruncated: true };
    },
  })]);

  await runtimes.execute({
    runId: "pi-model-output",
    node: {
      id: "planner",
      name: "Planner",
      capabilities: ["route-conversation"],
      runtime: { kind: "pi-agent" },
    },
    task: { taskId: "route", nodeId: "planner", capability: "route-conversation" },
    resultContract: {
      mode: "json",
      outputKey: "decision",
      schema: { type: "object", required: ["disposition", "answer"] },
    },
    onModelOutput: (entry) => { modelOutput.push(entry); },
    execute: async () => ({ disposition: "informational", answer: "native" }),
  });

  assert.deepEqual(modelOutput, [
    { kind: "delta", text: '{"disposition":"informational","answer":"Hello' },
    { kind: "delta", text: ' from the repository team."}' },
  ]);
});

test("Pi agent compacts an oversized cumulative update and still accepts the final result", async () => {
  let measuredBytes = 0;
  const logs: string[] = [];
  const runtimes = new NodeRuntimeRegistry([createPiAgentNodeRuntimeAdapter({
    runner: async (received) => {
      const update = `${JSON.stringify({
        type: "message_update",
        message: "x".repeat((4 * 1_048_576) + 8_192),
      })}\n`;
      for (const text of [update.slice(0, 2_000_000), update.slice(2_000_000)]) {
        const entry = { stream: "stdout" as const, text };
        measuredBytes += received.outputBudgetBytes?.(entry) ?? Buffer.byteLength(text);
        received.onOutput?.(entry);
      }
      const finalEvent = {
        stream: "stdout" as const,
        text: `${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ proposal: { status: "ready" } }) }],
          },
        })}\n`,
      };
      measuredBytes += received.outputBudgetBytes?.(finalEvent) ?? Buffer.byteLength(finalEvent.text);
      received.onOutput?.(finalEvent);
      return { exitCode: 0, stdout: "", stderr: "", stdoutTruncated: true };
    },
  })]);

  const output = await runtimes.execute({
    runId: "pi-oversized-update",
    node: {
      id: "planner",
      name: "Planner",
      capabilities: ["propose"],
      runtime: { kind: "pi-agent" },
    },
    task: { taskId: "propose", nodeId: "planner", capability: "propose" },
    resultContract: {
      mode: "json",
      outputKey: "proposal",
      schema: { type: "object", required: ["proposal"] },
    },
    onLog: (entry) => { logs.push(entry.text); },
    execute: async () => ({ proposal: { status: "native" } }),
  });

  assert.deepEqual(output, { proposal: { status: "ready" } });
  assert.ok(measuredBytes < 2_000);
  assert.ok(logs.includes("Oversized incremental provider snapshot compacted\n"));
});

test("Pi agent still rejects an oversized non-incremental protocol event", async () => {
  const runtimes = new NodeRuntimeRegistry([createPiAgentNodeRuntimeAdapter({
    runner: async (received) => {
      const event = {
        stream: "stdout" as const,
        text: `${JSON.stringify({ type: "tool_execution_end", detail: "x".repeat((4 * 1_048_576) + 1) })}\n`,
      };
      received.outputBudgetBytes?.(event);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  })]);

  await assert.rejects(() => runtimes.execute({
    runId: "pi-oversized-tool-event",
    node: {
      id: "planner",
      name: "Planner",
      capabilities: ["propose"],
      runtime: { kind: "pi-agent" },
    },
    task: { taskId: "propose", nodeId: "planner", capability: "propose" },
    resultContract: {
      mode: "json",
      outputKey: "proposal",
      schema: { type: "object", required: ["proposal"] },
    },
    execute: async () => ({ proposal: { status: "native" } }),
  }), /Pi agent event exceeded maxEventBytes=4194304/u);
});

test("Pi agent surfaces a provider failure instead of a missing-message protocol error", async () => {
  const runtimes = new NodeRuntimeRegistry([createPiAgentNodeRuntimeAdapter({
    runner: async () => ({
      exitCode: 0,
      stderr: "",
      stdout: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "provider quota exhausted",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
        {
          type: "agent_end",
          messages: [{
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "provider quota exhausted",
          }],
        },
      ].map((event) => JSON.stringify(event)).join("\n"),
    }),
  })]);

  await assert.rejects(
    runtimes.execute({
      runId: "pi-provider-failure",
      node: {
        id: "planner",
        name: "Planner",
        capabilities: ["propose"],
        runtime: { kind: "pi-agent" },
      },
      task: { taskId: "propose", nodeId: "planner", capability: "propose" },
      resultContract: {
        mode: "json",
        outputKey: "proposal",
        schema: { type: "object", required: ["proposal"] },
      },
      execute: async () => ({ proposal: "native" }),
    }),
    /Pi agent provider failed: provider quota exhausted/u,
  );
});

test("Hermes Agent runtime uses quiet one-shot mode and returns the requested JSON", async () => {
  let execution: Parameters<NonNullable<Parameters<typeof createHermesAgentNodeRuntimeAdapter>[0]>["runner"]>[0] | undefined;
  let runtimeImagePath: string | undefined;
  let runtimeImageBody: string | undefined;
  const logs: string[] = [];
  const trajectories: NodeExecutionTrajectory[] = [];
  const hermesHomes: string[] = [];
  let usage: import("../../src/engine/runtime/node-runtime.ts").NodeExecutionUsage | undefined;
  const runtimes = new NodeRuntimeRegistry([createHermesAgentNodeRuntimeAdapter({
    environment: { HERMES_HOME: "/tmp/hermes-profile" },
    trajectory: { readTranscript: trajectoryTranscript },
    runner: async (received) => {
      if (received.env?.HERMES_HOME) hermesHomes.push(received.env.HERMES_HOME);
      if (received.args.includes("sessions")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            id: "hermes-session-1",
            input_tokens: 70,
            output_tokens: 25,
            cache_read_tokens: 20,
            cache_write_tokens: 10,
            reasoning_tokens: 5,
            estimated_cost_usd: 0.015,
            messages: [],
          }),
        };
      }
      execution = received;
      const imageIndex = received.args.indexOf("--image");
      runtimeImagePath = imageIndex >= 0 ? received.args[imageIndex + 1] : undefined;
      runtimeImageBody = runtimeImagePath
        ? await readFile(runtimeImagePath, "utf8")
        : undefined;
      received.onOutput?.({ stream: "stdout", text: '{"finding":"coordinated"}\n' });
      return {
        exitCode: 0,
        stderr: "",
        stdout: '```json\n{"finding":"coordinated"}\n```\n\nsession_id: hermes-session-1',
      };
    },
  })]);
  const output = await runtimes.execute({
    runId: "hermes-native",
    node: {
      id: "researcher",
      name: "Hermes Researcher",
      capabilities: ["inspect"],
      runtime: {
        kind: "hermes-agent",
        metadata: {
          workingDirectory: "/tmp/repository",
          provider: "openrouter",
          model: "nousresearch/hermes-4",
          yolo: true,
        },
      },
    },
    task: {
      taskId: "inspect",
      nodeId: "researcher",
      capability: "inspect",
      objective: "Inspect the repository.",
    },
    resultContract: {
      mode: "json",
      outputKey: "finding",
      schema: { type: "object", required: ["finding"] },
    },
    attachments: [{
      kind: "image",
      attachmentId: "hermes-chat-layout",
      name: "layout.png",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,cG5n",
    }],
    onLog: (entry) => logs.push(entry.text.trim()),
    onTrajectory: (trajectory) => { trajectories.push(trajectory); },
    onUsage: (reported) => { usage = reported; },
    execute: async () => ({ finding: "native" }),
  });

  assert.equal(execution?.command, "hermes");
  assert.deepEqual(execution?.args.slice(0, 3), [
    "chat", "--quiet", "--query",
  ]);
  assert.match(execution?.args[3] ?? "", /Inspect the repository/);
  assert.ok(execution?.args.includes("--provider"));
  assert.ok(execution?.args.includes("openrouter"));
  assert.ok(execution?.args.includes("--model"));
  assert.ok(execution?.args.includes("nousresearch/hermes-4"));
  assert.equal(execution?.args.includes("--yolo"), false);
  assert.ok(execution?.args.includes("--image"));
  assert.equal(runtimeImageBody, "png");
  assert.equal(await stat(runtimeImagePath!).then(() => true, () => false), false);
  assert.deepEqual(execution?.args.slice(-2), ["--source", "roster"]);
  assert.equal(execution?.stdin, "");
  assert.equal(execution?.cwd, "/tmp/repository");
  assert.match(execution?.env?.HERMES_HOME ?? "", /roster-hermes-runtime-.+\/hermes-home$/u);
  assert.equal(execution?.env?.HERMES_HOME === "/tmp/hermes-profile", false);
  assert.deepEqual(hermesHomes, [
    execution?.env?.HERMES_HOME,
    execution?.env?.HERMES_HOME,
  ]);
  assert.deepEqual(logs, ['{"finding":"coordinated"}']);
  assert.deepEqual(usage, {
    inputTokens: 100,
    cachedInputTokens: 20,
    cacheWriteTokens: 10,
    outputTokens: 25,
    reasoningTokens: 5,
    totalTokens: 125,
    costUsd: 0.015,
  });
  assert.equal(trajectories[0]?.source, "hermes");
  assert.equal(trajectories[0]?.sourceGroupId, "hermes-session-1");
  assert.deepEqual(output, { finding: "coordinated" });
});

for (const runtimeCase of [
  {
    kind: "codex-cli" as const,
    profile: "repository-coding",
    adapter: createCodexCliNodeRuntimeAdapter,
    stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"announcement\\":{\\"summary\\":\\"Starting now.\\"}}"}}',
  },
  {
    kind: "claude-code" as const,
    profile: "repository-coding",
    adapter: createClaudeCodeNodeRuntimeAdapter,
    stdout: '{"type":"result","is_error":false,"result":"{\\"announcement\\":{\\"summary\\":\\"Starting now.\\"}}"}',
  },
  {
    kind: "hermes-agent" as const,
    adapter: createHermesAgentNodeRuntimeAdapter,
    stdout: '{"announcement":{"summary":"Starting now."}}',
  },
] as const) {
  test(`${runtimeCase.kind} isolates an explicit no-workspace room turn from the repository`, async () => {
    const repositoryDirectory = process.cwd();
    const runId = `isolated-${runtimeCase.kind}`;
    const taskId = `announce-${runtimeCase.kind}`;
    const nodeId = `room-${runtimeCase.kind}`;
    let executionDirectory = "";
    let executionArguments: ReadonlyArray<string> = [];
    let executionPrompt = "";
    let hermesConfig: unknown;
    const adapter = runtimeCase.adapter({
      runner: async (execution) => {
        executionDirectory = execution.cwd ?? "";
        executionArguments = execution.args;
        executionPrompt = runtimeCase.kind === "hermes-agent"
          ? execution.args[execution.args.indexOf("--query") + 1] ?? ""
          : execution.stdin;
        assert.notEqual(executionDirectory, repositoryDirectory);
        assert.match(executionDirectory, /roster-(?:codex|claude|hermes)-runtime-/u);
        assert.equal(await stat(executionDirectory).then((entry) => entry.isDirectory()), true);
        assert.equal(execution.env?.GIT_INDEX_FILE, undefined);
        assert.equal(execution.env?.GIT_OBJECT_DIRECTORY, undefined);
        assert.equal(execution.env?.GIT_ALTERNATE_OBJECT_DIRECTORIES, undefined);
        if (runtimeCase.kind === "hermes-agent") {
          hermesConfig = JSON.parse(await readFile(
            join(execution.env?.HERMES_HOME ?? "", "config.yaml"),
            "utf8",
          ));
        }
        return { exitCode: 0, stderr: "", stdout: runtimeCase.stdout };
      },
    });
    const runtime = {
      kind: runtimeCase.kind,
      ...(runtimeCase.profile ? { profile: runtimeCase.profile } : {}),
      metadata: {
        workingDirectory: repositoryDirectory,
        ...(runtimeCase.kind === "codex-cli" ? { sandbox: "workspace-write" } : {}),
        ...(runtimeCase.kind === "claude-code" ? { permissionMode: "acceptEdits" } : {}),
        ...(runtimeCase.kind === "hermes-agent" ? { yolo: true } : {}),
      },
    };
    const output = await new NodeRuntimeRegistry([adapter]).execute({
      runId,
      node: {
        id: nodeId,
        name: "Room Specialist",
        capabilities: ["room"],
        runtime,
      },
      task: {
        taskId,
        nodeId,
        capability: "room",
        objective: "Tell the room what you will do next.",
      },
      grant: isolatedRoomExecutionGrant({ runId, taskId, nodeId }),
      resultContract: {
        mode: "json",
        outputKey: "announcement",
        schema: { type: "object", required: ["announcement"] },
      },
      execute: async () => ({ announcement: { summary: "native" } }),
    });

    assert.deepEqual(output, { announcement: { summary: "Starting now." } });
    assert.equal(await stat(executionDirectory).then(() => true, () => false), false);
    assert.equal(executionPrompt.includes(repositoryDirectory), false);
    assert.doesNotMatch(executionPrompt, /workingDirectory/u);
    if (runtimeCase.kind === "codex-cli") {
      assert.deepEqual(
        executionArguments,
        [
          "exec",
          "--json",
          "--color", "never",
          "--ignore-user-config",
          "--ignore-rules",
          "--ephemeral",
          "--config",
          `permissions.roster_room={description="Roster room announcement",filesystem={":minimal"="read",":workspace_roots"="read"},workspace_roots={${JSON.stringify(executionDirectory)}=true}}`,
          "--config",
          'default_permissions="roster_room"',
          "--add-dir", executionDirectory,
          "--config", `shell_environment_policy.set={TMPDIR=${JSON.stringify(executionDirectory)}}`,
          "--config", "sandbox_workspace_write.exclude_tmpdir_env_var=false",
          "--skip-git-repo-check",
          "-",
        ],
      );
    } else if (runtimeCase.kind === "claude-code") {
      assert.ok(executionArguments.includes("--restricted"));
      assert.ok(executionArguments.includes("--strict-mcp-config"));
      assert.ok(executionArguments.includes("--no-chrome"));
      assert.ok(executionArguments.includes("--no-session-persistence"));
      assert.equal(executionArguments.includes("--resume"), false);
      assert.equal(executionArguments.includes("--session-id"), false);
      assert.equal(executionArguments.includes("--agent"), false);
      assert.deepEqual(
        executionArguments.slice(executionArguments.indexOf("--tools"), executionArguments.indexOf("--tools") + 2),
        ["--tools", ""],
      );
      assert.deepEqual(
        executionArguments.slice(executionArguments.indexOf("--permission-mode"), executionArguments.indexOf("--permission-mode") + 2),
        ["--permission-mode", "plan"],
      );
    } else {
      assert.equal(executionArguments.includes("--yolo"), false);
      assert.deepEqual(hermesConfig, { platform_toolsets: { cli: [] } });
    }
  });
}

for (const runtimeCase of [
  { kind: "codex-cli" as const, adapter: createCodexCliNodeRuntimeAdapter },
  { kind: "claude-code" as const, adapter: createClaudeCodeNodeRuntimeAdapter },
  { kind: "hermes-agent" as const, adapter: createHermesAgentNodeRuntimeAdapter },
] as const) {
  test(`${runtimeCase.kind} cleans its isolated room directory after provider failure`, async () => {
    const runId = `isolated-failure-${runtimeCase.kind}`;
    const taskId = `announce-failure-${runtimeCase.kind}`;
    const nodeId = `room-failure-${runtimeCase.kind}`;
    let executionDirectory = "";
    const adapter = runtimeCase.adapter({
      runner: async (execution) => {
        executionDirectory = execution.cwd ?? "";
        assert.match(executionDirectory, /roster-(?:codex|claude|hermes)-runtime-/u);
        assert.equal(await stat(executionDirectory).then((entry) => entry.isDirectory()), true);
        return { exitCode: 19, stderr: "provider unavailable", stdout: "" };
      },
    });

    await assert.rejects(
      new NodeRuntimeRegistry([adapter]).execute({
        runId,
        node: {
          id: nodeId,
          name: "Room Specialist",
          capabilities: ["room"],
          runtime: {
            kind: runtimeCase.kind,
            metadata: { workingDirectory: process.cwd() },
          },
        },
        task: {
          taskId,
          nodeId,
          capability: "room",
          objective: "Tell the room what you will do next.",
        },
        grant: isolatedRoomExecutionGrant({ runId, taskId, nodeId }),
        resultContract: {
          mode: "json",
          outputKey: "announcement",
          schema: { type: "object", required: ["announcement"] },
        },
        execute: async () => ({ announcement: { summary: "native" } }),
      }),
      /exited with code 19/u,
    );
    assert.equal(await stat(executionDirectory).then(() => true, () => false), false);
  });
}

test("Hermes telemetry failure cannot overturn a successful bounded result", async () => {
  const logs: string[] = [];
  let usageReported = false;
  const runtimes = new NodeRuntimeRegistry([createHermesAgentNodeRuntimeAdapter({
    runner: async (received) => received.args.includes("sessions")
      ? { exitCode: 17, stdout: "", stderr: "corrupt session store" }
      : {
          exitCode: 0,
          stderr: "",
          stdout: '{"finding":"complete"}\nsession_id: hermes-session-corrupt',
        },
  })]);
  const output = await runtimes.execute({
    runId: "hermes-telemetry-failure",
    node: {
      id: "researcher",
      name: "Hermes Researcher",
      capabilities: ["inspect"],
      runtime: { kind: "hermes-agent" },
    },
    task: { taskId: "inspect", nodeId: "researcher", capability: "inspect" },
    resultContract: {
      mode: "json",
      outputKey: "finding",
      schema: { type: "object", required: ["finding"] },
    },
    onLog: (entry) => logs.push(entry.text),
    onUsage: () => { usageReported = true; },
    execute: async () => ({ finding: "native" }),
  });

  assert.deepEqual(output, { finding: "complete" });
  assert.equal(usageReported, false);
  assert.ok(logs.some((entry) =>
    entry.includes("Hermes session telemetry unavailable: export exited with code 17")));
});

test("runtime log storage stays process-local, bounded, sanitized, and node-scoped", () => {
  let now = 100;
  const observed: string[] = [];
  const store = new NodeRuntimeLogStore({
    maxRuns: 1,
    maxEntriesPerRun: 2,
    maxBytesPerRun: 1_024,
    maxEntryBytes: 128,
    now: () => now++,
  });
  const append = (runId: string, nodeId: string, text: string) => store.append({
    runId,
    nodeId,
    taskId: "inspect",
    runtime: "codex-cli",
    stream: "stdout",
    text,
  });
  const unsubscribe = store.subscribe("run-a", (entry) => observed.push(entry.text));
  append("run-a", "first", "\u001b[31mred\u001b[0m");
  append("run-a", "second", "two");
  append("run-a", "first", "three");
  assert.deepEqual(observed, ["red", "two", "three"]);
  assert.deepEqual(store.list("run-a").map((entry) => entry.text), ["two", "three"]);
  assert.deepEqual(store.list("run-a", { nodeId: "first" }).map((entry) => entry.text), ["three"]);
  unsubscribe();
  append("run-a", "first", "after unsubscribe");
  assert.deepEqual(observed, ["red", "two", "three"]);
  append("run-b", "other", "new run");
  assert.deepEqual(store.list("run-a"), []);
});

test("runtime log client buffering stays bounded while its writer is blocked", () => {
  const buffer = new NodeRuntimeLogPendingBuffer({
    maxEntries: 3,
    maxBytes: 1_200,
  });
  const byteBounded = new NodeRuntimeLogPendingBuffer({
    maxEntries: 100,
    maxBytes: 700,
  });
  for (let sequence = 1; sequence <= 1_000; sequence += 1) {
    const entry = {
      runId: "blocked-writer",
      nodeId: "implementer",
      taskId: "implement",
      runtime: "codex-cli",
      stream: "stdout",
      text: `sustained-log-${String(sequence).padStart(4, "0")}-${"x".repeat(80)}`,
      sequence,
      at: sequence,
      truncated: false,
    } as const;
    buffer.push(entry);
    byteBounded.push(entry);
  }

  assert.equal(buffer.size, 3);
  assert.ok(buffer.byteLength <= 1_200);
  assert.ok(byteBounded.size < 100);
  assert.ok(byteBounded.byteLength <= 700);
  let newestByteBoundedSequence = 0;
  while (byteBounded.size > 0) {
    newestByteBoundedSequence = byteBounded.shift()?.sequence ?? newestByteBoundedSequence;
  }
  assert.equal(newestByteBoundedSequence, 1_000);
  assert.deepEqual(
    [buffer.shift()?.sequence, buffer.shift()?.sequence, buffer.shift()?.sequence],
    [998, 999, 1_000],
    "slow clients deterministically retain only the newest bounded suffix",
  );
  assert.equal(buffer.size, 0);
  buffer.push({
    runId: "blocked-writer",
    nodeId: "implementer",
    taskId: "implement",
    runtime: "codex-cli",
    stream: "stdout",
    text: "disconnect cleanup",
    sequence: 1_001,
    at: 1_001,
    truncated: false,
  });
  buffer.clear();
  byteBounded.clear();
  assert.equal(buffer.size, 0);
  assert.equal(buffer.byteLength, 0);
  assert.equal(byteBounded.byteLength, 0);
});

test("A2A runtime posts the execution envelope and validates the remote result", async () => {
  let received: unknown;
  const runtimes = new NodeRuntimeRegistry([createA2ANodeRuntimeAdapter({
    fetch: async (input, init) => {
      assert.equal(String(input), "https://agents.example.test/execute");
      assert.equal(init.method, "POST");
      received = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: { finding: "remote-inspection" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  })]);

  const result = await runtimes.execute<{ readonly finding: string }>({
    runId: "a2a-runtime",
    node: {
      id: "remote",
      name: "Remote Researcher",
      capabilities: ["inspect"],
      runtime: { kind: "a2a", endpoint: "https://agents.example.test/execute" },
    },
    task: { taskId: "inspect", nodeId: "remote", capability: "inspect" },
    input: { subject: "repository" },
    resultContract: {
      mode: "json",
      outputKey: "finding",
      schema: { type: "object", required: ["finding"] },
    },
    validateOutput: (output) => Boolean(output)
      && typeof output === "object"
      && typeof (output as { finding?: unknown }).finding === "string",
    execute: async () => ({ finding: "native-result" }),
  });

  assert.equal((received as { node: { name: string } }).node.name, "Remote Researcher");
  assert.deepEqual(result, { finding: "remote-inspection" });
});

test("A2A runtime stops reading an undeclared oversized response", async () => {
  const runtimes = new NodeRuntimeRegistry([createA2ANodeRuntimeAdapter({
    maxResponseBytes: 1_024,
    fetch: async () => new Response(new Uint8Array(2_048), { status: 200 }),
  })]);
  await assert.rejects(() => runtimes.execute({
    runId: "a2a-oversized",
    node: {
      id: "remote",
      name: "Remote Researcher",
      capabilities: ["inspect"],
      runtime: { kind: "a2a", endpoint: "https://agents.example.test/execute" },
    },
    task: { taskId: "inspect", nodeId: "remote", capability: "inspect" },
    execute: async () => "native-result",
  }), /exceeded maxResponseBytes=1024/);
});

test("runtime bindings advance independently from durable node identity", () => {
  let state = reduceOrchestration(
    initialOrchestrationState,
    orchestrationConfiguredEvent("binding-run", PACK),
    1,
  );
  state = reduceOrchestration(state, nodeRuntimeBoundEvent({
    runId: "binding-run",
    nodeId: "external",
    runtime: { kind: "codex-cli", profile: "repository-inspector" },
    epoch: 1,
    topologyVersion: "topology-1",
    sandboxId: "sandbox-a",
    sessionId: "session-a",
  }), 2);
  state = reduceOrchestration(state, nodeRuntimeBoundEvent({
    runId: "binding-run",
    nodeId: "external",
    runtime: { kind: "codex-cli", profile: "repository-inspector" },
    epoch: 2,
    topologyVersion: "topology-1",
    sandboxId: "sandbox-b",
    sessionId: "session-a",
  }), 3);

  const nodes = orchestrationWorkspaceNodes(state);
  assert.equal(nodes.external?.id, "external");
  assert.equal(nodes.external?.binding?.sandboxId, "sandbox-b");
  assert.equal(nodes.external?.binding?.epoch, 2);
  assert.equal(nodes.external?.lifecycle, "active");

  assert.throws(() => reduceOrchestration(state, nodeRuntimeBoundEvent({
    runId: "binding-run",
    nodeId: "external",
    runtime: { kind: "codex-cli" },
    epoch: 1,
    topologyVersion: "topology-1",
    sandboxId: "stale",
  }), 4), /epoch must advance/);
});

test("workspace node projection derives assignments without duplicating orchestration state", () => {
  const binding = createWorkspaceNodeRuntimeBinding({
    nodeId: "external",
    runtime: { kind: "codex-cli" },
    epoch: 1,
    topologyVersion: "topology-1",
  });
  const projected = projectWorkspaceNodes({
    nodes: {
      external: {
        id: "external",
        name: "External",
        capabilities: ["inspect"],
        runtime: { kind: "codex-cli" },
        status: "active",
        updatedAt: 1,
      },
    },
    bindings: { external: { ...binding, updatedAt: 2 } },
    tasks: {
      second: { taskId: "second", nodeId: "external" },
      first: { taskId: "first", nodeId: "external" },
    },
    topologyId: "topology-1",
  });
  assert.deepEqual(projected.external?.taskIds, ["first", "second"]);
  assert.equal(projected.external?.updatedAt, 2);
});

test("shared workspace converges append-only entries and exposes exclusive decision conflicts", async () => {
  const left = new SharedWorkspaceLedger("workspace/run");
  const right = new SharedWorkspaceLedger("workspace/run");
  const authorized: string[] = [];
  const leftContext = createRosterTaskContext({
    node: createDomainRegistry(PACK).node("coordinator"),
    ledger: left,
    fence: {
      runId: "workspace-run",
      taskId: "task-left",
      nodeId: "coordinator",
      fence: 1n,
      runtimeBindingEpoch: 1,
      frontierVersion: "frontier-1",
      topologyVersion: "topology-1",
      catalogVersion: "catalog-1",
      inputVersions: { request: "v1" },
    },
    authority: {
      assertActive: async (operation, fence) => {
        authorized.push(`${operation}:${fence.taskId}:${String(fence.fence)}`);
      },
    },
  });
  const finding = await leftContext.publish({
    kind: "finding",
    mode: "append",
    subjectId: "auth",
    body: { summary: "Authentication is stateful." },
    references: ["file:auth.ts"],
  });
  assert.deepEqual(authorized, ["publish:task-left:1"]);
  const decisionA = left.publish({
    runId: "workspace-run",
    taskId: "decision-left",
    nodeId: "coordinator",
    frontierVersion: "frontier-1",
    topologyVersion: "topology-1",
    entry: {
      kind: "decision",
      mode: "exclusive",
      subjectId: "auth-strategy",
      body: { strategy: "sessions" },
      references: [finding.entry.entryId],
    },
  });
  const decisionB = right.publish({
    runId: "workspace-run",
    taskId: "decision-right",
    nodeId: "external",
    frontierVersion: "frontier-1",
    topologyVersion: "topology-1",
    entry: {
      kind: "decision",
      mode: "exclusive",
      subjectId: "auth-strategy",
      body: { strategy: "tokens" },
      references: [finding.entry.entryId],
    },
  });

  const forward = new SharedWorkspaceLedger("workspace/run", mergeSharedArtifactUpdates(
    finding.update,
    decisionA.update,
    decisionB.update,
  ));
  const reverse = new SharedWorkspaceLedger("workspace/run", mergeSharedArtifactUpdates(
    decisionB.update,
    decisionA.update,
    finding.update,
  ));
  const frontier = { frontierVersion: "frontier-1", topologyVersion: "topology-1" };
  const forwardProjection = forward.project(frontier);
  const reverseProjection = reverse.project(frontier);
  assert.equal(forwardProjection.versionHash, reverseProjection.versionHash);
  assert.deepEqual(forwardProjection.conflicts, reverseProjection.conflicts);
  assert.equal(forwardProjection.conflicts.length, 1);
  assert.equal(forwardProjection.value.entries.length, 1);
  assert.equal(forwardProjection.value.entries[0]?.kind, "finding");

  left.destroy();
  right.destroy();
  forward.destroy();
  reverse.destroy();
});
