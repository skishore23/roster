// ============================================================================
// Memory Tools - runtime-backed memory tool contracts
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { hashCanonical } from "../core/canonical.js";
import type { Decide, Reducer } from "../core/types.js";
import type { Runtime } from "../core/runtime.js";

export const MEMORY_SCHEMA_VERSION = "roster.memory.v1" as const;
const MEMORY_CATALOG_SCOPE = "__roster_memory_catalog__";
const MAX_SCOPE_BYTES = 240;
const MAX_TEXT_BYTES = 64 * 1_024;
const MAX_TAGS = 32;
const MAX_TAG_BYTES = 160;
const MAX_META_BYTES = 16 * 1_024;
const MAX_SOURCE_REFERENCES = 64;
const MAX_ACCESS_DOCUMENTS = 200;
const MAX_SOURCE_ID_BYTES = 512;
const MAX_PROPOSALS_PER_SCOPE = 1_024;
const MAX_ENTRIES_PER_SCOPE = 10_000;
const MAX_ACCESSES_PER_STREAM = 10_000;

export type MemorySourceReference = {
  readonly sourceId: string;
  readonly contentHash: string;
  readonly kind?: string;
};

export type MemoryEntry = {
  readonly id: string;
  readonly scope: string;
  readonly text: string;
  readonly tags?: ReadonlyArray<string>;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly contentHash?: string;
  readonly proposedBy?: string;
  readonly acceptedBy?: string;
  readonly sourceReferences?: ReadonlyArray<MemorySourceReference>;
  readonly ts: number;
};

export type MemoryProposal = {
  readonly schema: typeof MEMORY_SCHEMA_VERSION;
  readonly proposalId: string;
  readonly scope: string;
  readonly text: string;
  readonly tags?: ReadonlyArray<string>;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly proposedBy: string;
  readonly sourceReferences: ReadonlyArray<MemorySourceReference>;
  readonly contentHash: string;
  readonly ts: number;
};

export type MemoryProposalRecord = MemoryProposal & {
  readonly status: "pending" | "accepted" | "rejected";
  readonly acceptedBy?: string;
  readonly rejectedBy?: string;
  readonly decisionReason?: string;
  readonly decidedAt?: number;
  readonly entryId?: string;
};

export type MemoryAccessRecord = {
  readonly schema: typeof MEMORY_SCHEMA_VERSION;
  readonly accessId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly operation: "search" | "open" | "diff";
  readonly scopeId: string;
  readonly queryHash?: string;
  readonly documents: ReadonlyArray<{
    readonly documentId: string;
    readonly contentHash: string;
    readonly sourceVersion: string;
  }>;
  readonly ts: number;
};

export type MemoryEvent =
  | {
      readonly type: "memory.scope.registered";
      readonly scope: string;
    }
  | {
      readonly type: "memory.committed";
      readonly scope: string;
      readonly entry: MemoryEntry;
    }
  | {
      readonly type: "memory.proposed";
      readonly scope: string;
      readonly proposal: MemoryProposal;
    }
  | {
      readonly type: "memory.accepted";
      readonly scope: string;
      readonly proposalId: string;
      readonly acceptedBy: string;
      readonly acceptedAt: number;
      readonly entry: MemoryEntry;
    }
  | {
      readonly type: "memory.rejected";
      readonly scope: string;
      readonly proposalId: string;
      readonly rejectedBy: string;
      readonly rejectedAt: number;
      readonly reason: string;
    }
  | {
      readonly type: "memory.accessed";
      readonly scope: string;
      readonly access: MemoryAccessRecord;
    };

export type MemoryCmd = {
  readonly type: "emit";
  readonly event: MemoryEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type MemoryState = {
  readonly entries: ReadonlyArray<MemoryEntry>;
  readonly proposals: ReadonlyArray<MemoryProposalRecord>;
  readonly scopes: ReadonlyArray<string>;
  readonly accesses: ReadonlyArray<MemoryAccessRecord>;
};

export const initialMemoryState: MemoryState = {
  entries: [],
  proposals: [],
  scopes: [],
  accesses: [],
};

export const decideMemory: Decide<MemoryCmd, MemoryEvent> = (cmd) => [cmd.event];

export const reduceMemory: Reducer<MemoryState, MemoryEvent> = (state, event) => {
  const entries = state.entries ?? [];
  const proposals = state.proposals ?? [];
  const scopes = state.scopes ?? [];
  const accesses = state.accesses ?? [];
  if (event.type === "memory.scope.registered") {
    return {
      entries,
      proposals,
      scopes: [...new Set([...scopes, event.scope])].sort(),
      accesses,
    };
  }
  if (event.type === "memory.committed") {
    return {
      entries: [event.entry, ...entries.filter((entry) => entry.id !== event.entry.id)]
        .sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id)),
      proposals,
      scopes,
      accesses,
    };
  }
  if (event.type === "memory.proposed") {
    return {
      entries,
      proposals: [
        { ...event.proposal, status: "pending" as const },
        ...proposals.filter((proposal) => proposal.proposalId !== event.proposal.proposalId),
      ].sort((a, b) => b.ts - a.ts || b.proposalId.localeCompare(a.proposalId)),
      scopes,
      accesses,
    };
  }
  if (event.type === "memory.accepted") {
    return {
      entries: [event.entry, ...entries.filter((entry) => entry.id !== event.entry.id)]
        .sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id)),
      proposals: proposals.map((proposal) => proposal.proposalId === event.proposalId
        ? {
            ...proposal,
            status: "accepted" as const,
            acceptedBy: event.acceptedBy,
            decidedAt: event.acceptedAt,
            entryId: event.entry.id,
          }
        : proposal),
      scopes,
      accesses,
    };
  }
  if (event.type === "memory.rejected") {
    return {
      entries,
      proposals: proposals.map((proposal) => proposal.proposalId === event.proposalId
        ? {
            ...proposal,
            status: "rejected" as const,
            rejectedBy: event.rejectedBy,
            decisionReason: event.reason,
            decidedAt: event.rejectedAt,
          }
        : proposal),
      scopes,
      accesses,
    };
  }
  if (event.type === "memory.accessed") {
    return {
      entries,
      proposals,
      scopes,
      accesses: [
        event.access,
        ...accesses.filter((access) => access.accessId !== event.access.accessId),
      ].sort((left, right) => right.ts - left.ts || right.accessId.localeCompare(left.accessId)),
    };
  }
  throw new Error(`unknown memory event: ${(event as { type?: string }).type ?? "unknown"}`);
};

export type MemoryReadInput = {
  readonly scope: string;
  readonly limit?: number;
};

export type MemorySearchInput = {
  readonly scope: string;
  readonly query: string;
  readonly limit?: number;
};

export type MemorySummarizeInput = {
  readonly scope: string;
  readonly query?: string;
  readonly limit?: number;
  readonly maxChars?: number;
};

export type MemoryCommitInput = {
  readonly scope: string;
  readonly text: string;
  readonly tags?: ReadonlyArray<string>;
  readonly meta?: Readonly<Record<string, unknown>>;
};

export type MemoryProposeInput = MemoryCommitInput & {
  readonly proposedBy: string;
  readonly sourceReferences?: ReadonlyArray<MemorySourceReference>;
};

export type MemoryProposalDecisionInput = {
  readonly scope: string;
  readonly proposalId: string;
  readonly decidedBy: string;
  readonly reason?: string;
};

export type MemoryDiffInput = {
  readonly scope: string;
  readonly fromTs: number;
  readonly toTs?: number;
};

export type EmbedFn = (texts: ReadonlyArray<string>) => Promise<ReadonlyArray<ReadonlyArray<number>>>;

export type MemoryTools = {
  readonly read: (input: MemoryReadInput) => Promise<ReadonlyArray<MemoryEntry>>;
  readonly search: (input: MemorySearchInput) => Promise<ReadonlyArray<MemoryEntry>>;
  readonly summarize: (input: MemorySummarizeInput) => Promise<{ summary: string; entries: ReadonlyArray<MemoryEntry> }>;
  readonly commit: (input: MemoryCommitInput) => Promise<MemoryEntry>;
  readonly diff: (input: MemoryDiffInput) => Promise<ReadonlyArray<MemoryEntry>>;
  readonly reindex: (scope: string) => Promise<number>;
};

export type DurableMemoryTools = MemoryTools & {
  readonly scopes: () => Promise<ReadonlyArray<string>>;
  readonly version: (scope: string) => Promise<string>;
  readonly open: (input: {
    readonly scope: string;
    readonly ids: ReadonlyArray<string>;
  }) => Promise<ReadonlyArray<MemoryEntry>>;
  readonly propose: (input: MemoryProposeInput) => Promise<MemoryProposalRecord>;
  readonly proposals: (input: {
    readonly scope: string;
    readonly status?: MemoryProposalRecord["status"];
    readonly limit?: number;
  }) => Promise<ReadonlyArray<MemoryProposalRecord>>;
  readonly accept: (input: MemoryProposalDecisionInput) => Promise<MemoryEntry>;
  readonly reject: (input: MemoryProposalDecisionInput & {
    readonly reason: string;
  }) => Promise<MemoryProposalRecord>;
  readonly recordAccess: (input: Omit<MemoryAccessRecord, "schema" | "accessId" | "ts">) =>
    Promise<MemoryAccessRecord>;
  readonly accesses: (runId: string, limit?: number) => Promise<ReadonlyArray<MemoryAccessRecord>>;
};

type EmbeddingCache = Record<string, ReadonlyArray<number>>;

const safeScope = (scope: string): string =>
  (scope || "default").toLowerCase().replace(/[^a-z0-9_.-/]/g, "_");

const encodedBytes = (value: string): number => Buffer.byteLength(value, "utf8");

const boundedString = (value: string, label: string, maxBytes: number): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be blank`);
  if (encodedBytes(normalized) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return normalized;
};

const normalizedScope = (scope: string): string => {
  const normalized = boundedString(scope, "Memory scope", MAX_SCOPE_BYTES);
  if (normalized === MEMORY_CATALOG_SCOPE) throw new Error("Memory scope is reserved");
  return normalized;
};

const normalizedTags = (tags: ReadonlyArray<string> | undefined): ReadonlyArray<string> | undefined => {
  if (!tags) return undefined;
  if (tags.length > MAX_TAGS) throw new Error(`Memory tags exceed limit ${MAX_TAGS}`);
  const normalized = [...new Set(tags.map((tag) =>
    boundedString(tag, "Memory tag", MAX_TAG_BYTES)))].sort();
  return normalized.length ? normalized : undefined;
};

const normalizedMeta = (
  meta: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined => {
  if (!meta) return undefined;
  const encoded = JSON.stringify(meta);
  if (encoded === undefined) throw new Error("Memory metadata must be JSON serializable");
  if (encodedBytes(encoded) > MAX_META_BYTES) {
    throw new Error(`Memory metadata exceeds ${MAX_META_BYTES} bytes`);
  }
  return JSON.parse(encoded) as Readonly<Record<string, unknown>>;
};

const normalizedSources = (
  sources: ReadonlyArray<MemorySourceReference> | undefined,
): ReadonlyArray<MemorySourceReference> => {
  if (!sources) return [];
  if (sources.length > MAX_SOURCE_REFERENCES) {
    throw new Error(`Memory source references exceed limit ${MAX_SOURCE_REFERENCES}`);
  }
  const normalized = sources.map((source) => ({
    sourceId: boundedString(source.sourceId, "Memory source id", MAX_SOURCE_ID_BYTES),
    contentHash: boundedString(source.contentHash, "Memory source content hash", 256),
    ...(source.kind?.trim()
      ? { kind: boundedString(source.kind, "Memory source kind", 120) }
      : {}),
  }));
  return [...new Map(normalized.map((source) => [
    `${source.kind ?? ""}:${source.sourceId}:${source.contentHash}`,
    source,
  ])).values()].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
    || left.contentHash.localeCompare(right.contentHash));
};

const normalizedContent = (input: MemoryCommitInput): {
  readonly scope: string;
  readonly text: string;
  readonly tags?: ReadonlyArray<string>;
  readonly meta?: Readonly<Record<string, unknown>>;
} => {
  const scope = normalizedScope(input.scope);
  const text = boundedString(input.text, "Memory text", MAX_TEXT_BYTES);
  const tags = normalizedTags(input.tags);
  const meta = normalizedMeta(input.meta);
  return {
    scope,
    text,
    ...(tags ? { tags } : {}),
    ...(meta ? { meta } : {}),
  };
};

const scopeToEmbeddingsFile = (root: string, scope: string): string =>
  path.join(root, `${safeScope(scope).replace(/[\\/]/g, "__")}.embeddings.json`);

const loadEmbeddingCache = async (file: string): Promise<EmbeddingCache> => {
  const exists = await fs.promises.access(file, fs.constants.F_OK).then(() => true).catch(() => false);
  if (!exists) return {};
  const raw = await fs.promises.readFile(file, "utf-8");
  try {
    return JSON.parse(raw) as EmbeddingCache;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid embedding cache ${file}: ${message}`);
  }
};

const saveEmbeddingCache = async (file: string, cache: EmbeddingCache): Promise<void> => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(cache), "utf-8");
};

const cosine = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
};

const ensureEmbeddings = async (
  entries: ReadonlyArray<MemoryEntry>,
  cache: EmbeddingCache,
  embedFn: EmbedFn
): Promise<EmbeddingCache> => {
  const missing = entries.filter((entry) => !(entry.id in cache));
  if (missing.length === 0) return cache;
  const vectors = await embedFn(missing.map((entry) => entry.text));
  const updated = { ...cache };
  for (let idx = 0; idx < missing.length; idx += 1) {
    updated[missing[idx].id] = vectors[idx];
  }
  return updated;
};

const summarizeText = (entries: ReadonlyArray<MemoryEntry>, maxChars: number): string => {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => {
    const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
    return `- ${entry.text}${tags}`;
  });
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  if (maxChars <= 3) return joined.slice(0, maxChars);
  return `${joined.slice(0, maxChars - 3)}...`;
};

const hasQuery = (entry: MemoryEntry, queryTerms: ReadonlyArray<string>): boolean => {
  if (queryTerms.length === 0) return true;
  const haystack = `${entry.text} ${entry.tags?.join(" ") ?? ""}`.toLowerCase();
  return queryTerms.every((term) => haystack.includes(term));
};

export type MemoryToolsDeps = {
  readonly dir: string;
  readonly runtime: Runtime<MemoryCmd, MemoryEvent, MemoryState>;
  readonly streamForScope?: (scope: string) => string;
  readonly embed?: EmbedFn;
  readonly now?: () => number;
};

export const createMemoryTools = (deps: MemoryToolsDeps): DurableMemoryTools => {
  const root = path.join(deps.dir, "memory");
  const embedFn = deps.embed;
  const now = deps.now ?? Date.now;
  const streamForScope = deps.streamForScope ?? ((scope: string) => `memory/${safeScope(scope)}`);

  const readEntries = async (scope: string): Promise<ReadonlyArray<MemoryEntry>> =>
    (await deps.runtime.state(streamForScope(scope))).entries;

  const registerScope = async (scope: string): Promise<void> => {
    await deps.runtime.execute(streamForScope(MEMORY_CATALOG_SCOPE), {
      type: "emit",
      eventId: `memory_scope_${hashCanonical(scope).slice(0, 28)}`,
      event: { type: "memory.scope.registered", scope },
    });
  };

  const semanticSearch = async (scope: string, query: string, limit: number): Promise<ReadonlyArray<MemoryEntry>> => {
    if (!embedFn) throw new Error("semantic search requires embed dependency");
    const entries = await readEntries(scope);
    if (entries.length === 0) return [];
    const embFile = scopeToEmbeddingsFile(root, scope);
    const cache = await loadEmbeddingCache(embFile);
    const updated = await ensureEmbeddings(entries, cache, embedFn);
    if (updated !== cache) await saveEmbeddingCache(embFile, updated);
    const [queryVec] = await embedFn([query]);
    return entries
      .filter((entry) => entry.id in updated)
      .map((entry) => ({ entry, score: cosine(queryVec, updated[entry.id]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.entry);
  };

  const keywordSearch = async (scope: string, query: string, limit: number): Promise<ReadonlyArray<MemoryEntry>> => {
    const terms = query.toLowerCase().split(/\s+/).map((part) => part.trim()).filter(Boolean);
    return (await readEntries(scope)).filter((entry) => hasQuery(entry, terms)).slice(0, limit);
  };

  return {
    read: async (input) => {
      const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
      return (await readEntries(input.scope)).slice(0, limit);
    },

    search: async (input) => {
      const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
      return embedFn
        ? semanticSearch(input.scope, input.query, limit)
        : keywordSearch(input.scope, input.query, limit);
    },

    summarize: async (input) => {
      const maxChars = Math.max(100, Math.min(input.maxChars ?? 2_400, 12_000));
      const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
      const entries = input.query
        ? await (embedFn
          ? semanticSearch(input.scope, input.query, limit)
          : keywordSearch(input.scope, input.query, limit))
        : (await readEntries(input.scope)).slice(0, limit);
      return {
        summary: summarizeText(entries, maxChars),
        entries,
      };
    },

    commit: async (input) => {
      const content = normalizedContent(input);
      await registerScope(content.scope);
      const current = await deps.runtime.state(streamForScope(content.scope));
      if ((current.entries ?? []).length >= MAX_ENTRIES_PER_SCOPE) {
        throw new Error(`Memory entry limit ${MAX_ENTRIES_PER_SCOPE} reached for scope ${content.scope}`);
      }
      const contentHash = hashCanonical(content);
      const entry: MemoryEntry = {
        id: `mem_${now().toString(36)}_${randomUUID().slice(0, 6)}`,
        ...content,
        contentHash,
        ts: now(),
      };
      await deps.runtime.execute(streamForScope(content.scope), {
        type: "emit",
        eventId: `memory_commit_${entry.id}`,
        event: {
          type: "memory.committed",
          scope: content.scope,
          entry,
        },
      });

      if (embedFn) {
        const embFile = scopeToEmbeddingsFile(root, content.scope);
        const cache = await loadEmbeddingCache(embFile);
        const [vector] = await embedFn([content.text]);
        await saveEmbeddingCache(embFile, { ...cache, [entry.id]: vector });
      }

      return entry;
    },

    diff: async (input) => {
      const toTs = input.toTs ?? now();
      return (await readEntries(input.scope))
        .filter((entry) => entry.ts >= input.fromTs && entry.ts <= toTs);
    },

    reindex: async (scope) => {
      if (!embedFn) throw new Error("reindex requires embed dependency");
      const entries = await readEntries(scope);
      if (entries.length === 0) return 0;
      const vectors = await embedFn(entries.map((entry) => entry.text));
      const cache: EmbeddingCache = {};
      for (let idx = 0; idx < entries.length; idx += 1) {
        cache[entries[idx].id] = vectors[idx];
      }
      await saveEmbeddingCache(scopeToEmbeddingsFile(root, scope), cache);
      return entries.length;
    },

    scopes: async () =>
      (await deps.runtime.state(streamForScope(MEMORY_CATALOG_SCOPE))).scopes ?? [],

    version: async (scope) => {
      const state = await deps.runtime.state(streamForScope(normalizedScope(scope)));
      return hashCanonical({
        entries: (state.entries ?? []).map((entry) => ({
          id: entry.id,
          contentHash: entry.contentHash ?? hashCanonical({
            scope: entry.scope,
            text: entry.text,
            tags: entry.tags ?? [],
            meta: entry.meta ?? null,
          }),
        })),
        proposals: (state.proposals ?? []).map((proposal) => ({
          proposalId: proposal.proposalId,
          contentHash: proposal.contentHash,
          status: proposal.status,
          decidedAt: proposal.decidedAt ?? null,
        })),
      });
    },

    open: async (input) => {
      const ids = new Set(input.ids.slice(0, 200));
      return (await readEntries(normalizedScope(input.scope)))
        .filter((entry) => ids.has(entry.id));
    },

    propose: async (input) => {
      const content = normalizedContent(input);
      const proposedBy = boundedString(input.proposedBy, "Memory proposal author", 240);
      const sourceReferences = normalizedSources(input.sourceReferences);
      const proposalContent = {
        schema: MEMORY_SCHEMA_VERSION,
        ...content,
        proposedBy,
        sourceReferences,
      };
      const contentHash = hashCanonical(proposalContent);
      const proposal: MemoryProposal = {
        ...proposalContent,
        proposalId: `memory_proposal_${contentHash.slice(0, 28)}`,
        contentHash,
        ts: now(),
      };
      await registerScope(content.scope);
      const current = await deps.runtime.state(streamForScope(content.scope));
      const existing = current.proposals?.find((candidate) =>
        candidate.proposalId === proposal.proposalId);
      if (existing) return existing;
      const pending = (current.proposals ?? []).filter((candidate) => candidate.status === "pending");
      if (pending.length >= MAX_PROPOSALS_PER_SCOPE) {
        throw new Error(`Memory proposal limit ${MAX_PROPOSALS_PER_SCOPE} reached for scope ${content.scope}`);
      }
      await deps.runtime.execute(streamForScope(content.scope), {
        type: "emit",
        eventId: `memory_proposed_${proposal.proposalId}`,
        event: { type: "memory.proposed", scope: content.scope, proposal },
      });
      return {
        ...proposal,
        status: "pending",
      };
    },

    proposals: async (input) => {
      const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
      return ((await deps.runtime.state(streamForScope(normalizedScope(input.scope)))).proposals ?? [])
        .filter((proposal) => !input.status || proposal.status === input.status)
        .slice(0, limit);
    },

    accept: async (input) => {
      const scope = normalizedScope(input.scope);
      const decidedBy = boundedString(input.decidedBy, "Memory proposal acceptor", 240);
      const state = await deps.runtime.state(streamForScope(scope));
      const proposal = (state.proposals ?? []).find((candidate) =>
        candidate.proposalId === input.proposalId);
      if (!proposal) throw new Error(`Unknown memory proposal ${input.proposalId}`);
      if (proposal.status === "rejected") throw new Error(`Memory proposal ${input.proposalId} was rejected`);
      if (proposal.status === "accepted") {
        const existing = state.entries.find((entry) => entry.id === proposal.entryId);
        if (!existing) throw new Error(`Accepted memory proposal ${input.proposalId} has no entry`);
        return existing;
      }
      if ((state.entries ?? []).length >= MAX_ENTRIES_PER_SCOPE) {
        throw new Error(`Memory entry limit ${MAX_ENTRIES_PER_SCOPE} reached for scope ${scope}`);
      }
      const acceptedAt = now();
      const entry: MemoryEntry = {
        id: `mem_${proposal.contentHash.slice(0, 28)}`,
        scope,
        text: proposal.text,
        ...(proposal.tags ? { tags: proposal.tags } : {}),
        ...(proposal.meta ? { meta: proposal.meta } : {}),
        contentHash: proposal.contentHash,
        proposedBy: proposal.proposedBy,
        acceptedBy: decidedBy,
        sourceReferences: proposal.sourceReferences,
        ts: acceptedAt,
      };
      await deps.runtime.execute(streamForScope(scope), {
        type: "emit",
        eventId: `memory_accepted_${proposal.proposalId}`,
        event: {
          type: "memory.accepted",
          scope,
          proposalId: proposal.proposalId,
          acceptedBy: decidedBy,
          acceptedAt,
          entry,
        },
      });
      if (embedFn) {
        const embFile = scopeToEmbeddingsFile(root, scope);
        const cache = await loadEmbeddingCache(embFile);
        const [vector] = await embedFn([entry.text]);
        await saveEmbeddingCache(embFile, { ...cache, [entry.id]: vector });
      }
      return entry;
    },

    reject: async (input) => {
      const scope = normalizedScope(input.scope);
      const rejectedBy = boundedString(input.decidedBy, "Memory proposal rejector", 240);
      const reason = boundedString(input.reason, "Memory proposal rejection reason", 2_000);
      const state = await deps.runtime.state(streamForScope(scope));
      const proposal = (state.proposals ?? []).find((candidate) =>
        candidate.proposalId === input.proposalId);
      if (!proposal) throw new Error(`Unknown memory proposal ${input.proposalId}`);
      if (proposal.status === "accepted") throw new Error(`Memory proposal ${input.proposalId} was accepted`);
      if (proposal.status === "rejected") return proposal;
      const rejectedAt = now();
      await deps.runtime.execute(streamForScope(scope), {
        type: "emit",
        eventId: `memory_rejected_${proposal.proposalId}`,
        event: {
          type: "memory.rejected",
          scope,
          proposalId: proposal.proposalId,
          rejectedBy,
          rejectedAt,
          reason,
        },
      });
      return {
        ...proposal,
        status: "rejected",
        rejectedBy,
        decisionReason: reason,
        decidedAt: rejectedAt,
      };
    },

    recordAccess: async (input) => {
      const runId = boundedString(input.runId, "Memory access run id", 240);
      const taskId = boundedString(input.taskId, "Memory access task id", 240);
      const nodeId = boundedString(input.nodeId, "Memory access node id", 240);
      const scopeId = boundedString(input.scopeId, "Memory access scope id", MAX_SCOPE_BYTES);
      if (input.documents.length > MAX_ACCESS_DOCUMENTS) {
        throw new Error(`Memory access documents exceed limit ${MAX_ACCESS_DOCUMENTS}`);
      }
      const documents = input.documents.map((document) => ({
        documentId: boundedString(document.documentId, "Memory access document id", MAX_SOURCE_ID_BYTES),
        contentHash: boundedString(document.contentHash, "Memory access content hash", 256),
        sourceVersion: boundedString(document.sourceVersion, "Memory access source version", 256),
      }));
      const content = {
        schema: MEMORY_SCHEMA_VERSION,
        runId,
        taskId,
        nodeId,
        operation: input.operation,
        scopeId,
        ...(input.queryHash ? {
          queryHash: boundedString(input.queryHash, "Memory access query hash", 256),
        } : {}),
        documents,
      };
      const access: MemoryAccessRecord = {
        ...content,
        accessId: `memory_access_${hashCanonical(content).slice(0, 28)}`,
        ts: now(),
      };
      const streamScope = `__roster_memory_access__/${runId}`;
      const state = await deps.runtime.state(streamForScope(streamScope));
      const existing = (state.accesses ?? []).find((candidate) =>
        candidate.accessId === access.accessId);
      if (existing) return existing;
      if ((state.accesses ?? []).length >= MAX_ACCESSES_PER_STREAM) {
        throw new Error(`Memory access limit ${MAX_ACCESSES_PER_STREAM} reached for run ${runId}`);
      }
      await deps.runtime.execute(streamForScope(streamScope), {
        type: "emit",
        eventId: `memory_accessed_${access.accessId}`,
        event: { type: "memory.accessed", scope: scopeId, access },
      });
      return access;
    },

    accesses: async (runId, limit = 500) => {
      const boundedRunId = boundedString(runId, "Memory access run id", 240);
      const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
      return ((await deps.runtime.state(
        streamForScope(`__roster_memory_access__/${boundedRunId}`),
      )).accesses ?? []).slice(0, boundedLimit);
    },
  };
};
