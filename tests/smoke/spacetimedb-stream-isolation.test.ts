import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  logicalStreamId,
  scopedStreamKey,
} from "../../spacetimedb/src/stream-identity.js";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const section = (source: string, start: string, end: string): string => {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing ${start}`);
  assert.notEqual(endAt, -1, `missing ${end}`);
  return source.slice(startAt, endAt);
};

test("Roster v2 logical stream names always resolve to isolated physical keys", () => {
  const logical = "agents/theorem";
  const workspaceA = "roster/acme";
  const workspaceB = "roster/other";
  const physicalA = scopedStreamKey(workspaceA, logical);
  const physicalB = scopedStreamKey(workspaceB, logical);

  assert.notEqual(physicalA, physicalB, "the same logical name must not share a module primary key");
  assert.equal(logicalStreamId(workspaceA, physicalA), logical);
  assert.equal(logicalStreamId(workspaceB, physicalB), logical);
  assert.throws(
    () => logicalStreamId(workspaceA, logical),
    /Roster v2 stream key does not belong to its workspace/,
    "raw pre-v2 stream keys must fail closed",
  );
});

test("stream reducers use physical IDs while caller-scoped views expose logical IDs", async () => {
  const moduleSource = await fs.readFile(path.join(ROOT, "spacetimedb/src/index.ts"), "utf8");
  const append = section(
    moduleSource,
    "export const appendStreamReceipt",
    "export const enqueueRosterJob"
  );
  assert.match(append, /const storageId = streamStorageKey\(ctx, workspaceId, streamId\)/);
  assert.match(append, /eventStream\.id\.find\(storageId\)/);
  assert.match(append, /streamReceiptKey\(storageId, receiptId\)/);
  assert.match(append, /streamId: storageId/);
  assert.doesNotMatch(append, /eventStream\.id\.find\(streamId\)/);

  const streamsView = section(moduleSource, "export const myEventStreams", "export const myStreamReceipts");
  assert.match(streamsView, /id: stream\.id/);
  assert.match(streamsView, /streamId: logicalStreamId\(stream\.workspaceId, stream\.id\)/);
  assert.match(streamsView, /logicalStreamId\(stream\.workspaceId, stream\.parentStreamId\)/);

  const receiptsView = section(moduleSource, "export const myStreamReceipts", "export const myStreamBranches");
  assert.match(receiptsView, /streamId: logicalStreamId\(receipt\.workspaceId, receipt\.streamId\)/);

  const branchesView = section(moduleSource, "export const myStreamBranches", "export const myRosterJobs");
  assert.match(branchesView, /id: stream\.id/);
  assert.match(branchesView, /streamId: logicalStreamId\(stream\.workspaceId, stream\.id\)/);
  assert.match(branchesView, /parentStreamId: logicalStreamId\(stream\.workspaceId, stream\.parentStreamId\)/);

  const privateLookups = [...moduleSource.matchAll(/ctx\.db\.eventStream\.id\.find\(([^)]+)\)/g)]
    .map((match) => match[1]?.trim());
  assert.ok(privateLookups.length >= 4, "canonical stream reducers must retain physical-key lookups");
  assert.equal(privateLookups[0], "parentStorageId");
  assert.ok(
    privateLookups.slice(1).every((lookup) => lookup === "storageId"),
    "every reducer lookup must use a v2 physical key",
  );
});
