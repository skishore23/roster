import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SpacetimeControlPlane } from "../../src/adapters/spacetimedb-control.js";
import { SpacetimeEventRepository } from "../../src/adapters/spacetimedb-runtime.js";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const timestamp = (microsSinceUnixEpoch: bigint) => ({ microsSinceUnixEpoch });
const table = <Row>(rows: ReadonlyArray<Row>) => ({ iter: () => rows.values() });

test("one service cache isolates same-named streams for two workspace repositories", async () => {
  const workspaceA = "roster/acme";
  const workspaceB = "roster/other";
  const sharedStream = "agents/theorem";
  const branchStream = "agents/theorem/branches/review";
  const workspaces = [
    { id: workspaceA, name: "Acme", role: "owner", createdAt: timestamp(1n), updatedAt: timestamp(1n) },
    { id: workspaceB, name: "Other", role: "owner", createdAt: timestamp(2n), updatedAt: timestamp(2n) },
  ];
  const streams = [
    {
      id: "physical-a-root", workspaceId: workspaceA, streamId: sharedStream, kind: "agent",
      headHash: "a2", receiptCount: 2n, parentStreamId: "", forkAt: 0,
      createdAt: timestamp(1n), updatedAt: timestamp(4n),
    },
    {
      id: "physical-b-root", workspaceId: workspaceB, streamId: sharedStream, kind: "agent",
      headHash: "b1", receiptCount: 1n, parentStreamId: "", forkAt: 0,
      createdAt: timestamp(2n), updatedAt: timestamp(3n),
    },
    {
      id: "physical-a-branch", workspaceId: workspaceA, streamId: branchStream, kind: "branch",
      headHash: "", receiptCount: 0n, parentStreamId: sharedStream, forkAt: 1,
      createdAt: timestamp(5n), updatedAt: timestamp(5n),
    },
    {
      id: "physical-b-branch", workspaceId: workspaceB, streamId: branchStream, kind: "branch",
      headHash: "", receiptCount: 0n, parentStreamId: sharedStream, forkAt: 1,
      createdAt: timestamp(6n), updatedAt: timestamp(6n),
    },
  ];
  const receipts = [
    {
      id: "a-2", workspaceId: workspaceA, streamId: sharedStream, seq: 2n, receiptId: "a-2",
      occurredAtMs: 2n, prevHash: "a1", hash: "a2",
      bodyJson: JSON.stringify({ type: "task.graph.projected", tenant: "a", position: 2 }), hintsJson: "{}",
      createdAt: timestamp(4n),
    },
    {
      id: "b-1", workspaceId: workspaceB, streamId: sharedStream, seq: 1n, receiptId: "b-1",
      occurredAtMs: 1n, prevHash: "", hash: "b1",
      bodyJson: JSON.stringify({ type: "task.graph.projected", tenant: "b" }), hintsJson: "{}",
      createdAt: timestamp(3n),
    },
    {
      id: "a-1", workspaceId: workspaceA, streamId: sharedStream, seq: 1n, receiptId: "a-1",
      occurredAtMs: 1n, prevHash: "", hash: "a1",
      bodyJson: JSON.stringify({ type: "task.graph.projected", tenant: "a", position: 1 }), hintsJson: "{}",
      createdAt: timestamp(3n),
    },
  ];
  const branches = [
    {
      id: "physical-a-branch", workspaceId: workspaceA, streamId: branchStream,
      parentStreamId: sharedStream, forkAt: 1, createdAtMs: 1n,
    },
    {
      id: "physical-b-branch", workspaceId: workspaceB, streamId: branchStream,
      parentStreamId: sharedStream, forkAt: 1, createdAtMs: 2n,
    },
  ];

  const control = Object.create(SpacetimeControlPlane.prototype) as SpacetimeControlPlane;
  const subscribed: Array<readonly [string, string]> = [];
  const immediateSubscription = () => ({ ready: Promise.resolve(), close: () => undefined });
  Object.defineProperties(control, {
    connection: {
      value: {
        db: {
          myWorkspaces: table(workspaces),
          myWorkspaceUsage: table([]),
          myEventStreams: table(streams),
          myStreamReceipts: table(receipts),
          myStreamBranches: table(branches),
          myCodingRooms: table([]),
          myRosterParticipantProfiles: table([]),
        },
      },
    },
    ensureWorkspace: { value: async () => undefined },
    subscribeEventStreams: { value: () => immediateSubscription() },
    subscribeStreamReceipts: {
      value: (workspaceId: string, streamId: string) => {
        subscribed.push([workspaceId, streamId]);
        return immediateSubscription();
      },
    },
  });

  const snapshotA = control.workspaceSnapshot(workspaceA);
  assert.deepEqual(snapshotA.workspaces.map((row) => row.id), [workspaceA]);
  assert.deepEqual(snapshotA.usage, []);
  assert.equal(snapshotA.streams.every((row) => row.workspaceId === workspaceA), true);
  assert.equal(snapshotA.receipts.every((row) => row.workspaceId === workspaceA), true);
  assert.equal(snapshotA.branches.every((row) => row.workspaceId === workspaceA), true);
  assert.deepEqual(snapshotA.codingRooms, []);
  assert.deepEqual(snapshotA.participantProfiles, []);
  assert.deepEqual(
    control.streamReceipts(workspaceA, sharedStream).map((row) => row.id),
    ["a-1", "a-2"],
    "logical stream equality must not admit another workspace's cached row"
  );
  assert.deepEqual(control.streamReceipts(workspaceB, sharedStream).map((row) => row.id), ["b-1"]);

  const repositoryA = new SpacetimeEventRepository(control, workspaceA, "Acme");
  const repositoryB = new SpacetimeEventRepository(control, workspaceB, "Other");
  assert.equal(repositoryA.streamMetadata(sharedStream)?.workspaceId, workspaceA);
  assert.equal(repositoryB.streamMetadata(sharedStream)?.workspaceId, workspaceB);
  assert.equal(repositoryA.branches().length, 2);
  assert.equal(repositoryB.branches().length, 2);

  const [chainA, chainB] = await Promise.all([
    repositoryA.read<{ readonly tenant: string }>(sharedStream),
    repositoryB.read<{ readonly tenant: string }>(sharedStream),
  ]);
  assert.deepEqual(chainA.map((receipt) => receipt.id), ["a-1", "a-2"]);
  assert.deepEqual(chainB.map((receipt) => receipt.id), ["b-1"]);
  assert.equal(chainA.every((receipt) => receipt.body.tenant === "a"), true);
  assert.equal(chainB.every((receipt) => receipt.body.tenant === "b"), true);
  assert.deepEqual(subscribed, [
    [workspaceA, sharedStream],
    [workspaceB, sharedStream],
  ]);

  repositoryA.close();
  repositoryB.close();
});

test("receipt subscriptions constrain both workspace and logical stream", async () => {
  const source = await fs.readFile(path.join(ROOT, "src/adapters/spacetimedb-control.ts"), "utf8");
  const catalogStart = source.indexOf("subscribeEventStreams(");
  const singleStart = source.indexOf("subscribeStreamReceipts(");
  const snapshotStart = source.indexOf("workspaceSnapshot(");
  assert.ok(catalogStart >= 0 && singleStart > catalogStart && snapshotStart > singleStart);

  const catalog = source.slice(catalogStart, singleStart);
  const single = source.slice(singleStart, snapshotStart);
  assert.match(catalog, /my_stream_receipts WHERE workspace_id = \$\{workspaceLiteral\} AND stream_id =/);
  assert.match(single, /my_stream_receipts WHERE workspace_id = \$\{literal\(workspaceId\)\} AND stream_id = \$\{literal\(streamId\)\}/);
});
