import { hashCanonical } from "../../core/canonical.js";
import {
  createSharedArtifactUpdate,
  SharedArtifactLedger,
} from "../artifact/shared-crdt.js";
import { canvasSvgPathBounds } from "./svg-path.js";

export type CanvasObjectType =
  | "group"
  | "ellipse"
  | "circle"
  | "line"
  | "polygon"
  | "polyline"
  | "path"
  | "rect";

export type CanvasGeometryValue = string | number | ReadonlyArray<number>;

export type CanvasGradientStop = {
  readonly offset: number;
  readonly color: string;
  readonly opacity: number;
};

export type CanvasGradient =
  | {
      readonly kind: "linear-gradient";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly stops: ReadonlyArray<CanvasGradientStop>;
    }
  | {
      readonly kind: "radial-gradient";
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly stops: ReadonlyArray<CanvasGradientStop>;
    };

export type CanvasStyleValue =
  | string
  | number
  | ReadonlyArray<number>
  | CanvasGradient
  | undefined;

export type CanvasObject = {
  readonly id: string;
  readonly semanticId: string;
  readonly ownerAgentId: string;
  readonly taskId: string;
  readonly partId: string;
  readonly type: CanvasObjectType;
  readonly geometry: Readonly<Record<string, CanvasGeometryValue>>;
  readonly style: Readonly<Record<string, CanvasStyleValue>>;
  readonly layer: number;
  readonly rank: number;
};

export type CanvasPatch = {
  readonly patchId: string;
  readonly runId: string;
  readonly planVersion: string;
  readonly baseSceneHash: string;
  /** Immutable patch revision this patch replaces in the active scene projection. */
  readonly supersedesPatchId?: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly partId: string;
  readonly objects: ReadonlyArray<CanvasObject>;
};

export type CanvasSceneConflict =
  | {
      readonly kind: "patch";
      readonly id: string;
      readonly candidateHashes: ReadonlyArray<string>;
    }
  | {
      readonly kind: "object";
      readonly id: string;
      readonly candidateHashes: ReadonlyArray<string>;
    }
  | {
      readonly kind: "part";
      readonly id: string;
      readonly candidateHashes: ReadonlyArray<string>;
    };

export type CanvasSceneProjection = {
  readonly patches: ReadonlyArray<CanvasPatch>;
  readonly objects: ReadonlyArray<CanvasObject>;
  readonly conflicts: ReadonlyArray<CanvasSceneConflict>;
};

const PATCHES_MAP = "canvas-patch-candidates";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const OBJECT_TYPES = new Set<CanvasObjectType>(["group", "ellipse", "circle", "line", "polygon", "polyline", "path", "rect"]);
const STYLE_KEYS = new Set([
  "fill",
  "stroke",
  "strokeWidth",
  "opacity",
  "fillOpacity",
  "strokeOpacity",
  "strokeLinecap",
  "strokeLinejoin",
  "strokeDasharray",
]);

const assertId = (name: string, value: string): void => {
  if (!ID_PATTERN.test(value)) throw new Error(`Invalid ${name} "${value}"`);
};

const assertFinite = (name: string, value: number, min = -100, max = 1_100): void => {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a finite number between ${min} and ${max}`);
  }
};

const cloneGeometryValue = (value: CanvasGeometryValue): CanvasGeometryValue =>
  Array.isArray(value) ? [...value] : value;

const SAFE_COLOR = /^(?:none|#[0-9a-fA-F]{6})$/;

const normalizeGradient = (name: string, value: CanvasGradient): CanvasGradient => {
  const coordinate = (key: string, input: number): number => {
    if (!Number.isFinite(input) || input < 0 || input > 1) throw new Error(`${name}.${key} must be between 0 and 1`);
    return input;
  };
  if (!Array.isArray(value.stops) || value.stops.length < 2 || value.stops.length > 4) {
    throw new Error(`${name} must contain between 2 and 4 gradient stops`);
  }
  let previousOffset = -1;
  const stops = value.stops.map((stop, index) => {
    if (!SAFE_COLOR.test(stop.color) || stop.color === "none") throw new Error(`${name}.stops.${index} has an invalid color`);
    const offset = coordinate(`stops.${index}.offset`, stop.offset);
    const opacity = coordinate(`stops.${index}.opacity`, stop.opacity);
    if (offset < previousOffset) throw new Error(`${name} gradient stops must be ordered`);
    previousOffset = offset;
    return { offset, color: stop.color, opacity };
  });
  if (value.kind === "linear-gradient") {
    return {
      kind: value.kind,
      x1: coordinate("x1", value.x1),
      y1: coordinate("y1", value.y1),
      x2: coordinate("x2", value.x2),
      y2: coordinate("y2", value.y2),
      stops,
    };
  }
  if (value.kind === "radial-gradient") {
    const radius = coordinate("r", value.r);
    if (radius <= 0) throw new Error(`${name}.r must be greater than 0`);
    return {
      kind: value.kind,
      cx: coordinate("cx", value.cx),
      cy: coordinate("cy", value.cy),
      r: radius,
      stops,
    };
  }
  throw new Error(`${name} has an unsupported gradient kind`);
};

export const normalizeCanvasObject = (input: CanvasObject): CanvasObject => {
  assertId("canvas object id", input.id);
  assertId("semantic id", input.semanticId);
  assertId("owner agent id", input.ownerAgentId);
  assertId("task id", input.taskId);
  assertId("part id", input.partId);
  if (!OBJECT_TYPES.has(input.type)) throw new Error(`${input.id} uses unsupported object type ${String(input.type)}`);
  assertFinite(`${input.id}.layer`, input.layer, 0, 10_000);
  assertFinite(`${input.id}.rank`, input.rank, 0, 1_000_000);

  const geometry: Record<string, CanvasGeometryValue> = {};
  for (const [key, raw] of Object.entries(input.geometry)) {
    if (typeof raw === "number") {
      assertFinite(`${input.id}.${key}`, raw);
      geometry[key] = raw;
      continue;
    }
    if (Array.isArray(raw)) {
      if (raw.length === 0 || raw.length > 512) throw new Error(`${input.id}.${key} has an invalid coordinate list`);
      for (const value of raw) assertFinite(`${input.id}.${key}`, value);
      geometry[key] = [...raw];
      continue;
    }
    if (typeof raw !== "string" || raw.length > 8_000) throw new Error(`${input.id}.${key} has invalid geometry`);
    if (key === "d") {
      const bounds = canvasSvgPathBounds(raw);
      assertFinite(`${input.id}.path.minX`, bounds.minX);
      assertFinite(`${input.id}.path.minY`, bounds.minY);
      assertFinite(`${input.id}.path.maxX`, bounds.maxX);
      assertFinite(`${input.id}.path.maxY`, bounds.maxY);
    }
    geometry[key] = raw;
  }

  const requiredGeometry: Readonly<Record<CanvasObjectType, ReadonlyArray<string>>> = {
    group: [],
    ellipse: ["cx", "cy", "rx", "ry"],
    circle: ["cx", "cy", "r"],
    line: ["x1", "y1", "x2", "y2"],
    polygon: ["points"],
    polyline: ["points"],
    path: ["d"],
    rect: ["x", "y", "width", "height"],
  };
  for (const key of requiredGeometry[input.type]) {
    if (geometry[key] === undefined) throw new Error(`${input.id} is missing ${key}`);
  }

  const style: Record<string, CanvasStyleValue> = {};
  for (const [key, value] of Object.entries(input.style)) {
    if (!STYLE_KEYS.has(key)) throw new Error(`${input.id} uses unsupported style ${key}`);
    if (key === "fill" && value && typeof value === "object" && !Array.isArray(value)) {
      style[key] = normalizeGradient(`${input.id}.fill`, value as CanvasGradient);
      continue;
    }
    if (key === "strokeDasharray" && Array.isArray(value)) {
      if (value.length < 1 || value.length > 8 || value.some((entry) => !Number.isFinite(entry) || entry < 0 || entry > 100)
        || value.every((entry) => entry === 0)) {
        throw new Error(`${input.id}.strokeDasharray is invalid`);
      }
      style[key] = [...value];
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`${input.id}.${key} is not finite`);
      if ((key === "opacity" || key === "fillOpacity" || key === "strokeOpacity") && (value < 0 || value > 1)) {
        throw new Error(`${input.id}.${key} must be between 0 and 1`);
      }
      if (key === "strokeWidth" && (value < 0 || value > 80)) throw new Error(`${input.id}.strokeWidth is invalid`);
      style[key] = value;
      continue;
    }
    if (value !== undefined && (typeof value !== "string" || value.length > 200 || /url\s*\(/i.test(value))) {
      throw new Error(`${input.id}.${key} has unsafe styling`);
    }
    if (key === "strokeLinecap" && value !== undefined && !["butt", "round", "square"].includes(value)) {
      throw new Error(`${input.id}.strokeLinecap is invalid`);
    }
    if (key === "strokeLinejoin" && value !== undefined && !["miter", "round", "bevel"].includes(value)) {
      throw new Error(`${input.id}.strokeLinejoin is invalid`);
    }
    style[key] = value;
  }

  return {
    ...input,
    geometry: Object.fromEntries(Object.entries(geometry).map(([key, value]) => [key, cloneGeometryValue(value)])),
    style,
  };
};

export const canvasPatchContentHash = (patch: Omit<CanvasPatch, "patchId"> | CanvasPatch): string =>
  hashCanonical({
    runId: patch.runId,
    planVersion: patch.planVersion,
    baseSceneHash: patch.baseSceneHash,
    supersedesPatchId: patch.supersedesPatchId,
    agentId: patch.agentId,
    taskId: patch.taskId,
    partId: patch.partId,
    objects: patch.objects.map(normalizeCanvasObject),
  });

export const normalizeCanvasPatch = (patch: CanvasPatch): CanvasPatch => {
  assertId("patch id", patch.patchId);
  assertId("run id", patch.runId);
  assertId("agent id", patch.agentId);
  assertId("task id", patch.taskId);
  assertId("part id", patch.partId);
  if (patch.supersedesPatchId !== undefined) {
    assertId("superseded patch id", patch.supersedesPatchId);
    if (patch.supersedesPatchId === patch.patchId) throw new Error(`Patch ${patch.patchId} cannot supersede itself`);
  }
  if (!patch.planVersion.trim() || !patch.baseSceneHash.trim()) throw new Error(`Patch ${patch.patchId} has no version boundary`);
  if (patch.objects.length === 0 || patch.objects.length > 256) throw new Error(`Patch ${patch.patchId} has an invalid object count`);
  const objects = patch.objects.map(normalizeCanvasObject);
  const ids = new Set<string>();
  for (const object of objects) {
    if (ids.has(object.id)) throw new Error(`Patch ${patch.patchId} repeats object ${object.id}`);
    if (object.ownerAgentId !== patch.agentId || object.taskId !== patch.taskId || object.partId !== patch.partId) {
      throw new Error(`Patch ${patch.patchId} crosses its ownership boundary`);
    }
    ids.add(object.id);
  }
  const normalized = { ...patch, objects };
  const expected = `patch-${canvasPatchContentHash(normalized).slice(0, 24)}`;
  if (patch.patchId !== expected) throw new Error(`Patch ${patch.patchId} has an invalid content identity`);
  return normalized;
};

export const createCanvasPatch = (
  input: Omit<CanvasPatch, "patchId">
): CanvasPatch => normalizeCanvasPatch({
  ...input,
  patchId: `patch-${canvasPatchContentHash(input).slice(0, 24)}`,
});

const asCanvasPatch = (value: unknown): CanvasPatch | undefined => {
  if (!value || typeof value !== "object") return undefined;
  try {
    return normalizeCanvasPatch(value as CanvasPatch);
  } catch {
    return undefined;
  }
};

export class CanvasSceneLedger {
  private readonly ledger: SharedArtifactLedger<CanvasPatch>;

  constructor(update?: Uint8Array) {
    this.ledger = new SharedArtifactLedger({
      update,
      guid: "roster:canvas-scene",
      mapName: PATCHES_MAP,
    });
  }

  add(patchInput: CanvasPatch, _origin: unknown = patchInput.agentId): Uint8Array {
    const patch = normalizeCanvasPatch(patchInput);
    return this.ledger.add(createSharedArtifactUpdate({
      artifactId: `${patch.runId}:canvas-scene`,
      artifactKind: "canvas.scene",
      schemaVersion: "canvas-patch/v1",
      frontierVersion: patch.planVersion,
      topologyVersion: patch.planVersion,
      runId: patch.runId,
      taskId: patch.taskId,
      nodeId: patch.agentId,
      inputVersions: { scene: patch.baseSceneHash },
      payload: patch,
    }));
  }

  applyEncodedUpdate(update: Uint8Array, origin: unknown = "remote"): void {
    this.ledger.apply(update, origin);
  }

  encode(): Uint8Array {
    return this.ledger.encode();
  }

  project(): CanvasSceneProjection {
    const raw = this.ledger.updates()
      .map((update) => asCanvasPatch(update.payload))
      .filter((patch): patch is CanvasPatch => Boolean(patch));
    const conflicts: CanvasSceneConflict[] = [];
    const patchGroups = new Map<string, CanvasPatch[]>();
    for (const patch of raw) patchGroups.set(patch.patchId, [...(patchGroups.get(patch.patchId) ?? []), patch]);

    const patches: CanvasPatch[] = [];
    for (const [patchId, candidates] of patchGroups) {
      const byHash = new Map(candidates.map((candidate) => [canvasPatchContentHash(candidate), candidate] as const));
      if (byHash.size > 1) {
        conflicts.push({ kind: "patch", id: patchId, candidateHashes: [...byHash.keys()].sort() });
        continue;
      }
      const accepted = [...byHash.values()][0];
      if (accepted) patches.push(accepted);
    }
    patches.sort((left, right) => left.patchId.localeCompare(right.patchId));

    // Revisions are append-only Yjs records. Projection selects the unsuperseded
    // head for each semantic part while retaining every historical patch in the
    // document. Competing heads are a real merge conflict, never an arbitrary
    // last-writer-wins decision.
    const byPatchId = new Map(patches.map((patch) => [patch.patchId, patch] as const));
    const superseded = new Set<string>();
    const invalidRevisions = new Set<string>();
    for (const patch of patches) {
      if (!patch.supersedesPatchId) continue;
      const parent = byPatchId.get(patch.supersedesPatchId);
      if (!parent) {
        conflicts.push({
          kind: "patch",
          id: patch.patchId,
          candidateHashes: [canvasPatchContentHash(patch)],
        });
        invalidRevisions.add(patch.patchId);
        continue;
      }
      if (parent.runId !== patch.runId || parent.planVersion !== patch.planVersion || parent.partId !== patch.partId) {
        conflicts.push({
          kind: "patch",
          id: patch.patchId,
          candidateHashes: [canvasPatchContentHash(parent), canvasPatchContentHash(patch)].sort(),
        });
        invalidRevisions.add(patch.patchId);
        continue;
      }
      superseded.add(patch.supersedesPatchId);
    }

    const activePatchGroups = new Map<string, CanvasPatch[]>();
    for (const patch of patches) {
      if (superseded.has(patch.patchId) || invalidRevisions.has(patch.patchId)) continue;
      const key = `${patch.runId}:${patch.planVersion}:${patch.partId}`;
      activePatchGroups.set(key, [...(activePatchGroups.get(key) ?? []), patch]);
    }

    const activePatches: CanvasPatch[] = [];
    for (const [partKey, candidates] of activePatchGroups) {
      if (candidates.length > 1) {
        conflicts.push({
          kind: "part",
          id: partKey,
          candidateHashes: candidates.map(canvasPatchContentHash).sort(),
        });
        continue;
      }
      const accepted = candidates[0];
      if (accepted) activePatches.push(accepted);
    }
    activePatches.sort((left, right) => left.patchId.localeCompare(right.patchId));

    const objectGroups = new Map<string, CanvasObject[]>();
    for (const patch of activePatches) {
      for (const object of patch.objects) {
        objectGroups.set(object.id, [...(objectGroups.get(object.id) ?? []), object]);
      }
    }
    const objects: CanvasObject[] = [];
    for (const [objectId, candidates] of objectGroups) {
      const byHash = new Map(candidates.map((candidate) => [hashCanonical(candidate), candidate] as const));
      if (byHash.size > 1) {
        conflicts.push({ kind: "object", id: objectId, candidateHashes: [...byHash.keys()].sort() });
        continue;
      }
      const accepted = [...byHash.values()][0];
      if (accepted) objects.push(accepted);
    }
    objects.sort((left, right) => left.layer - right.layer || left.rank - right.rank || left.id.localeCompare(right.id));
    conflicts.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
    return { patches: activePatches, objects, conflicts };
  }

  destroy(): void {
    this.ledger.destroy();
  }
}

export const canonicalCanvasScene = (objects: ReadonlyArray<CanvasObject>): string => JSON.stringify(
  [...objects].map(normalizeCanvasObject).sort(
    (left, right) => left.layer - right.layer || left.rank - right.rank || left.id.localeCompare(right.id)
  )
);

export const canvasSceneHash = (objects: ReadonlyArray<CanvasObject>): string =>
  hashCanonical(JSON.parse(canonicalCanvasScene(objects)));
