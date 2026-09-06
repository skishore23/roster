import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bindRosterMemoryFunctionProviders,
  createCodexCliNodeRuntimeAdapter,
  createCompositeRosterMemoryRepository,
  createDocumentRosterMemoryRepository,
  createRosterFunctionExecutionPlane,
  createRosterMemoryFunctionDescriptors,
  NodeRuntimeRegistry,
  rosterMemoryDocument,
  ROSTER_CATALOG_INVOKE_FUNCTION_ID,
  ROSTER_CATALOG_SEARCH_FUNCTION_ID,
  ROSTER_MEMORY_PROPOSE_FUNCTION_ID,
  ROSTER_MEMORY_SEARCH_FUNCTION_ID,
  type CommandExecution,
  type CommandExecutionResult,
} from "../../src/sdk/runtime.ts";
import { RosterFunctionDirectory } from "../../src/sdk/capabilities.ts";
import type { WorkspaceNode } from "../../src/sdk/workspace.ts";
import {
  createMemoryTools,
  decideMemory,
  initialMemoryState,
  reduceMemory,
  type MemoryCmd,
  type MemoryEvent,
  type MemoryState,
} from "../../src/adapters/memory-tools.ts";
import { memoryBranchStore, memoryStore } from "../../src/adapters/memory-store.ts";
import { createDurableRosterMemoryRepository } from "../../src/adapters/roster-memory.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { runCommand } from "../../src/engine/runtime/command-node-runtime.ts";

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
});

const responseHandle = (response: string): string => {
  const parsed = JSON.parse(response) as {
    readonly context?: { readonly handle?: unknown };
  };
  assert.equal(typeof parsed.context?.handle, "string");
  return parsed.context.handle as string;
};

test("code-mode agents search past room and durable memory through handles and can only propose writes", async () => {
  const runtime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
    memoryStore<MemoryEvent>(),
    memoryBranchStore(),
    decideMemory,
    reduceMemory,
    initialMemoryState,
  );
  const memoryDirectory = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "roster-memory-plane-")));
  try {
    const memory = createMemoryTools({
      dir: memoryDirectory,
      runtime,
      now: (() => {
        let value = 1_000;
        return () => value++;
      })(),
    });
    await memory.commit({
      scope: "workspace/project-a",
      text: "The accepted architecture uses a provider-neutral context handle.",
      tags: ["architecture"],
    });

    const roomSecret = "ROOM_HISTORY_BODY_DOES_NOT_ENTER_CALL_OBSERVATION";
    const roomRepository = createDocumentRosterMemoryRepository({
      scopes: async () => [{
        scopeId: "room:current",
        kind: "room",
        label: "Current room history",
        description: "Chronological messages in the current authorized room.",
        snapshotVersion: "room-frontier-7",
      }],
      documents: async () => [
        rosterMemoryDocument({
          documentId: "room-message-7",
          scopeId: "room:current",
          kind: "room-message",
          text: `${roomSecret}: use the accepted memory proposal path`,
          timestamp: 700,
          metadata: { author: "user" },
          sourceVersion: "room-frontier-7",
        }),
      ],
    });
    const repository = createCompositeRosterMemoryRepository([
      createDurableRosterMemoryRepository(memory),
      roomRepository,
    ]);
    const descriptors = createRosterMemoryFunctionDescriptors({
      readScope: "memory:read",
      proposeScope: "memory:propose",
    });
    const directory = new RosterFunctionDirectory(descriptors);
    const dispose = bindRosterMemoryFunctionProviders({ directory, repository });
    const plane = createRosterFunctionExecutionPlane({
      directory,
      access: () => ({
        functionGrants: descriptors.map((descriptor) => descriptor.id),
        scopes: ["memory:read", "memory:propose"],
        allowedEffects: ["read", "write"],
      }),
    });
    const node: WorkspaceNode = {
      id: "memory-worker",
      name: "Memory Worker",
      capabilities: ["memory"],
      runtime: { kind: "codex-cli" },
    };
    const task = {
      taskId: "remember",
      nodeId: node.id,
      capability: "memory",
      objective: "Inspect prior context and propose one durable memory.",
    };
    let proposedId = "";
    const adapter = createCodexCliNodeRuntimeAdapter({
      runner: async (execution) => {
        assert.doesNotMatch(execution.stdin, new RegExp(roomSecret));
        const list = await executeClient(execution, ["list"]);
        assert.equal(list.exitCode, 0);
        const listed = JSON.parse(list.stdout) as {
          readonly tools?: ReadonlyArray<{ readonly id: string }>;
        };
        assert.deepEqual(
          listed.tools?.map((tool) => tool.id),
          [ROSTER_CATALOG_SEARCH_FUNCTION_ID, ROSTER_CATALOG_INVOKE_FUNCTION_ID],
        );

        const catalogSearch = await executeClient(
          execution,
          ["call", ROSTER_CATALOG_SEARCH_FUNCTION_ID],
          JSON.stringify({ capabilities: ["memory"], limit: 8 }),
        );
        assert.equal(catalogSearch.exitCode, 0);
        const catalogHandle = responseHandle(catalogSearch.stdout);
        const catalogMaterialized = await executeClient(execution, [
          "materialize",
          catalogHandle,
          "memory-catalog.json",
        ]);
        const catalogPath = (JSON.parse(catalogMaterialized.stdout) as {
          readonly path: string;
        }).path;
        const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
          readonly catalogVersion: string;
          readonly entries: ReadonlyArray<{
            readonly id: string;
            readonly version: string;
            readonly providers: ReadonlyArray<{
              readonly providerId: string;
              readonly epoch: number;
            }>;
          }>;
        };
        const invokeMemory = async (
          functionId: string,
          value: Readonly<Record<string, unknown>>,
        ): Promise<CommandExecutionResult> => {
          const entry = catalog.entries.find((candidate) => candidate.id === functionId);
          const provider = entry?.providers[0];
          assert.ok(entry);
          assert.ok(provider);
          return executeClient(
            execution,
            ["call", ROSTER_CATALOG_INVOKE_FUNCTION_ID],
            JSON.stringify({
              operation: "call",
              catalogVersion: catalog.catalogVersion,
              functionId: entry.id,
              functionVersion: entry.version,
              providerId: provider.providerId,
              providerEpoch: provider.epoch,
              value,
            }),
          );
        };

        const roomSearch = await invokeMemory(ROSTER_MEMORY_SEARCH_FUNCTION_ID, {
          scopeId: "room:current",
          query: "accepted memory",
          limit: 5,
        });
        assert.equal(roomSearch.exitCode, 0);
        assert.doesNotMatch(roomSearch.stdout, new RegExp(roomSecret));
        const roomHandle = responseHandle(roomSearch.stdout);
        const roomMaterialized = await executeClient(execution, [
          "materialize",
          roomHandle,
          "room-search.json",
        ]);
        const roomPath = (JSON.parse(roomMaterialized.stdout) as { readonly path: string }).path;
        const roomResult = await readFile(roomPath, "utf8");
        assert.match(roomResult, new RegExp(roomSecret));
        assert.match(roomResult, /room-frontier-7/u);

        const durableSearch = await invokeMemory(ROSTER_MEMORY_SEARCH_FUNCTION_ID, {
          scopeId: "workspace/project-a",
          query: "provider-neutral",
          limit: 5,
        });
        assert.equal(durableSearch.exitCode, 0);
        const durableHandle = responseHandle(durableSearch.stdout);
        const durableMaterialized = await executeClient(execution, [
          "materialize",
          durableHandle,
          "durable-search.json",
        ]);
        const durablePath = (JSON.parse(durableMaterialized.stdout) as { readonly path: string }).path;
        const durableResult = JSON.parse(await readFile(durablePath, "utf8")) as {
          readonly documents?: ReadonlyArray<{
            readonly documentId: string;
            readonly contentHash: string;
          }>;
        };
        const source = durableResult.documents?.[0];
        assert.ok(source);

        const proposed = await invokeMemory(ROSTER_MEMORY_PROPOSE_FUNCTION_ID, {
          scopeId: "workspace/project-a",
          text: "Use handle-first retrieval for context larger than the active room window.",
          tags: ["architecture", "memory"],
          sourceReferences: [{
            sourceId: source.documentId,
            contentHash: source.contentHash,
            kind: "memory",
          }],
        });
        assert.equal(proposed.exitCode, 0);
        const proposalHandle = responseHandle(proposed.stdout);
        const proposalMaterialized = await executeClient(execution, [
          "materialize",
          proposalHandle,
          "proposal.json",
        ]);
        const proposalPath = (JSON.parse(proposalMaterialized.stdout) as { readonly path: string }).path;
        const proposalResult = JSON.parse(await readFile(proposalPath, "utf8")) as {
          readonly proposalId?: unknown;
          readonly status?: unknown;
        };
        assert.equal(typeof proposalResult.proposalId, "string");
        assert.equal(proposalResult.status, "pending");
        proposedId = proposalResult.proposalId as string;

        const unauthorized = await invokeMemory(ROSTER_MEMORY_SEARCH_FUNCTION_ID, {
          scopeId: "room:other",
          query: "secret",
        });
        assert.notEqual(unauthorized.exitCode, 0);
        assert.match(unauthorized.stderr, /not authorized/u);
        return {
          exitCode: 0,
          stderr: "",
          stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"answer\\":\\"memory reduced\\"}"}}',
        };
      },
    });

    const result = await new NodeRuntimeRegistry([adapter]).execute({
      runId: "memory-plane-run",
      node,
      task,
      input: { currentRoomSummary: "Only the small active-room summary is inline." },
      surface: {
        tools: plane.functionTools(node, task),
        codeMode: { inputMode: "external", maxFunctionCalls: 5 },
      },
      invokeFunction: plane.functionInvoker(node, task),
      resultContract: {
        mode: "json",
        outputKey: "answer",
        schema: { type: "object", required: ["answer"] },
      },
      validateOutput: (candidate) => Boolean(candidate)
        && typeof candidate === "object"
        && "answer" in candidate,
      execute: async () => ({ answer: "native" }),
    });
    assert.deepEqual(result, { answer: "memory reduced" });
    assert.equal((await memory.read({ scope: "workspace/project-a" })).length, 1);
    const proposals = await memory.proposals({
      scope: "workspace/project-a",
      status: "pending",
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.proposalId, proposedId);

    const accepted = await memory.accept({
      scope: "workspace/project-a",
      proposalId: proposedId,
      decidedBy: "roster",
    });
    assert.equal(accepted.acceptedBy, "roster");
    assert.equal((await memory.read({ scope: "workspace/project-a" })).length, 2);
    dispose();
  } finally {
    await rm(memoryDirectory, { recursive: true, force: true });
  }
});

test("RLM memory discovery omits writes when execution access is read-only", async () => {
  const descriptors = createRosterMemoryFunctionDescriptors();
  const directory = new RosterFunctionDirectory(descriptors);
  const repository = createDocumentRosterMemoryRepository({
    scopes: async () => [],
    documents: async () => [],
  });
  const dispose = bindRosterMemoryFunctionProviders({ directory, repository });
  const plane = createRosterFunctionExecutionPlane({
    directory,
    access: () => ({
      functionGrants: descriptors.map((descriptor) => descriptor.id),
      allowedEffects: ["read"],
    }),
  });
  const node: WorkspaceNode = {
    id: "read-only-memory",
    name: "Read-only Memory",
    capabilities: ["memory"],
  };
  const task = { taskId: "read", nodeId: node.id, capability: "memory" };
  assert.deepEqual(
    plane.functionTools(node, task).map((tool) => tool.id),
    [ROSTER_CATALOG_SEARCH_FUNCTION_ID, ROSTER_CATALOG_INVOKE_FUNCTION_ID],
  );
  const search = await plane.functionInvoker(node, task)({
    functionId: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
    value: { capabilities: ["memory"], limit: 8 },
  }, {
    executionId: "read-only-memory-execution",
    runId: "read-only-memory-run",
    nodeId: node.id,
    taskId: task.taskId,
  });
  assert.equal(search.status, "completed");
  if (search.status !== "completed") throw new Error("Expected completed memory catalog search");
  const snapshot = search.output as {
    readonly entries: ReadonlyArray<{ readonly id: string }>;
  };
  assert.ok(snapshot.entries.some((entry) => entry.id === ROSTER_MEMORY_SEARCH_FUNCTION_ID));
  assert.equal(
    snapshot.entries.some((entry) => entry.id === ROSTER_MEMORY_PROPOSE_FUNCTION_ID),
    false,
  );
  dispose();
});
