import { hashCanonical } from "../../core/canonical.js";
import type { DataReferenceStore } from "../dataflow/data-reference-store.js";
import type { JsonValue } from "../orchestration/types.js";
import type { DataReference } from "../platform/protocol.js";
import type {
  RosterMemoryDocument,
  RosterMemoryRepository,
  RosterMemoryRepositoryControl,
} from "./node-memory-plane.js";

export const TRAJECTORY_ROLLUP_SCHEMA_VERSION = "roster.trajectory-rollup.v1" as const;
export const TRAJECTORY_ROLLUP_INDEX_SCHEMA_VERSION = "roster.trajectory-rollup-index.v1" as const;

const DEFAULT_FANOUT = 10;
const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_MAX_BLOCKS = 2_048;
const MAX_FANOUT = 32;
const MAX_SUMMARY_BYTES = 16 * 1_024;
const MAX_CHILD_TEXT_BYTES = 64 * 1_024;
const MAX_SUMMARIZER_INPUT_BYTES = 512 * 1_024;
const MAX_THEMES = 16;
const MAX_NOTABLE_DOCUMENTS = 32;

export type TrajectoryRollupSummaryChild = {
  readonly documentId: string;
  readonly kind: "record" | "rollup";
  readonly tier: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly text: string;
  readonly contentHash: string;
  readonly sourceVersion: string;
  readonly notableDocumentIds: ReadonlyArray<string>;
};

export type TrajectoryRollupSummarizerInput = {
  readonly schemaVersion: typeof TRAJECTORY_ROLLUP_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly sourceVersion: string;
  readonly tier: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly children: ReadonlyArray<TrajectoryRollupSummaryChild>;
  /** Bounded raw-document anchors inherited from the direct children. */
  readonly descendantDocumentIds: ReadonlyArray<string>;
};

export type TrajectoryRollupSummary = {
  readonly summary: string;
  readonly themes?: ReadonlyArray<string>;
  readonly notableDocumentIds?: ReadonlyArray<string>;
};

export type TrajectoryRollupSummarizer = {
  readonly id: string;
  readonly version: string;
  readonly summarize: (
    input: TrajectoryRollupSummarizerInput,
  ) => Promise<TrajectoryRollupSummary>;
};

export type TrajectoryRollupBlock = {
  readonly documentId: string;
  readonly tier: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly summary: string;
  readonly themes: ReadonlyArray<string>;
  readonly notableDocumentIds: ReadonlyArray<string>;
  readonly childDocumentIds: ReadonlyArray<string>;
  readonly contentHash: string;
  readonly reference: DataReference;
};

export type TrajectoryRollupIndex = {
  readonly schemaVersion: typeof TRAJECTORY_ROLLUP_INDEX_SCHEMA_VERSION;
  readonly contentHash: string;
  readonly scopeId: string;
  readonly sourceVersion: string;
  readonly summarizerId: string;
  readonly summarizerVersion: string;
  readonly dataReferenceDurability: DataReferenceStore["durability"];
  readonly fanout: number;
  readonly recordCount: number;
  readonly maxTier: number;
  readonly recordDocumentIds: ReadonlyArray<string>;
  readonly recordContentHashes: ReadonlyArray<string>;
  readonly blocks: ReadonlyArray<TrajectoryRollupBlock>;
};

export type TrajectoryRollupStaircaseEntry = {
  readonly documentId: string;
  readonly kind: "record" | "rollup";
  readonly tier: number;
  readonly startIndex: number;
  readonly endIndex: number;
};

type BuildTrajectoryRollupIndexInput = {
  readonly scopeId: string;
  readonly sourceVersion: string;
  readonly records: ReadonlyArray<RosterMemoryDocument>;
  readonly dataReferences: DataReferenceStore;
  readonly summarizer: TrajectoryRollupSummarizer;
  readonly fanout?: number;
  readonly limits?: {
    readonly maxRecords?: number;
    readonly maxBlocks?: number;
  };
  readonly signal?: AbortSignal;
};

type InternalBlock = TrajectoryRollupBlock & {
  readonly sourceVersion: string;
};

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
};

const boundedText = (value: string, label: string, maximumBytes: number): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be blank`);
  if (Buffer.byteLength(normalized) > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  return normalized;
};

const assertActive = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Trajectory rollup construction was aborted");
};

const predictedBlockCount = (recordCount: number, fanout: number): number => {
  let count = Math.floor(recordCount / fanout);
  let total = 0;
  while (count > 0) {
    total += count;
    count = Math.floor(count / fanout);
  }
  return total;
};

const normalizedRecords = (
  records: ReadonlyArray<RosterMemoryDocument>,
  scopeId: string,
  sourceVersion: string,
  maxRecords: number,
): ReadonlyArray<RosterMemoryDocument> => {
  if (records.length > maxRecords) {
    throw new Error(`Trajectory rollup exceeds maxRecords=${maxRecords}`);
  }
  const ids = new Set<string>();
  return Object.freeze(records.map((record, index) => {
    if (record.scopeId !== scopeId) {
      throw new Error(`Trajectory record ${record.documentId} is outside scope ${scopeId}`);
    }
    const documentId = boundedText(record.documentId, `Trajectory record ${index} id`, 512);
    if (ids.has(documentId)) throw new Error(`Trajectory record id ${documentId} is duplicated`);
    ids.add(documentId);
    boundedText(record.kind, `Trajectory record ${documentId} kind`, 120);
    boundedText(record.text, `Trajectory record ${documentId} text`, MAX_CHILD_TEXT_BYTES);
    boundedText(record.contentHash, `Trajectory record ${documentId} contentHash`, 256);
    if (record.sourceVersion !== sourceVersion) {
      throw new Error(`Trajectory record ${documentId} does not match sourceVersion ${sourceVersion}`);
    }
    return Object.freeze({
      ...record,
      ...(record.metadata ? { metadata: JSON.parse(JSON.stringify(record.metadata)) as JsonValue } : {}),
      ...(record.references ? { references: Object.freeze([...record.references]) } : {}),
    });
  }));
};

const summaryChild = (
  child: RosterMemoryDocument | InternalBlock,
  startIndex: number,
  endIndex: number,
): TrajectoryRollupSummaryChild => "documentId" in child && "tier" in child
  ? Object.freeze({
      documentId: child.documentId,
      kind: "rollup" as const,
      tier: child.tier,
      startIndex: child.startIndex,
      endIndex: child.endIndex,
      text: child.summary,
      contentHash: child.contentHash,
      sourceVersion: child.sourceVersion,
      notableDocumentIds: Object.freeze([...child.notableDocumentIds]),
    })
  : Object.freeze({
      documentId: child.documentId,
      kind: "record" as const,
      tier: 0,
      startIndex,
      endIndex,
      text: child.text,
      contentHash: child.contentHash,
      sourceVersion: child.sourceVersion,
      notableDocumentIds: Object.freeze([child.documentId]),
    });

const normalizeSummary = (
  value: TrajectoryRollupSummary,
  candidates: ReadonlyArray<string>,
): Required<TrajectoryRollupSummary> => {
  const summary = boundedText(value.summary, "Trajectory rollup summary", MAX_SUMMARY_BYTES);
  const themes = [...new Set((value.themes ?? []).map((theme) =>
    boundedText(theme, "Trajectory rollup theme", 160)))];
  if (themes.length > MAX_THEMES) {
    throw new Error(`Trajectory rollup exceeds maxThemes=${MAX_THEMES}`);
  }
  const notableDocumentIds = [...new Set(value.notableDocumentIds ?? candidates.slice(0, 1))];
  if (notableDocumentIds.length === 0 || notableDocumentIds.length > MAX_NOTABLE_DOCUMENTS) {
    throw new Error(`Trajectory rollup notable documents must contain between 1 and ${MAX_NOTABLE_DOCUMENTS} ids`);
  }
  const allowed = new Set(candidates);
  for (const documentId of notableDocumentIds) {
    if (typeof documentId !== "string" || !allowed.has(documentId)) {
      throw new Error(`Trajectory rollup notable document ${String(documentId)} is not a child anchor`);
    }
  }
  return {
    summary,
    themes: Object.freeze(themes),
    notableDocumentIds: Object.freeze(notableDocumentIds),
  };
};

const blockPayload = (input: {
  readonly scopeId: string;
  readonly sourceVersion: string;
  readonly summarizerId: string;
  readonly summarizerVersion: string;
  readonly tier: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly childDocumentIds: ReadonlyArray<string>;
  readonly children: ReadonlyArray<Pick<
    TrajectoryRollupSummaryChild,
    "documentId" | "contentHash" | "sourceVersion"
  >>;
  readonly summary: string;
  readonly themes: ReadonlyArray<string>;
  readonly notableDocumentIds: ReadonlyArray<string>;
}): Readonly<Record<string, JsonValue>> => Object.freeze({
  schemaVersion: TRAJECTORY_ROLLUP_SCHEMA_VERSION,
  scopeId: input.scopeId,
  sourceVersion: input.sourceVersion,
  summarizer: Object.freeze({ id: input.summarizerId, version: input.summarizerVersion }),
  tier: input.tier,
  range: Object.freeze({ startIndex: input.startIndex, endIndex: input.endIndex }),
  childDocumentIds: Object.freeze([...input.childDocumentIds]),
  children: Object.freeze(input.children.map((child) => Object.freeze({
    documentId: child.documentId,
    contentHash: child.contentHash,
    sourceVersion: child.sourceVersion,
  }))),
  summary: input.summary,
  themes: Object.freeze([...input.themes]),
  notableDocumentIds: Object.freeze([...input.notableDocumentIds]),
});

/**
 * Builds immutable summary blocks over one already-ordered trajectory
 * snapshot. The summaries are an observational index; raw documents remain
 * authoritative and Roster does not derive scheduling or acceptance from it.
 */
export const buildTrajectoryRollupIndex = async (
  input: BuildTrajectoryRollupIndexInput,
): Promise<TrajectoryRollupIndex> => {
  const scopeId = boundedText(input.scopeId, "Trajectory rollup scopeId", 512);
  const sourceVersion = boundedText(input.sourceVersion, "Trajectory rollup sourceVersion", 256);
  const summarizerId = boundedText(input.summarizer.id, "Trajectory rollup summarizer id", 240);
  const summarizerVersion = boundedText(input.summarizer.version, "Trajectory rollup summarizer version", 120);
  const fanout = boundedInteger(input.fanout, DEFAULT_FANOUT, 2, MAX_FANOUT, "Trajectory rollup fanout");
  const maxRecords = boundedInteger(
    input.limits?.maxRecords,
    DEFAULT_MAX_RECORDS,
    1,
    1_000_000,
    "Trajectory rollup maxRecords",
  );
  const maxBlocks = boundedInteger(
    input.limits?.maxBlocks,
    DEFAULT_MAX_BLOCKS,
    1,
    100_000,
    "Trajectory rollup maxBlocks",
  );
  const records = normalizedRecords(input.records, scopeId, sourceVersion, maxRecords);
  const predicted = predictedBlockCount(records.length, fanout);
  if (predicted > maxBlocks) {
    throw new Error(`Trajectory rollup requires ${predicted} blocks and exceeds maxBlocks=${maxBlocks}`);
  }

  const blocks: InternalBlock[] = [];
  let tier = 1;
  let previous: ReadonlyArray<RosterMemoryDocument | InternalBlock> = records;
  while (previous.length >= fanout) {
    const current: InternalBlock[] = [];
    const completeGroups = Math.floor(previous.length / fanout);
    for (let group = 0; group < completeGroups; group += 1) {
      assertActive(input.signal);
      const children = previous.slice(group * fanout, (group + 1) * fanout);
      const startIndex = tier === 1
        ? group * fanout
        : (children[0] as InternalBlock).startIndex;
      const endIndex = tier === 1
        ? (group + 1) * fanout
        : (children.at(-1) as InternalBlock).endIndex;
      const projectedChildren = children.map((child, childIndex) =>
        summaryChild(
          child,
          startIndex + childIndex,
          startIndex + childIndex + 1,
        ));
      const descendantDocumentIds = [...new Set(projectedChildren.flatMap((child) =>
        child.notableDocumentIds))].slice(0, MAX_NOTABLE_DOCUMENTS);
      const request: TrajectoryRollupSummarizerInput = Object.freeze({
        schemaVersion: TRAJECTORY_ROLLUP_SCHEMA_VERSION,
        scopeId,
        sourceVersion,
        tier,
        startIndex,
        endIndex,
        children: Object.freeze(projectedChildren),
        descendantDocumentIds: Object.freeze(descendantDocumentIds),
      });
      if (Buffer.byteLength(JSON.stringify(request)) > MAX_SUMMARIZER_INPUT_BYTES) {
        throw new Error(`Trajectory rollup summarizer input exceeds ${MAX_SUMMARIZER_INPUT_BYTES} bytes`);
      }
      const summary = normalizeSummary(await input.summarizer.summarize(request), descendantDocumentIds);
      assertActive(input.signal);
      const childDocumentIds = projectedChildren.map((child) => child.documentId);
      const payload = blockPayload({
        scopeId,
        sourceVersion,
        summarizerId,
        summarizerVersion,
        tier,
        startIndex,
        endIndex,
        childDocumentIds,
        children: projectedChildren,
        ...summary,
      });
      const documentId = `trajectory_rollup_${hashCanonical(payload).slice(0, 32)}`;
      const body = Object.freeze({ documentId, ...payload });
      const reference = await input.dataReferences.put({
        value: body,
        mediaType: "application/vnd.roster.trajectory-rollup+json",
        metadata: {
          schemaVersion: TRAJECTORY_ROLLUP_SCHEMA_VERSION,
          scopeId,
          sourceVersion,
          tier,
          startIndex,
          endIndex,
          summarizerId,
          summarizerVersion,
        },
      }, { signal: input.signal });
      const block: InternalBlock = Object.freeze({
        documentId,
        tier,
        startIndex,
        endIndex,
        summary: summary.summary,
        themes: summary.themes,
        notableDocumentIds: summary.notableDocumentIds,
        childDocumentIds: Object.freeze(childDocumentIds),
        contentHash: reference.contentHash,
        reference: Object.freeze({ ...reference }),
        sourceVersion,
      });
      current.push(block);
      blocks.push(block);
    }
    previous = Object.freeze(current);
    tier += 1;
  }

  const maxTier = blocks.reduce((maximum, block) => Math.max(maximum, block.tier), 0);
  const content = {
    schemaVersion: TRAJECTORY_ROLLUP_INDEX_SCHEMA_VERSION,
    scopeId,
    sourceVersion,
    summarizerId,
    summarizerVersion,
    dataReferenceDurability: input.dataReferences.durability,
    fanout,
    recordCount: records.length,
    maxTier,
    recordDocumentIds: records.map((record) => record.documentId),
    recordContentHashes: records.map((record) => record.contentHash),
    blocks: blocks.map(({ sourceVersion: _sourceVersion, ...block }) => block),
  };
  return Object.freeze({
    ...content,
    recordDocumentIds: Object.freeze(content.recordDocumentIds),
    recordContentHashes: Object.freeze(content.recordContentHashes),
    blocks: Object.freeze(content.blocks),
    contentHash: hashCanonical(content),
  });
};

/**
 * Selects an exact, non-overlapping view over the full trajectory. Older
 * ranges use the coarsest available immutable block; the requested tail and
 * any unsealed frontier gaps remain raw.
 */
export const trajectoryRollupStaircase = (
  index: TrajectoryRollupIndex,
  options: { readonly rawTail: number },
): ReadonlyArray<TrajectoryRollupStaircaseEntry> => {
  const rawTail = boundedInteger(
    options.rawTail,
    0,
    0,
    index.recordCount,
    "Trajectory rollup rawTail",
  );
  if (index.recordDocumentIds.length !== index.recordCount) {
    throw new Error("Trajectory rollup index record identities do not match recordCount");
  }
  if (index.recordContentHashes.length !== index.recordCount) {
    throw new Error("Trajectory rollup index record hashes do not match recordCount");
  }
  const tailStart = Math.max(0, index.recordCount - rawTail);
  const blocksByStart = new Map<number, TrajectoryRollupBlock[]>();
  for (const block of index.blocks) {
    const values = blocksByStart.get(block.startIndex) ?? [];
    values.push(block);
    blocksByStart.set(block.startIndex, values);
  }
  for (const values of blocksByStart.values()) {
    values.sort((left, right) => right.tier - left.tier || right.endIndex - left.endIndex);
  }
  const selected: TrajectoryRollupStaircaseEntry[] = [];
  let cursor = 0;
  while (cursor < index.recordCount) {
    const block = cursor < tailStart
      ? blocksByStart.get(cursor)?.find((candidate) => candidate.endIndex <= tailStart)
      : undefined;
    if (block) {
      selected.push(Object.freeze({
        documentId: block.documentId,
        kind: "rollup",
        tier: block.tier,
        startIndex: block.startIndex,
        endIndex: block.endIndex,
      }));
      cursor = block.endIndex;
      continue;
    }
    selected.push(Object.freeze({
      documentId: index.recordDocumentIds[cursor]!,
      kind: "record",
      tier: 0,
      startIndex: cursor,
      endIndex: cursor + 1,
    }));
    cursor += 1;
  }
  return Object.freeze(selected);
};

type CreateTrajectoryRollupMemoryRepositoryInput = {
  readonly index: TrajectoryRollupIndex;
  readonly records: ReadonlyArray<RosterMemoryDocument>;
  readonly dataReferences: DataReferenceStore;
  readonly label?: string;
  readonly description?: string;
};

const recordCopy = (record: RosterMemoryDocument): RosterMemoryDocument => Object.freeze({
  ...record,
  ...(record.metadata ? { metadata: JSON.parse(JSON.stringify(record.metadata)) as JsonValue } : {}),
  ...(record.references ? { references: Object.freeze([...record.references]) } : {}),
});

const recordTerms = (document: Pick<RosterMemoryDocument, "text" | "metadata">): string =>
  `${document.text} ${JSON.stringify(document.metadata ?? null)}`.toLowerCase();

const assertRepositoryScope = (
  selected: string,
  index: TrajectoryRollupIndex,
  control: RosterMemoryRepositoryControl,
): void => {
  assertActive(control.signal);
  if (selected !== index.scopeId) {
    throw new Error(`Memory scope ${selected} is not authorized for this execution`);
  }
};

const blockDocumentMetadata = (
  index: TrajectoryRollupIndex,
  block: TrajectoryRollupBlock,
): Readonly<Record<string, JsonValue>> => Object.freeze({
  schemaVersion: TRAJECTORY_ROLLUP_SCHEMA_VERSION,
  tier: block.tier,
  startIndex: block.startIndex,
  endIndex: block.endIndex,
  sourceVersion: index.sourceVersion,
  summarizerId: index.summarizerId,
  summarizerVersion: index.summarizerVersion,
  dataReferenceId: block.reference.referenceId,
  dataReferenceDurability: index.dataReferenceDurability,
  childDocumentIds: Object.freeze([...block.childDocumentIds]),
  notableDocumentIds: Object.freeze([...block.notableDocumentIds]),
  themes: Object.freeze([...block.themes]),
});

const asObject = (value: JsonValue, label: string): Readonly<Record<string, JsonValue>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value as Readonly<Record<string, JsonValue>>;
};

/**
 * Exposes one completed rollup snapshot through the provider-neutral memory
 * plane. It is read-only: the index may guide retrieval but cannot admit
 * memories, task outcomes, topology, or any other authoritative state.
 */
export const createTrajectoryRollupMemoryRepository = (
  input: CreateTrajectoryRollupMemoryRepositoryInput,
): RosterMemoryRepository => {
  if (input.index.schemaVersion !== TRAJECTORY_ROLLUP_INDEX_SCHEMA_VERSION) {
    throw new Error("Unsupported trajectory rollup index schema version");
  }
  const expectedIndexContent = {
    schemaVersion: input.index.schemaVersion,
    scopeId: input.index.scopeId,
    sourceVersion: input.index.sourceVersion,
    summarizerId: input.index.summarizerId,
    summarizerVersion: input.index.summarizerVersion,
    dataReferenceDurability: input.index.dataReferenceDurability,
    fanout: input.index.fanout,
    recordCount: input.index.recordCount,
    maxTier: input.index.maxTier,
    recordDocumentIds: input.index.recordDocumentIds,
    recordContentHashes: input.index.recordContentHashes,
    blocks: input.index.blocks,
  };
  if (hashCanonical(expectedIndexContent) !== input.index.contentHash) {
    throw new Error("Trajectory rollup index has an invalid content hash");
  }
  if (input.index.recordDocumentIds.length !== input.index.recordCount
    || input.index.recordContentHashes.length !== input.index.recordCount) {
    throw new Error("Trajectory rollup index record frontier is incomplete");
  }
  const actualMaxTier = input.index.blocks.reduce(
    (maximum, block) => Math.max(maximum, block.tier),
    0,
  );
  if (actualMaxTier !== input.index.maxTier) {
    throw new Error("Trajectory rollup index maxTier does not match its blocks");
  }
  const label = boundedText(input.label ?? input.index.scopeId, "Trajectory rollup scope label", 240);
  const description = boundedText(
    input.description ?? `Progressive-resolution trajectory history in ${input.index.scopeId}.`,
    "Trajectory rollup scope description",
    2_000,
  );
  const records = normalizedRecords(
    input.records,
    input.index.scopeId,
    input.index.sourceVersion,
    input.index.recordCount,
  );
  if (records.length !== input.index.recordCount
    || hashCanonical(records.map((record) => record.documentId))
      !== hashCanonical(input.index.recordDocumentIds)) {
    throw new Error("Trajectory rollup records do not match the indexed snapshot");
  }
  if (hashCanonical(records.map((record) => record.contentHash))
    !== hashCanonical(input.index.recordContentHashes)) {
    throw new Error("Trajectory rollup record content hashes do not match the indexed snapshot");
  }
  const recordsById = new Map(records.map((record) => [record.documentId, record]));
  const blocksById = new Map<string, TrajectoryRollupBlock>();
  for (const block of input.index.blocks) {
    if (blocksById.has(block.documentId)) {
      throw new Error(`Trajectory rollup block ${block.documentId} is duplicated`);
    }
    if (block.startIndex < 0
      || block.endIndex <= block.startIndex
      || block.endIndex > input.index.recordCount
      || block.tier < 1) {
      throw new Error(`Trajectory rollup block ${block.documentId} has an invalid range or tier`);
    }
    blocksById.set(block.documentId, block);
  }

  const readBlock = async (
    block: TrajectoryRollupBlock,
    control: RosterMemoryRepositoryControl,
  ): Promise<RosterMemoryDocument> => {
    const stored = asObject(
      await input.dataReferences.read(block.reference, { signal: control.signal }),
      `Trajectory rollup block ${block.documentId}`,
    );
    const range = asObject(stored.range as JsonValue, `Trajectory rollup block ${block.documentId} range`);
    const exact = {
      documentId: stored.documentId,
      schemaVersion: stored.schemaVersion,
      scopeId: stored.scopeId,
      sourceVersion: stored.sourceVersion,
      tier: stored.tier,
      startIndex: range.startIndex,
      endIndex: range.endIndex,
      childDocumentIds: stored.childDocumentIds,
      summary: stored.summary,
      themes: stored.themes,
      notableDocumentIds: stored.notableDocumentIds,
    };
    const expected = {
      documentId: block.documentId,
      schemaVersion: TRAJECTORY_ROLLUP_SCHEMA_VERSION,
      scopeId: input.index.scopeId,
      sourceVersion: input.index.sourceVersion,
      tier: block.tier,
      startIndex: block.startIndex,
      endIndex: block.endIndex,
      childDocumentIds: block.childDocumentIds,
      summary: block.summary,
      themes: block.themes,
      notableDocumentIds: block.notableDocumentIds,
    };
    if (hashCanonical(exact) !== hashCanonical(expected)) {
      throw new Error(`Trajectory rollup block ${block.documentId} changed from its index`);
    }
    const lastTimestamp = records[block.endIndex - 1]?.timestamp;
    return Object.freeze({
      documentId: block.documentId,
      scopeId: input.index.scopeId,
      kind: "trajectory-rollup",
      text: block.summary,
      contentHash: block.contentHash,
      sourceVersion: input.index.contentHash,
      ...(lastTimestamp !== undefined ? { timestamp: lastTimestamp } : {}),
      metadata: blockDocumentMetadata(input.index, block),
      references: Object.freeze([block.reference.referenceId, ...block.childDocumentIds]),
    });
  };

  return {
    scopes: async (control) => {
      assertActive(control.signal);
      return Object.freeze([Object.freeze({
        scopeId: input.index.scopeId,
        kind: "trajectory" as const,
        label,
        description,
        snapshotVersion: input.index.contentHash,
        writable: false,
      })]);
    },
    search: async ({ scopeId, query, limit }, control) => {
      assertRepositoryScope(scopeId, input.index, control);
      const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
      if (terms.length === 0) throw new Error("Trajectory memory search query must not be blank");
      const selected: RosterMemoryDocument[] = [];
      const matchingBlocks = [...input.index.blocks]
        .filter((block) => terms.every((term) => recordTerms({
          text: block.summary,
          metadata: blockDocumentMetadata(input.index, block),
        }).includes(term)))
        .sort((left, right) =>
          right.tier - left.tier
          || left.startIndex - right.startIndex
          || left.documentId.localeCompare(right.documentId));
      for (const block of matchingBlocks) {
        if (selected.length >= limit) break;
        selected.push(await readBlock(block, control));
      }
      for (const record of records) {
        if (selected.length >= limit) break;
        if (terms.every((term) => recordTerms(record).includes(term))) {
          selected.push(recordCopy(record));
        }
      }
      return Object.freeze(selected);
    },
    open: async ({ scopeId, documentIds }, control) => {
      assertRepositoryScope(scopeId, input.index, control);
      const opened: RosterMemoryDocument[] = [];
      for (const documentId of [...new Set(documentIds)]) {
        const block = blocksById.get(documentId);
        if (block) {
          opened.push(await readBlock(block, control));
          continue;
        }
        const record = recordsById.get(documentId);
        if (record) opened.push(recordCopy(record));
      }
      return Object.freeze(opened);
    },
    diff: async ({ scopeId, fromTimestamp, toTimestamp, limit }, control) => {
      assertRepositoryScope(scopeId, input.index, control);
      return Object.freeze(records
        .filter((record) => record.timestamp !== undefined
          && record.timestamp >= fromTimestamp
          && record.timestamp <= (toTimestamp ?? Number.MAX_SAFE_INTEGER))
        .sort((left, right) =>
          (left.timestamp ?? 0) - (right.timestamp ?? 0)
          || left.documentId.localeCompare(right.documentId))
        .slice(0, limit)
        .map(recordCopy));
    },
  };
};
