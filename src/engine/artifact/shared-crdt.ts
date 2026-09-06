import * as Y from "yjs";

import { hashCanonical } from "../../core/canonical.js";

const DEFAULT_MAP = "shared-artifact-updates";

export type SharedArtifactUpdate<TPayload> = {
  readonly updateId: string;
  readonly artifactId: string;
  readonly artifactKind: string;
  readonly schemaVersion: string;
  readonly frontierVersion: string;
  readonly topologyVersion: string;
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly inputVersions: Readonly<Record<string, string>>;
  readonly payloadHash: string;
  readonly payload: TPayload;
};

export type SharedArtifactUpdateInput<TPayload> = Omit<
  SharedArtifactUpdate<TPayload>,
  "updateId" | "payloadHash"
>;

export type ArtifactConflict = {
  readonly conflictId: string;
  readonly kind: string;
  readonly subjectId: string;
  readonly candidateUpdateIds: ReadonlyArray<string>;
  readonly candidateHashes: ReadonlyArray<string>;
};

export type ArtifactProjection<TValue> = {
  readonly value: TValue;
  readonly acceptedUpdateIds: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<ArtifactConflict>;
  readonly invalidUpdateIds: ReadonlyArray<string>;
  readonly staleUpdateIds: ReadonlyArray<string>;
  readonly versionHash: string;
};

export type ArtifactProjector<TPayload, TValue> = (
  updates: ReadonlyArray<SharedArtifactUpdate<TPayload>>,
  frontier: { readonly frontierVersion: string; readonly topologyVersion: string }
) => Omit<ArtifactProjection<TValue>, "versionHash">;

const canonicalUpdate = <TPayload>(input: SharedArtifactUpdateInput<TPayload>) => ({
  artifactId: input.artifactId,
  artifactKind: input.artifactKind,
  schemaVersion: input.schemaVersion,
  frontierVersion: input.frontierVersion,
  topologyVersion: input.topologyVersion,
  runId: input.runId,
  taskId: input.taskId,
  nodeId: input.nodeId,
  inputVersions: Object.fromEntries(Object.entries(input.inputVersions).sort(([left], [right]) => left.localeCompare(right))),
  payloadHash: hashCanonical(input.payload),
  payload: input.payload,
});

export const sharedArtifactUpdateId = <TPayload>(input: SharedArtifactUpdateInput<TPayload>): string =>
  `update_${hashCanonical(canonicalUpdate(input)).slice(0, 32)}`;

export const createSharedArtifactUpdate = <TPayload>(
  input: SharedArtifactUpdateInput<TPayload>
): SharedArtifactUpdate<TPayload> => {
  const canonical = canonicalUpdate(input);
  return {
    ...canonical,
    updateId: sharedArtifactUpdateId(input),
  };
};

const virtualClientId = (updateId: string): number => {
  const value = Number.parseInt(hashCanonical(updateId).slice(0, 8), 16) >>> 0;
  return value || 1;
};

const isStringRecord = (value: unknown): value is Readonly<Record<string, string>> =>
  Boolean(value)
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");

const parseUpdate = <TPayload>(key: string, value: unknown): SharedArtifactUpdate<TPayload> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.updateId !== key
    || typeof record.artifactId !== "string"
    || typeof record.artifactKind !== "string"
    || typeof record.schemaVersion !== "string"
    || typeof record.frontierVersion !== "string"
    || typeof record.topologyVersion !== "string"
    || typeof record.runId !== "string"
    || typeof record.taskId !== "string"
    || typeof record.nodeId !== "string"
    || !isStringRecord(record.inputVersions)
    || typeof record.payloadHash !== "string"
    || !("payload" in record)
  ) return undefined;
  const input: SharedArtifactUpdateInput<TPayload> = {
    artifactId: record.artifactId,
    artifactKind: record.artifactKind,
    schemaVersion: record.schemaVersion,
    frontierVersion: record.frontierVersion,
    topologyVersion: record.topologyVersion,
    runId: record.runId,
    taskId: record.taskId,
    nodeId: record.nodeId,
    inputVersions: record.inputVersions,
    payload: record.payload as TPayload,
  };
  const parsed = createSharedArtifactUpdate(input);
  return parsed.updateId === key && parsed.payloadHash === record.payloadHash ? parsed : undefined;
};

/**
 * Add-only Yjs substrate for all member-authored artifacts. Domain semantics do
 * not live in the CRDT: projectors interpret the converged immutable updates,
 * expose conflicts, and produce a version that a coordinator may certify.
 */
export class SharedArtifactLedger<TPayload> {
  private doc: Y.Doc;
  private readonly mapName: string;

  constructor(options: { readonly update?: Uint8Array; readonly mapName?: string; readonly guid?: string } = {}) {
    this.mapName = options.mapName ?? DEFAULT_MAP;
    this.doc = new Y.Doc({ guid: options.guid ?? "roster:shared-artifact" });
    this.doc.getMap<SharedArtifactUpdate<TPayload>>(this.mapName);
    if (options.update) Y.applyUpdate(this.doc, options.update, "restore");
  }

  add(update: SharedArtifactUpdate<TPayload>): Uint8Array {
    const expected = createSharedArtifactUpdate<TPayload>(update);
    if (expected.updateId !== update.updateId || expected.payloadHash !== update.payloadHash) {
      throw new Error(`Shared artifact update ${update.updateId} has an invalid content identity`);
    }
    const isolated = new Y.Doc({ guid: this.doc.guid });
    isolated.clientID = virtualClientId(update.updateId);
    isolated.getMap<SharedArtifactUpdate<TPayload>>(this.mapName).set(update.updateId, update);
    const encoded = Y.encodeStateAsUpdate(isolated);
    isolated.destroy();
    this.apply(encoded);
    return encoded;
  }

  apply(update: Uint8Array, origin: unknown = "remote"): void {
    Y.applyUpdate(this.doc, update, origin);
  }

  /** Number of raw CRDT map values, including values that fail identity validation. */
  size(): number {
    return this.doc.getMap<unknown>(this.mapName).size;
  }

  keys(): string[] {
    return [...this.doc.getMap<unknown>(this.mapName).keys()].sort();
  }

  /**
   * Replace the CRDT document with an equivalent add-only snapshot. This is
   * intentionally explicit: bounded domain ledgers use it to deterministically
   * compact a converged candidate set without making arrival order semantic.
   */
  replace(updates: ReadonlyArray<SharedArtifactUpdate<TPayload>>): void {
    const replacement = new Y.Doc({ guid: this.doc.guid });
    const map = replacement.getMap<SharedArtifactUpdate<TPayload>>(this.mapName);
    for (const update of [...updates].sort((left, right) => left.updateId.localeCompare(right.updateId))) {
      const expected = createSharedArtifactUpdate<TPayload>(update);
      if (expected.updateId !== update.updateId || expected.payloadHash !== update.payloadHash) {
        replacement.destroy();
        throw new Error(`Shared artifact update ${update.updateId} has an invalid content identity`);
      }
      map.set(update.updateId, update);
    }
    const previous = this.doc;
    this.doc = replacement;
    previous.destroy();
  }

  encode(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  updates(artifactId?: string, updateIds?: ReadonlySet<string>): SharedArtifactUpdate<TPayload>[] {
    const updates: SharedArtifactUpdate<TPayload>[] = [];
    for (const [key, value] of this.doc.getMap<unknown>(this.mapName)) {
      if (updateIds && !updateIds.has(key)) continue;
      const parsed = parseUpdate<TPayload>(key, value);
      if (parsed && (!artifactId || parsed.artifactId === artifactId)) updates.push(parsed);
    }
    return updates.sort((left, right) => left.updateId.localeCompare(right.updateId));
  }

  project<TValue>(
    artifactId: string,
    frontier: { readonly frontierVersion: string; readonly topologyVersion: string },
    projector: ArtifactProjector<TPayload, TValue>
  ): ArtifactProjection<TValue> {
    const projected = projector(this.updates(artifactId), frontier);
    return {
      ...projected,
      versionHash: hashCanonical({
        artifactId,
        ...frontier,
        acceptedUpdateIds: [...projected.acceptedUpdateIds].sort(),
        conflicts: projected.conflicts,
        value: projected.value,
      }),
    };
  }

  destroy(): void {
    this.doc.destroy();
  }
}

export const mergeSharedArtifactUpdates = (...updates: ReadonlyArray<Uint8Array>): Uint8Array =>
  Y.mergeUpdates([...updates]);
