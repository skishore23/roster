import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("memory tools: commit/read/search/summarize/diff", async () => {
  const dir = await mkTmp("receipt-memory");
  try {
    const runtime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
      memoryStore<MemoryEvent>(),
      memoryBranchStore(),
      decideMemory,
      reduceMemory,
      initialMemoryState
    );
    const tools = createMemoryTools({ dir, runtime });
    const first = await tools.commit({
      scope: "theorem.run.demo",
      text: "Need stronger induction hypothesis.",
      tags: ["proof", "gap"],
    });
    await tools.commit({
      scope: "theorem.run.demo",
      text: "Verifier flagged missing base case.",
      tags: ["verifier"],
    });

    const read = await tools.read({ scope: "theorem.run.demo", limit: 10 });
    assert.equal(read.length, 2);

    const search = await tools.search({
      scope: "theorem.run.demo",
      query: "base case",
      limit: 5,
    });
    assert.equal(search.length, 1);
    assert.match(search[0]?.text ?? "", /base case/i);

    const summary = await tools.summarize({
      scope: "theorem.run.demo",
      query: "proof",
      limit: 5,
      maxChars: 500,
    });
    assert.match(summary.summary, /induction/i);

    const diff = await tools.diff({
      scope: "theorem.run.demo",
      fromTs: first.ts,
      toTs: Date.now(),
    });
    assert.equal(diff.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("memory proposals are content-addressed, bounded, and require an explicit decision", async () => {
  const dir = await mkTmp("receipt-memory-proposals");
  let now = 1_000;
  try {
    const runtime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
      memoryStore<MemoryEvent>(),
      memoryBranchStore(),
      decideMemory,
      reduceMemory,
      initialMemoryState,
    );
    const tools = createMemoryTools({ dir, runtime, now: () => now++ });
    const proposal = await tools.propose({
      scope: "workspace/project-a",
      text: "The API contract uses content-addressed memory handles.",
      tags: ["architecture", "api"],
      proposedBy: "reviewer",
      sourceReferences: [{
        sourceId: "room-message-17",
        contentHash: "sha256-room-message-17",
        kind: "room",
      }],
    });
    const duplicate = await tools.propose({
      scope: "workspace/project-a",
      text: "The API contract uses content-addressed memory handles.",
      tags: ["api", "architecture"],
      proposedBy: "reviewer",
      sourceReferences: [{
        sourceId: "room-message-17",
        contentHash: "sha256-room-message-17",
        kind: "room",
      }],
    });
    assert.equal(duplicate.proposalId, proposal.proposalId);
    assert.equal((await tools.read({ scope: "workspace/project-a" })).length, 0);
    assert.deepEqual(await tools.scopes(), ["workspace/project-a"]);
    assert.equal((await tools.proposals({
      scope: "workspace/project-a",
      status: "pending",
    })).length, 1);

    const accepted = await tools.accept({
      scope: "workspace/project-a",
      proposalId: proposal.proposalId,
      decidedBy: "roster",
    });
    assert.equal(accepted.proposedBy, "reviewer");
    assert.equal(accepted.acceptedBy, "roster");
    assert.deepEqual(accepted.sourceReferences, [{
      sourceId: "room-message-17",
      contentHash: "sha256-room-message-17",
      kind: "room",
    }]);
    assert.deepEqual(await tools.open({
      scope: "workspace/project-a",
      ids: [accepted.id],
    }), [accepted]);
    assert.equal((await tools.proposals({
      scope: "workspace/project-a",
      status: "accepted",
    }))[0]?.entryId, accepted.id);

    const rejectedProposal = await tools.propose({
      scope: "workspace/project-a",
      text: "Unverified speculation should not become durable memory.",
      proposedBy: "reviewer",
    });
    const rejected = await tools.reject({
      scope: "workspace/project-a",
      proposalId: rejectedProposal.proposalId,
      decidedBy: "roster",
      reason: "Missing evidence.",
    });
    assert.equal(rejected.status, "rejected");
    await assert.rejects(() => tools.accept({
      scope: "workspace/project-a",
      proposalId: rejected.proposalId,
      decidedBy: "roster",
    }), /was rejected/u);

    await assert.rejects(() => tools.propose({
      scope: "workspace/project-a",
      text: "x".repeat(70 * 1_024),
      proposedBy: "reviewer",
    }), /Memory text exceeds/u);

    const access = await tools.recordAccess({
      runId: "run-1",
      taskId: "task-1",
      nodeId: "reviewer",
      operation: "search",
      scopeId: "workspace/project-a",
      queryHash: "query-hash",
      documents: [{
        documentId: accepted.id,
        contentHash: accepted.contentHash!,
        sourceVersion: await tools.version("workspace/project-a"),
      }],
    });
    const duplicateAccess = await tools.recordAccess({
      runId: "run-1",
      taskId: "task-1",
      nodeId: "reviewer",
      operation: "search",
      scopeId: "workspace/project-a",
      queryHash: "query-hash",
      documents: access.documents,
    });
    assert.equal(duplicateAccess.accessId, access.accessId);
    assert.deepEqual(await tools.accesses("run-1"), [access]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
