import { canonicalize, hashCanonical } from "../../core/canonical.js";
import {
  createSharedArtifactUpdate,
  SharedArtifactLedger,
  type ArtifactConflict,
  type ArtifactProjection,
  type SharedArtifactUpdate,
} from "../artifact/shared-crdt.js";
import type { JsonValue, WorkspaceNode } from "../orchestration/types.js";

export type WorkspaceEntryKind =
  | "message"
  | "finding"
  | "evidence"
  | "decision"
  | "task-proposal"
  | "topology-proposal"
  | "artifact-reference";

export type WorkspaceEntryMode = "append" | "exclusive";

const WORKSPACE_ENTRY_KINDS = new Set<WorkspaceEntryKind>([
  "message",
  "finding",
  "evidence",
  "decision",
  "task-proposal",
  "topology-proposal",
  "artifact-reference",
]);
const WORKSPACE_ENTRY_MODES = new Set<WorkspaceEntryMode>(["append", "exclusive"]);

export type WorkspaceEntry = {
  readonly entryId: string;
  readonly kind: WorkspaceEntryKind;
  readonly mode: WorkspaceEntryMode;
  readonly subjectId: string;
  readonly nodeId: string;
  readonly bodyHash: string;
  readonly body: JsonValue;
  readonly references: ReadonlyArray<string>;
};

export type WorkspaceEntryInput = Omit<WorkspaceEntry, "entryId" | "bodyHash">;

export type SharedWorkspaceValue = {
  readonly entries: ReadonlyArray<WorkspaceEntry>;
  readonly bySubject: Readonly<Record<string, ReadonlyArray<string>>>;
};

export type SharedWorkspaceLimits = {
  readonly maxIdentifierBytes: number;
  readonly maxSubjectBytes: number;
  readonly maxReferences: number;
  readonly maxReferenceBytes: number;
  readonly maxBodyBytes: number;
  readonly maxInputVersions: number;
  readonly maxInputVersionKeyBytes: number;
  readonly maxInputVersionValueBytes: number;
  readonly maxUpdateBytes: number;
  readonly maxEncodedStateBytes: number;
  readonly maxEntries: number;
};

export const DEFAULT_SHARED_WORKSPACE_LIMITS: SharedWorkspaceLimits = Object.freeze({
  maxIdentifierBytes: 256,
  maxSubjectBytes: 512,
  maxReferences: 64,
  maxReferenceBytes: 2_048,
  maxBodyBytes: 64 * 1_024,
  maxInputVersions: 64,
  maxInputVersionKeyBytes: 256,
  maxInputVersionValueBytes: 1_024,
  maxUpdateBytes: 256 * 1_024,
  maxEncodedStateBytes: 4 * 1_024 * 1_024,
  maxEntries: 1_024,
});

const encodedBytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const assertBoundedString = (value: string, label: string, maxBytes: number): void => {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  if (encodedBytes(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
};

const normalizeLimits = (limits: Partial<SharedWorkspaceLimits> = {}): SharedWorkspaceLimits => {
  const normalized = { ...DEFAULT_SHARED_WORKSPACE_LIMITS, ...limits };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Shared workspace limit ${name} must be a positive safe integer`);
    }
  }
  return normalized;
};

const assertInputVersions = (
  inputVersions: Readonly<Record<string, string>>,
  limits: SharedWorkspaceLimits,
): void => {
  const values = Object.entries(inputVersions);
  if (values.length > limits.maxInputVersions) {
    throw new Error(`Workspace input versions exceed limit ${limits.maxInputVersions}`);
  }
  for (const [key, value] of values) {
    assertBoundedString(key, "Workspace input version key", limits.maxInputVersionKeyBytes);
    assertBoundedString(value, `Workspace input version ${key}`, limits.maxInputVersionValueBytes);
  }
};

const assertUpdateMetadata = (
  update: SharedArtifactUpdate<WorkspaceEntry>,
  artifactId: string,
  limits: SharedWorkspaceLimits,
): void => {
  if (update.artifactId !== artifactId) throw new Error(`Workspace update targets unexpected artifact ${update.artifactId}`);
  if (update.artifactKind !== "roster-workspace" || update.schemaVersion !== "roster-workspace/v3") {
    throw new Error(`Workspace update ${update.updateId} has an unsupported schema`);
  }
  for (const [label, value] of [
    ["Workspace run id", update.runId],
    ["Workspace task id", update.taskId],
    ["Workspace node id", update.nodeId],
    ["Workspace frontier version", update.frontierVersion],
    ["Workspace topology version", update.topologyVersion],
  ] as const) assertBoundedString(value, label, limits.maxIdentifierBytes);
  assertInputVersions(update.inputVersions, limits);
};

const normalizeReferences = (references: ReadonlyArray<string>): string[] =>
  [...new Set(references.filter((reference) => reference.trim()))].sort();

export const createWorkspaceEntry = (
  input: WorkspaceEntryInput,
  limitOverrides: Partial<SharedWorkspaceLimits> = {},
): WorkspaceEntry => {
  const limits = normalizeLimits(limitOverrides);
  if (!WORKSPACE_ENTRY_KINDS.has(input.kind)) throw new Error(`Unknown workspace entry kind ${String(input.kind)}`);
  if (!WORKSPACE_ENTRY_MODES.has(input.mode)) throw new Error(`Unknown workspace entry mode ${String(input.mode)}`);
  assertBoundedString(input.subjectId, "Workspace entry subject id", limits.maxSubjectBytes);
  assertBoundedString(input.nodeId, "Workspace entry node id", limits.maxIdentifierBytes);
  if (!Array.isArray(input.references) || input.references.some((reference) => typeof reference !== "string")) {
    throw new Error("Workspace entry references must be strings");
  }
  if (input.references.length > limits.maxReferences) {
    throw new Error(`Workspace entry references exceed limit ${limits.maxReferences}`);
  }
  for (const reference of input.references) {
    if (encodedBytes(reference) > limits.maxReferenceBytes) {
      throw new Error(`Workspace entry reference exceeds ${limits.maxReferenceBytes} bytes`);
    }
  }
  const encodedBody = canonicalize(input.body);
  if (encodedBytes(encodedBody) > limits.maxBodyBytes) {
    throw new Error(`Workspace entry body exceeds ${limits.maxBodyBytes} bytes`);
  }
  const normalized = {
    kind: input.kind,
    mode: input.mode,
    subjectId: input.subjectId,
    nodeId: input.nodeId,
    body: input.body,
    references: normalizeReferences(input.references),
    bodyHash: hashCanonical(input.body),
  };
  return {
    ...normalized,
    entryId: `workspace_entry_${hashCanonical(normalized).slice(0, 28)}`,
  };
};

const subjectKey = (entry: Pick<WorkspaceEntry, "kind" | "subjectId">): string =>
  `${entry.kind}:${entry.subjectId}`;

const projectWorkspaceEntries = (
  updates: ReadonlyArray<SharedArtifactUpdate<WorkspaceEntry>>,
  frontier: { readonly frontierVersion: string; readonly topologyVersion: string },
  limits: SharedWorkspaceLimits = DEFAULT_SHARED_WORKSPACE_LIMITS,
) => {
  const current = updates.filter((update) =>
    update.frontierVersion === frontier.frontierVersion
    && update.topologyVersion === frontier.topologyVersion
  );
  const staleUpdateIds = updates
    .filter((update) => !current.includes(update))
    .map((update) => update.updateId)
    .sort();
  const invalidUpdateIds: string[] = [];
  const entries = new Map<string, WorkspaceEntry>();
  const updateIdsByEntry = new Map<string, string[]>();
  for (const update of current) {
    const entry = update.payload;
    let expected: WorkspaceEntry;
    try {
      expected = createWorkspaceEntry(entry, limits);
    } catch {
      invalidUpdateIds.push(update.updateId);
      continue;
    }
    if (expected.entryId !== entry.entryId || expected.bodyHash !== entry.bodyHash || update.nodeId !== entry.nodeId) {
      invalidUpdateIds.push(update.updateId);
      continue;
    }
    entries.set(entry.entryId, entry);
    const ids = updateIdsByEntry.get(entry.entryId) ?? [];
    ids.push(update.updateId);
    updateIdsByEntry.set(entry.entryId, ids);
  }

  const conflicts: ArtifactConflict[] = [];
  const acceptedEntries: WorkspaceEntry[] = [];
  const grouped = new Map<string, WorkspaceEntry[]>();
  for (const entry of entries.values()) {
    const key = subjectKey(entry);
    const values = grouped.get(key) ?? [];
    values.push(entry);
    grouped.set(key, values);
  }
  for (const [key, candidates] of grouped) {
    const exclusive = candidates.filter((candidate) => candidate.mode === "exclusive");
    const hashes = [...new Set(exclusive.map((candidate) => candidate.bodyHash))].sort();
    if (hashes.length > 1) {
      conflicts.push({
        conflictId: `workspace_conflict_${hashCanonical({ key, hashes }).slice(0, 24)}`,
        kind: "exclusive_workspace_entry",
        subjectId: key,
        candidateUpdateIds: exclusive.flatMap((candidate) => updateIdsByEntry.get(candidate.entryId) ?? []).sort(),
        candidateHashes: hashes,
      });
      acceptedEntries.push(...candidates.filter((candidate) => candidate.mode === "append"));
      continue;
    }
    acceptedEntries.push(...candidates);
  }
  acceptedEntries.sort((left, right) => left.entryId.localeCompare(right.entryId));
  const bySubject: Record<string, string[]> = {};
  for (const entry of acceptedEntries) {
    const key = subjectKey(entry);
    bySubject[key] = [...(bySubject[key] ?? []), entry.entryId].sort();
  }
  return {
    value: { entries: acceptedEntries, bySubject },
    acceptedUpdateIds: acceptedEntries
      .flatMap((entry) => updateIdsByEntry.get(entry.entryId) ?? [])
      .sort(),
    conflicts: conflicts.sort((left, right) => left.conflictId.localeCompare(right.conflictId)),
    invalidUpdateIds: invalidUpdateIds.sort(),
    staleUpdateIds,
  };
};

/**
 * Shared, convergent blackboard for logical workspace nodes. Execution state
 * remains private to each sandbox; only bounded, typed entries cross this
 * frontier. Exclusive entries expose semantic disagreement instead of using
 * Yjs arrival order as a winner.
 */
export class SharedWorkspaceLedger {
  private readonly ledger: SharedArtifactLedger<WorkspaceEntry>;
  readonly limits: SharedWorkspaceLimits;

  constructor(
    readonly artifactId: string,
    update?: Uint8Array,
    limits: Partial<SharedWorkspaceLimits> = {},
  ) {
    this.limits = normalizeLimits(limits);
    assertBoundedString(artifactId, "Workspace artifact id", this.limits.maxIdentifierBytes);
    this.ledger = new SharedArtifactLedger<WorkspaceEntry>({
      guid: `roster:workspace:${artifactId}`,
    });
    if (update) this.ingest(update, true);
  }

  publish(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly nodeId: string;
    readonly frontierVersion: string;
    readonly topologyVersion: string;
    readonly inputVersions?: Readonly<Record<string, string>>;
    readonly entry: Omit<WorkspaceEntryInput, "nodeId">;
  }): { readonly entry: WorkspaceEntry; readonly update: Uint8Array; readonly updateId: string } {
    if (this.ledger.size() >= this.limits.maxEntries) {
      throw new Error(`Workspace entry limit ${this.limits.maxEntries} reached`);
    }
    for (const [label, value] of [
      ["Workspace run id", input.runId],
      ["Workspace task id", input.taskId],
      ["Workspace node id", input.nodeId],
      ["Workspace frontier version", input.frontierVersion],
      ["Workspace topology version", input.topologyVersion],
    ] as const) assertBoundedString(value, label, this.limits.maxIdentifierBytes);
    assertInputVersions(input.inputVersions ?? {}, this.limits);
    const entry = createWorkspaceEntry({ ...input.entry, nodeId: input.nodeId }, this.limits);
    const artifactUpdate = createSharedArtifactUpdate({
      artifactId: this.artifactId,
      artifactKind: "roster-workspace",
      schemaVersion: "roster-workspace/v3",
      frontierVersion: input.frontierVersion,
      topologyVersion: input.topologyVersion,
      runId: input.runId,
      taskId: input.taskId,
      nodeId: input.nodeId,
      inputVersions: input.inputVersions ?? {},
      payload: entry,
    });
    const update = this.ledger.add(artifactUpdate);
    if (update.byteLength > this.limits.maxUpdateBytes) {
      this.compact(this.ledger.updates(this.artifactId).filter((candidate) => candidate.updateId !== artifactUpdate.updateId));
      throw new Error(`Workspace update exceeds ${this.limits.maxUpdateBytes} bytes`);
    }
    if (this.ledger.encode().byteLength > this.limits.maxEncodedStateBytes) {
      this.compact(this.ledger.updates(this.artifactId).filter((candidate) => candidate.updateId !== artifactUpdate.updateId));
      throw new Error(`Workspace encoded state exceeds ${this.limits.maxEncodedStateBytes} bytes`);
    }
    return {
      entry,
      update,
      updateId: artifactUpdate.updateId,
    };
  }

  apply(update: Uint8Array): void {
    this.ingest(update, false);
  }

  private ingest(update: Uint8Array, snapshot: boolean): void {
    if (!snapshot && update.byteLength > this.limits.maxUpdateBytes) {
      throw new Error(`Workspace update exceeds ${this.limits.maxUpdateBytes} bytes`);
    }
    if (update.byteLength > this.limits.maxEncodedStateBytes) {
      throw new Error(`Workspace encoded update exceeds ${this.limits.maxEncodedStateBytes} bytes`);
    }
    const candidate = new SharedArtifactLedger<WorkspaceEntry>({
      guid: `roster:workspace:${this.artifactId}:candidate`,
      ...(this.ledger.size() ? { update: this.ledger.encode() } : {}),
    });
    try {
      candidate.apply(update, "bounded-remote");
      const encoded = candidate.encode();
      if (encoded.byteLength > this.limits.maxEncodedStateBytes) {
        throw new Error(`Workspace encoded state exceeds ${this.limits.maxEncodedStateBytes} bytes`);
      }
      const retainedIds = new Set(candidate.keys().slice(0, this.limits.maxEntries));
      const parsed = candidate.updates(undefined, retainedIds);
      if (parsed.length !== retainedIds.size) throw new Error("Workspace update contains invalid retained CRDT entries");
      for (const artifactUpdate of parsed) {
        assertUpdateMetadata(artifactUpdate, this.artifactId, this.limits);
        const expected = createWorkspaceEntry(artifactUpdate.payload, this.limits);
        if (
          expected.entryId !== artifactUpdate.payload.entryId
          || expected.bodyHash !== artifactUpdate.payload.bodyHash
          || artifactUpdate.nodeId !== artifactUpdate.payload.nodeId
        ) throw new Error(`Workspace update ${artifactUpdate.updateId} has an invalid entry identity`);
      }
      this.compact(parsed);
    } finally {
      candidate.destroy();
    }
  }

  private compact(updates: ReadonlyArray<SharedArtifactUpdate<WorkspaceEntry>>): void {
    this.ledger.replace(updates);
  }

  encode(): Uint8Array {
    return this.ledger.encode();
  }

  project(frontier: {
    readonly frontierVersion: string;
    readonly topologyVersion: string;
  }): ArtifactProjection<SharedWorkspaceValue> {
    return this.ledger.project(this.artifactId, frontier, (updates, current) =>
      projectWorkspaceEntries(updates, current, this.limits));
  }

  destroy(): void {
    this.ledger.destroy();
  }
}

export type WorkspaceReadSelector = {
  readonly kinds?: ReadonlyArray<WorkspaceEntryKind>;
  readonly subjectIds?: ReadonlyArray<string>;
  readonly entryIds?: ReadonlyArray<string>;
  readonly limit?: number;
};

export type TaskWorkspaceFence = {
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly fence: bigint;
  readonly runtimeBindingEpoch: number;
  readonly frontierVersion: string;
  readonly topologyVersion: string;
  readonly catalogVersion: string;
  readonly inputVersions: Readonly<Record<string, string>>;
};

export type TaskWorkspaceAuthority = {
  readonly assertActive: (
    operation: "read" | "publish",
    fence: TaskWorkspaceFence,
  ) => Promise<void>;
};

export type RosterTaskContext = {
  readonly node: WorkspaceNode;
  readonly fence: TaskWorkspaceFence;
  readonly readWorkspace: (
    selector?: WorkspaceReadSelector,
  ) => Promise<ArtifactProjection<SharedWorkspaceValue>>;
  readonly publish: (
    entry: Omit<WorkspaceEntryInput, "nodeId">,
  ) => Promise<{ readonly entry: WorkspaceEntry; readonly update: Uint8Array; readonly updateId: string }>;
};

export const selectWorkspaceProjection = (
  projection: ArtifactProjection<SharedWorkspaceValue>,
  selector: WorkspaceReadSelector = {},
): ArtifactProjection<SharedWorkspaceValue> => {
  const kinds = new Set(selector.kinds ?? []);
  const subjectIds = new Set(selector.subjectIds ?? []);
  const entryIds = new Set(selector.entryIds ?? []);
  const requestedLimit = selector.limit ?? 128;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 512) {
    throw new Error("Workspace read selector limit must be between 1 and 512");
  }
  const entries = projection.value.entries.filter((entry) =>
    (kinds.size === 0 || kinds.has(entry.kind))
    && (subjectIds.size === 0 || subjectIds.has(entry.subjectId))
    && (entryIds.size === 0 || entryIds.has(entry.entryId))
  ).slice(0, requestedLimit);
  const selectedIds = new Set(entries.map((entry) => entry.entryId));
  const bySubject = Object.fromEntries(Object.entries(projection.value.bySubject)
    .map(([subject, ids]) => [subject, ids.filter((id) => selectedIds.has(id))] as const)
    .filter(([, ids]) => ids.length > 0));
  return {
    ...projection,
    value: { entries, bySubject },
  };
};

export const createRosterTaskContext = (input: {
  readonly node: WorkspaceNode;
  readonly ledger: SharedWorkspaceLedger;
  readonly fence: TaskWorkspaceFence;
  readonly authority: TaskWorkspaceAuthority;
  readonly onUpdate?: (update: Uint8Array) => Promise<void> | void;
}): RosterTaskContext => ({
  node: input.node,
  fence: input.fence,
  readWorkspace: async (selector) => {
    await input.authority.assertActive("read", input.fence);
    return selectWorkspaceProjection(input.ledger.project({
      frontierVersion: input.fence.frontierVersion,
      topologyVersion: input.fence.topologyVersion,
    }), selector);
  },
  publish: async (entry) => {
    await input.authority.assertActive("publish", input.fence);
    const published = input.ledger.publish({
      runId: input.fence.runId,
      taskId: input.fence.taskId,
      nodeId: input.node.id,
      frontierVersion: input.fence.frontierVersion,
      topologyVersion: input.fence.topologyVersion,
      inputVersions: {
        ...input.fence.inputVersions,
        "platform:catalog": input.fence.catalogVersion,
        "platform:runtime-binding-epoch": String(input.fence.runtimeBindingEpoch),
      },
      entry,
    });
    await input.onUpdate?.(published.update);
    return published;
  },
});
