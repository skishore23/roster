import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import type { DataReference } from "../../src/engine/platform/protocol.ts";
import {
  rosterMemoryDocument,
  type RosterMemoryDocument,
} from "../../src/engine/runtime/node-memory-plane.ts";
import {
  createNodeExecutionSurface,
  NODE_EXECUTION_SCHEMA_VERSION,
  type NodeExecutionEnvelope,
} from "../../src/engine/runtime/node-runtime.ts";
import { normalizeNodeExecutionTrajectory } from "../../src/engine/runtime/node-trajectory.ts";

type RollupBlock = {
  readonly documentId: string;
  readonly tier: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly childDocumentIds: ReadonlyArray<string>;
  readonly reference: DataReference;
};

type RollupIndex = {
  readonly contentHash: string;
  readonly sourceVersion: string;
  readonly recordCount: number;
  readonly maxTier: number;
  readonly recordContentHashes: ReadonlyArray<string>;
  readonly blocks: ReadonlyArray<RollupBlock>;
};

type MemoryRepository = {
  readonly scopes: (control: MemoryControl) => Promise<ReadonlyArray<{
    readonly scopeId: string;
    readonly kind: string;
    readonly snapshotVersion?: string;
    readonly writable?: boolean;
  }>>;
  readonly search: (
    input: { readonly scopeId: string; readonly query: string; readonly limit: number },
    control: MemoryControl,
  ) => Promise<ReadonlyArray<RosterMemoryDocument>>;
  readonly open: (
    input: { readonly scopeId: string; readonly documentIds: ReadonlyArray<string> },
    control: MemoryControl,
  ) => Promise<ReadonlyArray<RosterMemoryDocument>>;
  readonly diff: (
    input: {
      readonly scopeId: string;
      readonly fromTimestamp: number;
      readonly toTimestamp?: number;
      readonly limit: number;
    },
    control: MemoryControl,
  ) => Promise<ReadonlyArray<RosterMemoryDocument>>;
};

type MemoryControl = {
  readonly nodeId: string;
  readonly signal: AbortSignal;
};

type StaircaseEntry = {
  readonly documentId: string;
  readonly kind: "record" | "rollup";
  readonly tier: number;
  readonly startIndex: number;
  readonly endIndex: number;
};

const runtimeSdk = await import("../../src/sdk/runtime.ts");
const buildTrajectoryRollupIndex = Reflect.get(runtimeSdk, "buildTrajectoryRollupIndex") as
  | ((input: Readonly<Record<string, unknown>>) => Promise<RollupIndex>)
  | undefined;
const trajectoryRollupStaircase = Reflect.get(runtimeSdk, "trajectoryRollupStaircase") as
  | ((index: RollupIndex, options: { readonly rawTail: number }) => ReadonlyArray<StaircaseEntry>)
  | undefined;
const createTrajectoryRollupMemoryRepository = Reflect.get(
  runtimeSdk,
  "createTrajectoryRollupMemoryRepository",
) as
  | ((input: Readonly<Record<string, unknown>>) => MemoryRepository)
  | undefined;
const createNodeTrajectoryRollupCollector = Reflect.get(
  runtimeSdk,
  "createNodeTrajectoryRollupCollector",
) as
  | ((input: Readonly<Record<string, unknown>>) => {
      readonly observe: (trajectory: ReturnType<typeof normalizeNodeExecutionTrajectory>) => Promise<void>;
      readonly repository: MemoryRepository;
    })
  | undefined;

const records = (count: number): ReadonlyArray<RosterMemoryDocument> =>
  Array.from({ length: count }, (_, index) => rosterMemoryDocument({
    documentId: `record-${index}`,
    scopeId: "trajectory:workspace-a:node-a",
    kind: "trajectory-record",
    text: `record ${index}`,
    timestamp: 1_000 + index,
    contentHash: `record-hash-${index}`,
    sourceVersion: "trajectory-source-7",
  }));

test("tiered trajectory rollups cover old records exactly and preserve a raw recent tail", async () => {
  assert.equal(typeof buildTrajectoryRollupIndex, "function");
  assert.equal(typeof trajectoryRollupStaircase, "function");

  const dataReferences = new InMemoryDataReferenceStore({ maxEntries: 128 });
  const index = await buildTrajectoryRollupIndex!({
    scopeId: "trajectory:workspace-a:node-a",
    sourceVersion: "trajectory-source-7",
    records: records(20),
    fanout: 2,
    dataReferences,
    summarizer: {
      id: "test-summary",
      version: "1",
      summarize: async (input: {
        readonly tier: number;
        readonly startIndex: number;
        readonly endIndex: number;
        readonly descendantDocumentIds: ReadonlyArray<string>;
      }) => ({
        summary: `tier ${input.tier} records ${input.startIndex}-${input.endIndex}`,
        themes: [`tier-${input.tier}`],
        notableDocumentIds: [
          input.descendantDocumentIds[0],
          input.descendantDocumentIds.at(-1),
        ],
      }),
    },
  });

  assert.equal(index.sourceVersion, "trajectory-source-7");
  assert.equal(index.recordCount, 20);
  assert.equal(index.maxTier, 4);
  assert.equal(index.blocks.length, 18);

  const coarsest = index.blocks.find((block) => block.tier === 4);
  assert.ok(coarsest);
  assert.deepEqual([coarsest.startIndex, coarsest.endIndex], [0, 16]);
  const stored = await dataReferences.read(coarsest.reference) as {
    readonly childDocumentIds?: ReadonlyArray<string>;
  };
  assert.deepEqual(stored.childDocumentIds, coarsest.childDocumentIds);

  const firstTier = index.blocks.find((block) => block.tier === 1 && block.startIndex === 0);
  assert.ok(firstTier);
  const firstTierStored = await dataReferences.read(firstTier.reference) as {
    readonly children?: ReadonlyArray<{
      readonly documentId: string;
      readonly contentHash: string;
      readonly sourceVersion: string;
    }>;
  };
  assert.deepEqual(firstTierStored.children, [
    {
      documentId: "record-0",
      contentHash: "record-hash-0",
      sourceVersion: "trajectory-source-7",
    },
    {
      documentId: "record-1",
      contentHash: "record-hash-1",
      sourceVersion: "trajectory-source-7",
    },
  ]);

  const staircase = trajectoryRollupStaircase!(index, { rawTail: 3 });
  assert.deepEqual(
    staircase.map(({ kind, tier, startIndex, endIndex }) => ({ kind, tier, startIndex, endIndex })),
    [
      { kind: "rollup", tier: 4, startIndex: 0, endIndex: 16 },
      { kind: "record", tier: 0, startIndex: 16, endIndex: 17 },
      { kind: "record", tier: 0, startIndex: 17, endIndex: 18 },
      { kind: "record", tier: 0, startIndex: 18, endIndex: 19 },
      { kind: "record", tier: 0, startIndex: 19, endIndex: 20 },
    ],
  );
});

test("trajectory rollup memory searches coarse summaries and opens exact child references", async () => {
  assert.equal(typeof buildTrajectoryRollupIndex, "function");
  assert.equal(typeof createTrajectoryRollupMemoryRepository, "function");

  const source = records(8).map((record, index) => index === 2
    ? { ...record, text: "authentication regression evidence" }
    : record);
  const dataReferences = new InMemoryDataReferenceStore({ maxEntries: 64 });
  const index = await buildTrajectoryRollupIndex!({
    scopeId: "trajectory:workspace-a:node-a",
    sourceVersion: "trajectory-source-7",
    records: source,
    fanout: 2,
    dataReferences,
    summarizer: {
      id: "test-summary",
      version: "1",
      summarize: async (input: {
        readonly children: ReadonlyArray<{ readonly text: string }>;
        readonly descendantDocumentIds: ReadonlyArray<string>;
      }) => ({
        summary: input.children.map((child) => child.text).join(" "),
        notableDocumentIds: input.descendantDocumentIds,
      }),
    },
  });
  const repository = createTrajectoryRollupMemoryRepository!({
    index,
    records: source,
    dataReferences,
    label: "Node A trajectory",
    description: "Progressive-resolution execution history for Node A.",
  });
  const control = { nodeId: "node-a", signal: new AbortController().signal };

  assert.deepEqual(await repository.scopes(control), [{
    scopeId: "trajectory:workspace-a:node-a",
    kind: "trajectory",
    label: "Node A trajectory",
    description: "Progressive-resolution execution history for Node A.",
    snapshotVersion: index.contentHash,
    writable: false,
  }]);

  const matches = await repository.search({
    scopeId: "trajectory:workspace-a:node-a",
    query: "authentication regression",
    limit: 3,
  }, control);
  assert.equal(matches[0]?.kind, "trajectory-rollup");
  assert.equal((matches[0]?.metadata as { readonly tier?: unknown })?.tier, 3);
  assert.match(matches[0]?.text ?? "", /authentication regression/u);
  assert.ok(matches[0]?.references?.some((reference) => reference.startsWith("data_")));

  const childIds = (matches[0]?.metadata as {
    readonly childDocumentIds?: ReadonlyArray<string>;
  })?.childDocumentIds;
  assert.ok(childIds?.length);
  const children = await repository.open({
    scopeId: "trajectory:workspace-a:node-a",
    documentIds: childIds,
  }, control);
  assert.deepEqual(children.map((document) =>
    (document.metadata as { readonly tier?: unknown }).tier), [2, 2]);

  const raw = await repository.open({
    scopeId: "trajectory:workspace-a:node-a",
    documentIds: ["record-2"],
  }, control);
  assert.equal(raw[0]?.text, "authentication regression evidence");
  assert.equal(raw[0]?.contentHash, "record-hash-2");

  const changed = await repository.diff({
    scopeId: "trajectory:workspace-a:node-a",
    fromTimestamp: 1_002,
    toTimestamp: 1_004,
    limit: 10,
  }, control);
  assert.deepEqual(changed.map((document) => document.documentId), [
    "record-2",
    "record-3",
    "record-4",
  ]);

  await assert.rejects(
    repository.search({ scopeId: "trajectory:other", query: "authentication", limit: 3 }, control),
    /not authorized/u,
  );
});

test("trajectory rollup replay rejects forged indexes, changed raw records, and invented anchors", async () => {
  assert.equal(typeof buildTrajectoryRollupIndex, "function");
  assert.equal(typeof createTrajectoryRollupMemoryRepository, "function");

  const source = records(4);
  const summarize = async (input: {
    readonly tier: number;
    readonly startIndex: number;
    readonly endIndex: number;
    readonly descendantDocumentIds: ReadonlyArray<string>;
  }) => ({
    summary: `tier ${input.tier} records ${input.startIndex}-${input.endIndex}`,
    notableDocumentIds: input.descendantDocumentIds,
  });
  const firstStore = new InMemoryDataReferenceStore({ maxEntries: 16 });
  const first = await buildTrajectoryRollupIndex!({
    scopeId: "trajectory:workspace-a:node-a",
    sourceVersion: "trajectory-source-7",
    records: source,
    fanout: 2,
    dataReferences: firstStore,
    summarizer: { id: "test-summary", version: "1", summarize },
  });
  const second = await buildTrajectoryRollupIndex!({
    scopeId: "trajectory:workspace-a:node-a",
    sourceVersion: "trajectory-source-7",
    records: source,
    fanout: 2,
    dataReferences: new InMemoryDataReferenceStore({ maxEntries: 16 }),
    summarizer: { id: "test-summary", version: "1", summarize },
  });
  assert.equal(second.contentHash, first.contentHash);
  assert.deepEqual(
    second.blocks.map((block) => block.reference.referenceId),
    first.blocks.map((block) => block.reference.referenceId),
  );

  assert.throws(() => createTrajectoryRollupMemoryRepository!({
    index: { ...first, contentHash: "forged-index-frontier" },
    records: source,
    dataReferences: firstStore,
  }), /invalid content hash/u);

  const changedSource = source.map((record, index) => index === 3
    ? { ...record, contentHash: "changed-record-hash" }
    : record);
  assert.throws(() => createTrajectoryRollupMemoryRepository!({
    index: first,
    records: changedSource,
    dataReferences: firstStore,
  }), /content hashes do not match/u);

  await assert.rejects(buildTrajectoryRollupIndex!({
    scopeId: "trajectory:workspace-a:node-a",
    sourceVersion: "trajectory-source-7",
    records: source,
    fanout: 2,
    dataReferences: new InMemoryDataReferenceStore({ maxEntries: 16 }),
    summarizer: {
      id: "untrusted-summary",
      version: "1",
      summarize: async () => ({
        summary: "Invented provenance must not enter the rollup index.",
        notableDocumentIds: ["record-outside-this-block"],
      }),
    },
  }), /not a child anchor/u);
});

test("node trajectory collection exposes only a node's own immutable execution scopes", async () => {
  assert.equal(typeof createNodeTrajectoryRollupCollector, "function");

  const collector = createNodeTrajectoryRollupCollector!({
    dataReferences: new InMemoryDataReferenceStore({ maxEntries: 32 }),
    fanout: 2,
  });
  const trajectoryFor = (nodeId: string, executionId: string) => {
    const sourceGroupId = `session-${nodeId}`;
    const envelope: NodeExecutionEnvelope = {
      schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
      executionId,
      runId: "coding-run-7",
      node: { id: nodeId, name: nodeId, capabilities: ["implement"] },
      runtime: { kind: "codex-cli" },
      task: { taskId: `task-${nodeId}`, nodeId, capability: "implement" },
      surface: createNodeExecutionSurface({}),
    };
    return normalizeNodeExecutionTrajectory({
      envelope,
      source: "codex",
      sourceGroupId,
      transcript: [
        JSON.stringify({
          timestamp: "2026-08-24T12:00:00.000Z",
          type: "session_meta",
          payload: { id: sourceGroupId, cwd: "/workspace", timestamp: "2026-08-24T12:00:00.000Z" },
        }),
        JSON.stringify({
          timestamp: "2026-08-24T12:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Inspect the authentication regression." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-24T12:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The authentication regression is isolated." }],
          },
        }),
      ].join("\n"),
    });
  };

  const nodeA = trajectoryFor(
    "node-a",
    "node_execution_aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const nodeB = trajectoryFor(
    "node-b",
    "node_execution_bbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  await collector.observe(nodeA);
  await collector.observe(nodeA);
  await collector.observe(nodeB);
  await assert.rejects(collector.observe({
    ...nodeA,
    taskId: "task-node-a-changed-without-rehashing",
  }), /content hash does not match/u);

  const controlA = { nodeId: "node-a", signal: new AbortController().signal };
  const controlB = { nodeId: "node-b", signal: new AbortController().signal };
  const scopesA = await collector.repository.scopes(controlA);
  const scopesB = await collector.repository.scopes(controlB);
  assert.equal(scopesA.length, 1);
  assert.equal(scopesB.length, 1);
  assert.match(scopesA[0]?.scopeId ?? "", /node-a/u);
  assert.match(scopesB[0]?.scopeId ?? "", /node-b/u);

  const matches = await collector.repository.search({
    scopeId: scopesA[0]!.scopeId,
    query: "authentication regression",
    limit: 4,
  }, controlA);
  assert.equal(matches[0]?.kind, "trajectory-rollup");
  const childIds = (matches[0]?.metadata as {
    readonly childDocumentIds?: ReadonlyArray<string>;
  }).childDocumentIds;
  assert.ok(childIds?.length);
  const raw = await collector.repository.open({
    scopeId: scopesA[0]!.scopeId,
    documentIds: childIds,
  }, controlA);
  assert.ok(raw.some((document) => document.text.includes("authentication regression")));

  await assert.rejects(collector.repository.search({
    scopeId: scopesA[0]!.scopeId,
    query: "authentication",
    limit: 4,
  }, controlB), /not authorized/u);
});
