import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
import { createRuntime } from "../../src/core/runtime.ts";
import type { Receipt } from "../../src/core/types.ts";
import {
  codingConversationMessageEvent,
  createCodingConversationMessage,
} from "../../src/domains/coding-conversation.ts";
import { createCodingRosterMemoryRepository } from "../../src/domains/coding-memory.ts";
import { inlineArtifactPublishedEvent, type OrchestrationEvent } from "../../src/modules/orchestration.ts";

const receipt = (
  body: OrchestrationEvent,
  id: string,
  ts: number,
  hash = `hash-${id}`,
): Receipt<OrchestrationEvent> => ({
  id,
  ts,
  stream: "test",
  body,
  hash,
});

test("coding memory exposes shared run context and only the current node's private scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coding-memory-"));
  try {
    const runtime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
      memoryStore<MemoryEvent>(),
      memoryBranchStore(),
      decideMemory,
      reduceMemory,
      initialMemoryState,
    );
    const memory = createMemoryTools({ dir, runtime, now: () => 1_000 });
    await memory.commit({
      scope: "workspace:current",
      text: "Previous runs selected a handle-first context boundary.",
    });
    await memory.commit({
      scope: "workspace:other",
      text: "This workspace must not be visible.",
    });
    await memory.commit({
      scope: "node:roster-workspace:reviewer",
      text: "The reviewer remembers the exact certification boundary.",
    });
    await memory.commit({
      scope: "node:roster-workspace:implementer",
      text: "The implementer's private memory must remain hidden.",
    });
    const message = createCodingConversationMessage({
      conversationId: "conversation-1",
      author: { kind: "user", id: "human", name: "Human" },
      source: { kind: "api" },
      text: "Remember the room decision about retrieval provenance.",
      createdAt: 50,
    });
    const conversationReceipts = [
      receipt(codingConversationMessageEvent(message), "conversation-receipt", 50),
    ];
    const artifact = inlineArtifactPublishedEvent({
      runId: "run-1",
      artifactId: "accepted-report",
      origin: "task",
      outputKey: "report",
      taskId: "review",
      nodeId: "reviewer",
      kind: "coding.report",
      inputVersions: { request: "request-hash" },
    }, "Accepted report evidence");
    const runReceipts = [
      receipt({
        type: "task.graph.projected",
        runId: "run-1",
        graph: { tasks: [{ taskId: "review", nodeId: "reviewer", status: "running" }] },
      }, "task-receipt", 60),
      receipt(artifact, "artifact-receipt", 70, artifact.contentHash),
    ];
    const repository = createCodingRosterMemoryRepository({
      memory,
      workspaceScopeId: "workspace:current",
      nodePrivateMemory: {
        workspaceId: "roster-workspace",
        nodeIds: ["reviewer", "implementer"],
      },
      conversationId: "conversation-1",
      runId: "run-1",
      conversationReceipts: async () => conversationReceipts,
      runReceipts: async () => runReceipts,
    });
    const control = {
      nodeId: "reviewer",
      runId: "run-1",
      taskId: "review",
      signal: new AbortController().signal,
    };
    assert.deepEqual(
      (await repository.scopes(control)).map((scope) => scope.scopeId).sort(),
      [
        "artifacts:run-1",
        "node:roster-workspace:reviewer",
        "receipts:run-1",
        "room:conversation-1",
        "workspace:current",
      ],
    );
    const room = await repository.search({
      scopeId: "room:conversation-1",
      query: "retrieval provenance",
      limit: 10,
    }, control);
    assert.equal(room[0]?.documentId, message.messageId);
    assert.equal(room[0]?.timestamp, 50);

    const receipts = await repository.search({
      scopeId: "receipts:run-1",
      query: "task.graph.projected",
      limit: 10,
    }, control);
    assert.equal(receipts[0]?.contentHash, "hash-task-receipt");

    const artifacts = await repository.open({
      scopeId: "artifacts:run-1",
      documentIds: ["accepted-report"],
    }, control);
    assert.equal(artifacts[0]?.text, "Accepted report evidence");
    assert.equal(artifacts[0]?.contentHash, artifact.contentHash);

    const workspace = await repository.search({
      scopeId: "workspace:current",
      query: "handle-first",
      limit: 10,
    }, control);
    assert.equal(workspace.length, 1);
    const privateMemory = await repository.search({
      scopeId: "node:roster-workspace:reviewer",
      query: "certification boundary",
      limit: 10,
    }, control);
    assert.equal(privateMemory.length, 1);
    await assert.rejects(() => repository.search({
      scopeId: "node:roster-workspace:implementer",
      query: "hidden",
      limit: 10,
    }, control), /cannot access private memory owned by implementer/u);
    await assert.rejects(() => repository.search({
      scopeId: "workspace:other",
      query: "visible",
      limit: 10,
    }, control), /not authorized/u);

    const proposed = await repository.propose?.({
      scopeId: "workspace:current",
      text: "Preserve source hashes when reducing room history.",
      sourceReferences: [{
        sourceId: message.messageId,
        contentHash: room[0]!.contentHash,
        kind: "room-message",
      }],
    }, control);
    assert.equal(proposed?.status, "pending");
    assert.equal((await memory.read({ scope: "workspace:current" })).length, 1);
    const accesses = await memory.accesses("run-1");
    assert.equal(accesses.length, 5);
    assert.deepEqual(
      accesses.flatMap((access) => access.documents.map((document) => document.documentId)).sort(),
      [
        "accepted-report",
        privateMemory[0]!.documentId,
        "task-receipt",
        message.messageId,
        workspace[0]!.documentId,
      ].sort(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
