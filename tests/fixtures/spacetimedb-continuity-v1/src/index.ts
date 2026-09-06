import { schema, table, t } from "spacetimedb/server";

// This fixture is the last persisted continuity shape before room lanes were
// introduced. Keep its column order frozen: the verification harness publishes
// it, inserts rows, and upgrades the same database with the current module.
const rosterNodeInboxItem = table(
  { name: "roster_node_inbox_item" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    nodeId: t.string().index("btree"),
    deliveryId: t.string(),
    seq: t.u64(),
    cause: t.string(),
    sourceId: t.string(),
    sourceVersion: t.string(),
    sourceHash: t.string(),
    payloadReference: t.string(),
    causalParentId: t.string(),
    causalDepth: t.u32(),
    status: t.string().index("btree"),
    wakeId: t.string(),
    itemJson: t.string(),
    deliveredAtMs: t.u64(),
    consumedAt: t.option(t.timestamp()),
    createdAt: t.timestamp(),
  },
);

const rosterNodeWake = table(
  { name: "roster_node_wake" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    nodeId: t.string().index("btree"),
    requestId: t.string(),
    status: t.string().index("btree"),
    inboxDeliveryIdsJson: t.string(),
    manifestJson: t.string(),
    jobId: t.string(),
    requestedAtMs: t.u64(),
    notBeforeMs: t.u64(),
    admittedAtMs: t.u64(),
    completedAtMs: t.u64(),
    resultJson: t.string(),
    lastError: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  },
);

const spacetimedb = schema({ rosterNodeInboxItem, rosterNodeWake });
export default spacetimedb;

export const seedContinuityUpgrade = spacetimedb.reducer((ctx) => {
  ctx.db.rosterNodeInboxItem.insert({
    id: "migration-inbox",
    workspaceId: "migration/customer",
    nodeId: "workspace.implementation",
    deliveryId: "migration-delivery",
    seq: 1n,
    cause: "direct",
    sourceId: "migration-message",
    sourceVersion: "1",
    sourceHash: "migration-source-hash",
    payloadReference: "artifact:migration-message",
    causalParentId: "",
    causalDepth: 0,
    status: "consumed",
    wakeId: "migration-wake",
    itemJson: "{}",
    deliveredAtMs: 1_000n,
    consumedAt: ctx.timestamp,
    createdAt: ctx.timestamp,
  });
  ctx.db.rosterNodeWake.insert({
    id: "migration-wake",
    workspaceId: "migration/customer",
    nodeId: "workspace.implementation",
    requestId: "migration-request",
    status: "completed",
    inboxDeliveryIdsJson: "[\"migration-delivery\"]",
    manifestJson: "{}",
    jobId: "migration-job",
    requestedAtMs: 1_000n,
    notBeforeMs: 1_000n,
    admittedAtMs: 1_100n,
    completedAtMs: 1_200n,
    resultJson: "{}",
    lastError: "",
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
});
