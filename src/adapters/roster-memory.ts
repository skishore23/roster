import { hashCanonical } from "../core/canonical.js";
import type { JsonValue } from "../engine/orchestration/types.js";
import {
  type RosterMemoryDocument,
  type RosterMemoryRepository,
  rosterMemoryDocument,
} from "../engine/runtime/node-memory-plane.js";
import type {
  DurableMemoryTools,
  MemoryEntry,
} from "./memory-tools.js";

const memoryDocument = (entry: MemoryEntry): RosterMemoryDocument =>
  rosterMemoryDocument({
    documentId: entry.id,
    scopeId: entry.scope,
    kind: "memory-entry",
    text: entry.text,
    timestamp: entry.ts,
    metadata: {
      ...(entry.tags?.length ? { tags: [...entry.tags] } : {}),
      ...(entry.meta ? { meta: JSON.parse(JSON.stringify(entry.meta)) as JsonValue } : {}),
      ...(entry.proposedBy ? { proposedBy: entry.proposedBy } : {}),
      ...(entry.acceptedBy ? { acceptedBy: entry.acceptedBy } : {}),
    },
    references: entry.sourceReferences?.map((reference) => reference.sourceId),
    contentHash: entry.contentHash ?? hashCanonical({
      scope: entry.scope,
      text: entry.text,
      tags: entry.tags ?? [],
      meta: entry.meta ?? null,
    }),
    sourceVersion: entry.contentHash ?? entry.id,
  });

/** Adapts the receipted memory store to the provider-neutral RLM memory plane. */
export const createDurableRosterMemoryRepository = (
  memory: DurableMemoryTools,
  options: {
    readonly scopeIds?: ReadonlyArray<string>;
  } = {},
): RosterMemoryRepository => {
  const configuredScopes = options.scopeIds
    ? new Set(options.scopeIds.map((scope) => scope.trim()).filter(Boolean))
    : undefined;
  const assertScope = (scopeId: string): void => {
    if (configuredScopes && !configuredScopes.has(scopeId)) {
      throw new Error(`Memory scope ${scopeId} is not authorized for this execution`);
    }
  };
  return {
  scopes: async () => {
    const scopes = [...new Set([
      ...(await memory.scopes()),
      ...(configuredScopes ?? []),
    ])].filter((scopeId) => !configuredScopes || configuredScopes.has(scopeId));
    return Promise.all(scopes.map(async (scopeId) => {
    return {
      scopeId,
      kind: "memory" as const,
      label: scopeId,
      description: `Accepted durable memory in ${scopeId}.`,
      snapshotVersion: await memory.version(scopeId),
      writable: true,
    };
    }));
  },
  search: async ({ scopeId, query, limit }) => {
    assertScope(scopeId);
    return (await memory.search({ scope: scopeId, query, limit })).map(memoryDocument);
  },
  open: async ({ scopeId, documentIds }) => {
    assertScope(scopeId);
    return (await memory.open({ scope: scopeId, ids: documentIds })).map(memoryDocument);
  },
  diff: async ({ scopeId, fromTimestamp, toTimestamp, limit }) => {
    assertScope(scopeId);
    return (await memory.diff({
      scope: scopeId,
      fromTs: fromTimestamp,
      ...(toTimestamp !== undefined ? { toTs: toTimestamp } : {}),
    })).slice(0, limit).map(memoryDocument);
  },
  propose: async (input, control) => {
    assertScope(input.scopeId);
    const proposal = await memory.propose({
      scope: input.scopeId,
      text: input.text,
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.metadata ? { meta: input.metadata } : {}),
      proposedBy: control.nodeId,
      ...(input.sourceReferences?.length
        ? { sourceReferences: input.sourceReferences }
        : {}),
    });
    return {
      proposalId: proposal.proposalId,
      scopeId: proposal.scope,
      contentHash: proposal.contentHash,
      status: "pending",
      proposedBy: proposal.proposedBy,
    };
  },
};
};
