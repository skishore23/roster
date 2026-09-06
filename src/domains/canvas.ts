import { hashCanonical } from "../core/canonical.js";
import { materializeNodeDemand, type NodeDemand } from "../engine/orchestration/adaptive.js";
import { createDomainRegistry } from "../engine/orchestration/domain.js";
import type {
  DomainPack,
  DomainRegistry,
  JsonValue,
  WorkspaceNode,
  WorkspaceNodeRuntime,
} from "../engine/orchestration/types.js";
import { rosterNativeRuntime } from "../engine/workspace/node.js";
import {
  canvasSceneHash,
  canonicalCanvasScene,
  createCanvasPatch,
  normalizeCanvasObject,
  type CanvasGradient,
  type CanvasGeometryValue,
  type CanvasObject,
  type CanvasObjectType,
  type CanvasPatch,
  type CanvasSceneConflict,
} from "../engine/visual/scene.js";
import { canvasSvgPathBounds } from "../engine/visual/svg-path.js";
import {
  CANVAS_MAX_OBJECTS_PER_PAINTER,
  CANVAS_MAX_PAINTERS,
  CANVAS_MAX_SCENE_OBJECTS,
  CANVAS_MIN_PAINTERS,
} from "../modules/canvas.js";
import type {
  CanvasCompositionRole,
  CanvasFeatureKind,
  CanvasPaintMode,
  CanvasPainterPlanPart,
  CanvasPlanPart,
  CanvasReview,
  CanvasScenePlan,
} from "../modules/canvas.js";

export type CanvasNodeRole = string;

export type CanvasNodeDemand = NodeDemand & {
  readonly role: CanvasNodeRole;
};

export type CanvasNodeSpec = WorkspaceNode & {
  readonly role: CanvasNodeRole;
  readonly focus: string;
};

export type CanvasPlanPartDraft = {
  readonly id: string;
  readonly label: string;
  readonly artistName: string;
  readonly focus: string;
  readonly objective: string;
  readonly compositionRole: CanvasCompositionRole;
  readonly paintMode: CanvasPaintMode;
  readonly featureKind?: CanvasFeatureKind;
  readonly ownedFeatures?: ReadonlyArray<string>;
  readonly coordinatesWith: ReadonlyArray<string>;
  readonly region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly maxFootprint: { readonly width: number; readonly height: number };
  readonly protectedAnchors: ReadonlyArray<string>;
  readonly allowBleed: boolean;
  readonly minObjects: number;
  readonly maxObjects: number;
};

export type CanvasScaffoldMarkDraft = {
  readonly id: string;
  readonly featureId: string;
  readonly type: Exclude<CanvasObjectType, "group">;
  readonly geometry: Readonly<Record<string, CanvasGeometryValue>>;
  readonly style: CanvasObjectDraft["style"];
  readonly layer: number;
  readonly rank: number;
};

export type CanvasScenePlanDraft = {
  readonly subject: string;
  readonly artDirection: string;
  readonly compositionScaffold?: {
    readonly summary: string;
    readonly marks: ReadonlyArray<CanvasScaffoldMarkDraft>;
  };
  readonly focalBounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly description: string;
  };
  readonly anchors: ReadonlyArray<{
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly description: string;
  }>;
  readonly palette: CanvasScenePlan["palette"];
  readonly parts: ReadonlyArray<CanvasPlanPartDraft>;
};

export type CanvasObjectDraft = {
  readonly name: string;
  readonly semanticKey: string;
  readonly type: Exclude<CanvasObjectType, "group">;
  readonly geometry: Readonly<Record<string, CanvasGeometryValue>>;
  readonly style: {
    readonly fill: string | CanvasGradient;
    readonly stroke: string;
    readonly strokeWidth: number;
    readonly opacity: number;
    readonly fillOpacity?: number;
    readonly strokeOpacity?: number;
    readonly strokeLinecap?: "butt" | "round" | "square";
    readonly strokeLinejoin?: "miter" | "round" | "bevel";
    readonly strokeDasharray?: ReadonlyArray<number>;
  };
  readonly layerOffset: number;
  readonly rank: number;
};

const RESERVED_PART_IDS = new Set([
  "critic", "validator-semantic", "validator-composition", "validator-consistency",
  "composer", "prompt", "review", "final",
]);
const SAFE_PART_ID = /^[a-z][a-z0-9-]{1,30}$/;
const GENERIC_PART_ID = /^(?:p|part|artist|layer)-?\d+$/;
const COMPOSITION_ROLES = new Set<CanvasCompositionRole>(["FOUNDATION", "PRIMARY", "SECONDARY", "DETAIL", "ACCENT"]);
const PAINT_MODES = new Set<CanvasPaintMode>(["background", "solid", "transparent-shell", "linework", "accent"]);
const FEATURE_KINDS = new Set<CanvasFeatureKind>([
  "environment", "primary-subject", "secondary-subject", "structure",
  "material-detail", "foreground-contact", "lighting-accent",
]);
const SAFE_COLOR = /^(?:none|#[0-9a-fA-F]{6})$/;

const defaultFeatureKind = (role: CanvasCompositionRole): CanvasFeatureKind => {
  switch (role) {
    case "FOUNDATION": return "environment";
    case "PRIMARY": return "primary-subject";
    case "SECONDARY": return "secondary-subject";
    case "DETAIL": return "material-detail";
    case "ACCENT": return "lighting-accent";
  }
};

const assertText = (name: string, value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} cannot be empty`);
  return trimmed;
};

const assertCanvasRegion = (part: CanvasPlanPartDraft): void => {
  const { x, y, width, height } = part.region;
  if (![x, y, width, height].every(Number.isFinite)
    || x < 0 || y < 0 || width < 1 || height < 1
    || x + width > 1_000 || y + height > 1_000) {
    throw new Error(`Canvas part ${part.id} has an invalid 1000 by 1000 region`);
  }
};

const assertCanvasBounds = (
  name: string,
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
): void => {
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(Number.isFinite)
    || x < 0 || y < 0 || width < 1 || height < 1
    || x + width > 1_000 || y + height > 1_000) {
    throw new Error(`${name} has invalid 1000 by 1000 bounds`);
  }
};

export const createCanvasScenePlan = (
  prompt: string,
  draft: CanvasScenePlanDraft,
  expectedPainterCount = draft.parts.length
): CanvasScenePlan => {
  const brief = assertText("Visual brief", prompt);
  if (!Number.isInteger(expectedPainterCount)
    || expectedPainterCount < CANVAS_MIN_PAINTERS
    || expectedPainterCount > CANVAS_MAX_PAINTERS) {
    throw new Error(
      `Requested painter count ${expectedPainterCount} must be between ${CANVAS_MIN_PAINTERS} and ${CANVAS_MAX_PAINTERS}`
    );
  }
  if (draft.parts.length !== expectedPainterCount) {
    throw new Error(`Art Director planned ${draft.parts.length} painter parts; exactly ${expectedPainterCount} required`);
  }
  if (draft.anchors.length < 2 || draft.anchors.length > 8) {
    throw new Error(`Art Director planned ${draft.anchors.length} anchors; expected between 2 and 8`);
  }
  assertCanvasBounds("Art Director focal bounds", draft.focalBounds);

  const anchorIds = new Set<string>();
  const anchors = draft.anchors.map((anchor) => {
    if (!SAFE_PART_ID.test(anchor.id) || anchorIds.has(anchor.id)) {
      throw new Error(`Art Director produced invalid or duplicate anchor ${anchor.id}`);
    }
    if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)
      || anchor.x < 0 || anchor.x > 1_000 || anchor.y < 0 || anchor.y > 1_000) {
      throw new Error(`Anchor ${anchor.id} is outside the canvas`);
    }
    anchorIds.add(anchor.id);
    return { ...anchor, description: assertText(`Anchor ${anchor.id} description`, anchor.description) };
  });

  const partIds = new Set<string>();
  for (const part of draft.parts) {
    if (!SAFE_PART_ID.test(part.id) || GENERIC_PART_ID.test(part.id)
      || RESERVED_PART_IDS.has(part.id) || partIds.has(part.id)) {
      throw new Error(`Art Director produced invalid or duplicate part ${part.id}`);
    }
    partIds.add(part.id);
  }

  const ownedFeatureIds = new Set<string>();
  const normalizedOwnership = new Map<string, { readonly featureKind: CanvasFeatureKind; readonly ownedFeatures: ReadonlyArray<string> }>();
  for (const part of draft.parts) {
    const featureKind = part.featureKind ?? defaultFeatureKind(part.compositionRole);
    if (!FEATURE_KINDS.has(featureKind)) throw new Error(`Canvas part ${part.id} has invalid feature kind ${String(featureKind)}`);
    const ownedFeatures = [...new Set(part.ownedFeatures ?? [part.id])];
    if (ownedFeatures.length < 1 || ownedFeatures.length > 8) {
      throw new Error(`Canvas part ${part.id} must own between 1 and 8 semantic features`);
    }
    for (const featureId of ownedFeatures) {
      if (!SAFE_PART_ID.test(featureId) || GENERIC_PART_ID.test(featureId) || ownedFeatureIds.has(featureId)) {
        throw new Error(`Canvas feature ${featureId} must be semantic and owned by exactly one painter`);
      }
      ownedFeatureIds.add(featureId);
    }
    normalizedOwnership.set(part.id, { featureKind, ownedFeatures });
  }

  if (draft.parts[0]?.compositionRole !== "FOUNDATION") {
    throw new Error("The first canvas painter must have composition role FOUNDATION");
  }
  const primaryCount = draft.parts.filter((part) => part.compositionRole === "PRIMARY").length;
  if (primaryCount !== 1) throw new Error(`Canvas plan requires exactly one PRIMARY painter; received ${primaryCount}`);
  const finalRole = draft.parts[draft.parts.length - 1]?.compositionRole;
  if (finalRole !== "DETAIL" && finalRole !== "ACCENT") {
    throw new Error("The last canvas painter must have composition role DETAIL or ACCENT");
  }

  const painterParts: CanvasPainterPlanPart[] = draft.parts.map((part, index) => {
    assertCanvasRegion(part);
    if (!COMPOSITION_ROLES.has(part.compositionRole)) {
      throw new Error(`Canvas part ${part.id} has invalid composition role ${String(part.compositionRole)}`);
    }
    if (!PAINT_MODES.has(part.paintMode)) {
      throw new Error(`Canvas part ${part.id} has invalid paint mode ${String(part.paintMode)}`);
    }
    if (part.compositionRole === "FOUNDATION" && part.paintMode !== "background") {
      throw new Error(`Foundation part ${part.id} must use background paint mode`);
    }
    const { width: footprintWidth, height: footprintHeight } = part.maxFootprint;
    const footprintBleed = part.allowBleed ? 24 : 0;
    if (![footprintWidth, footprintHeight].every(Number.isFinite)
      || footprintWidth < 1 || footprintHeight < 1
      || footprintWidth > 1_000 || footprintHeight > 1_000
      || footprintWidth > part.region.width + footprintBleed
      || footprintHeight > part.region.height + footprintBleed) {
      throw new Error(`Canvas part ${part.id} has an invalid maximum footprint`);
    }
    const ownership = normalizedOwnership.get(part.id)!;
    const roleObjectCeiling = part.compositionRole === "DETAIL" || part.compositionRole === "ACCENT"
      ? CANVAS_MAX_OBJECTS_PER_PAINTER
      : 24;
    if (!Number.isInteger(part.minObjects) || !Number.isInteger(part.maxObjects)
      || part.minObjects < 2 || part.maxObjects > roleObjectCeiling || part.minObjects > part.maxObjects) {
      throw new Error(`Canvas part ${part.id} has invalid object limits`);
    }
    // coordinatesWith is descriptive alignment metadata, never an execution
    // dependency. protectedAnchors is authoritative when a model accidentally
    // places an anchor id here, so invalid peers can be dropped safely.
    const coordinatesWith = [...new Set(part.coordinatesWith)]
      .filter((peer) => peer !== part.id && partIds.has(peer));
    const protectedAnchors = [...new Set(part.protectedAnchors)];
    if (protectedAnchors.length === 0) throw new Error(`Canvas part ${part.id} must protect at least one shared anchor`);
    for (const anchorId of protectedAnchors) {
      if (!anchorIds.has(anchorId)) {
        throw new Error(`Canvas part ${part.id} protects unknown anchor ${anchorId}`);
      }
    }
    return {
      id: part.id,
      role: part.id,
      kind: "painter",
      label: assertText(`Canvas part ${part.id} label`, part.label),
      artistName: assertText(`Canvas part ${part.id} artist name`, part.artistName),
      focus: assertText(`Canvas part ${part.id} focus`, part.focus),
      objective: assertText(`Canvas part ${part.id} objective`, part.objective),
      compositionRole: part.compositionRole,
      paintMode: part.paintMode,
      featureKind: ownership.featureKind,
      ownedFeatures: ownership.ownedFeatures,
      coordinatesWith,
      maxFootprint: { ...part.maxFootprint },
      protectedAnchors,
      allowBleed: part.allowBleed,
      needs: ["prompt", "composition.scaffold"],
      outputKey: `scene.${part.id}`,
      layerBase: index * 100,
      minObjects: part.minObjects,
      maxObjects: part.maxObjects,
      region: { ...part.region },
    };
  });

  const painterOutputs = painterParts.map((part) => part.outputKey);
  const parts: CanvasScenePlan["parts"] = [
    ...painterParts,
    {
      id: "validator-semantic",
      role: "validator-semantic",
      kind: "critic",
      label: "Subject and prompt validation",
      artistName: "Subject Validator",
      focus: "Literal prompt match, subject identity, requested counts, relationships, and recognizability",
      objective: "Independently inspect whether the rendered pixels actually satisfy the user's requested subject.",
      coordinatesWith: [],
      needs: painterOutputs,
      outputKey: "scene.validation.semantic",
      layerBase: 900,
      minObjects: 0,
      maxObjects: 0,
    },
    {
      id: "validator-composition",
      role: "validator-composition",
      kind: "critic",
      label: "Composition validation",
      artistName: "Composition Validator",
      focus: "Hierarchy, balance, focal scale, negative space, overlap, and cross-part composition",
      objective: "Independently inspect whether the parallel patches form one intentional composition.",
      coordinatesWith: [],
      needs: painterOutputs,
      outputKey: "scene.validation.composition",
      layerBase: 910,
      minObjects: 0,
      maxObjects: 0,
    },
    {
      id: "validator-consistency",
      role: "validator-consistency",
      kind: "critic",
      label: "Consistency and finish validation",
      artistName: "Consistency Validator",
      focus: "Contact seams, line weight, lighting, palette, repeated forms, detail density, and finish",
      objective: "Independently find actionable inconsistencies between separately painted parts.",
      coordinatesWith: [],
      needs: painterOutputs,
      outputKey: "scene.validation.consistency",
      layerBase: 920,
      minObjects: 0,
      maxObjects: 0,
    },
    {
      id: "composer",
      role: "composer",
      kind: "composer",
      label: "Final artwork",
      artistName: "Finishing Artist",
      focus: "Targeted visual repairs, canonical composition, and certification",
      objective: "Repair rejected parts, then finish and sign off on the visually accepted artwork.",
      coordinatesWith: [],
      needs: ["scene.review"],
      outputKey: "scene.final",
      layerBase: 1_000,
      minObjects: 0,
      maxObjects: 0,
    },
  ];
  const fallbackScaffoldMarks: ReadonlyArray<CanvasScaffoldMarkDraft> = [
    {
      id: "focal-envelope",
      featureId: painterParts.find((part) => part.compositionRole === "PRIMARY")!.ownedFeatures[0]!,
      type: "rect",
      geometry: { x: draft.focalBounds.x, y: draft.focalBounds.y, width: draft.focalBounds.width, height: draft.focalBounds.height },
      style: { fill: "none", stroke: draft.palette.ink, strokeWidth: 6, opacity: .55 },
      layer: 100,
      rank: 0,
    },
    ...anchors.map((anchor, index): CanvasScaffoldMarkDraft => ({
      id: `anchor-${anchor.id}`,
      featureId: painterParts.find((part) => part.protectedAnchors.includes(anchor.id))?.ownedFeatures[0]
        ?? painterParts[0]!.ownedFeatures[0]!,
      type: "circle",
      geometry: { cx: anchor.x, cy: anchor.y, r: 10 },
      style: { fill: draft.palette.highlight, stroke: draft.palette.ink, strokeWidth: 3, opacity: .7 },
      layer: 110,
      rank: index + 1,
    })),
  ];
  const scaffoldDraft = draft.compositionScaffold ?? {
    summary: "Fallback focal envelope and shared attachment anchors.",
    marks: fallbackScaffoldMarks,
  };
  const scaffoldIds = new Set<string>();
  const scaffoldMarks = scaffoldDraft.marks.map((mark) => {
    if (!SAFE_PART_ID.test(mark.id) || scaffoldIds.has(mark.id)) {
      throw new Error(`Composition scaffold has invalid or duplicate mark ${mark.id}`);
    }
    if (!ownedFeatureIds.has(mark.featureId)) {
      throw new Error(`Composition scaffold mark ${mark.id} targets unowned feature ${mark.featureId}`);
    }
    if (typeof mark.style.fill !== "string" || !SAFE_COLOR.test(mark.style.fill) || !SAFE_COLOR.test(mark.style.stroke)) {
      throw new Error(`Composition scaffold mark ${mark.id} uses an invalid color`);
    }
    const normalizedMark = normalizeCanvasObject({
      id: `scaffold.${mark.id}`,
      semanticId: `scaffold.${mark.featureId}.${mark.id}`,
      ownerAgentId: "orchestrator",
      taskId: "composition.scaffold",
      partId: "composition-scaffold",
      type: mark.type,
      geometry: mark.geometry,
      style: mark.style,
      layer: mark.layer,
      rank: mark.rank,
    });
    scaffoldIds.add(mark.id);
    return {
      id: mark.id,
      featureId: mark.featureId,
      type: mark.type,
      geometry: normalizedMark.geometry,
      style: normalizedMark.style,
      layer: normalizedMark.layer,
      rank: normalizedMark.rank,
    };
  });
  if (scaffoldMarks.length < 3 || scaffoldMarks.length > 24) {
    throw new Error(`Composition scaffold must contain between 3 and 24 marks`);
  }
  const primaryFeatureIds = new Set(painterParts
    .filter((part) => part.compositionRole === "PRIMARY")
    .flatMap((part) => part.ownedFeatures));
  if (!scaffoldMarks.some((mark) => primaryFeatureIds.has(mark.featureId))) {
    throw new Error("Composition scaffold must block out the PRIMARY feature");
  }
  const scaffoldSummary = assertText("Composition scaffold summary", scaffoldDraft.summary);
  const compositionScaffold = {
    scaffoldVersion: `canvas-scaffold-${hashCanonical({ summary: scaffoldSummary, marks: scaffoldMarks }).slice(0, 20)}`,
    summary: scaffoldSummary,
    marks: scaffoldMarks,
  };
  const normalized = {
    schemaVersion: 3 as const,
    width: 1_000,
    height: 1_000,
    painterCount: expectedPainterCount,
    subject: assertText("Planned subject", draft.subject),
    artDirection: assertText("Art direction", draft.artDirection),
    compositionScaffold,
    focalBounds: {
      ...draft.focalBounds,
      description: assertText("Focal bounds description", draft.focalBounds.description),
    },
    anchors,
    palette: { ...draft.palette },
    parts,
  };
  return {
    ...normalized,
    planVersion: `canvas-plan-${hashCanonical({ brief, ...normalized }).slice(0, 20)}`,
  };
};

export const canvasPainterParts = (plan: CanvasScenePlan): ReadonlyArray<CanvasPainterPlanPart> =>
  plan.parts.filter((part): part is CanvasPainterPlanPart => part.kind === "painter");

export const deriveCanvasNodeDemands = (plan: CanvasScenePlan): ReadonlyArray<CanvasNodeDemand> =>
  plan.parts.map((part) => ({
    role: part.role,
    capability: part.kind === "painter" ? `compose.${part.id}`
      : part.kind === "critic" ? `critique.${part.role.replace(/^validator-/, "")}`
        : "compose.final",
    name: part.artistName,
    nameSource: "planner",
    objective: part.objective,
    focus: part.focus,
    promptProfile: part.kind === "painter" ? "canvas-artist" : part.kind,
    group: part.kind === "painter" ? "Studio artists" : part.kind === "critic" ? "Review" : "Finishing",
    metadata: part.kind === "painter"
      ? ({
          role: part.role,
          partId: part.id,
          kind: part.kind,
          featureKind: part.featureKind,
          ownedFeatures: [...part.ownedFeatures],
          scaffoldVersion: plan.compositionScaffold.scaffoldVersion,
        } as Readonly<Record<string, JsonValue>>)
      : ({ role: part.role, partId: part.id, kind: part.kind } as Readonly<Record<string, JsonValue>>),
  }));

export const defineCanvasRoster = (
  maxParallel: number,
  demands: ReadonlyArray<CanvasNodeDemand> = [],
  maxNodes = 16
): { readonly pack: DomainPack; readonly registry: DomainRegistry } => {
  const capabilityDescriptions = new Map<string, string>([
    ["coordinate", "Interpret a visual brief and control the shared scene frontier."],
  ]);
  for (const demand of demands) capabilityDescriptions.set(demand.capability, demand.objective);
  const registry = createDomainRegistry({
    id: "canvas",
    version: "3.0",
    policyVersion: "canvas-illustration-v3",
    coordinatorId: "orchestrator",
    capabilities: [...capabilityDescriptions].map(([id, description]) => ({ id, description })),
    nodes: [{
      id: "orchestrator",
      name: "Art Director",
      capabilities: ["coordinate"],
      promptProfile: "art-director",
      runtime: rosterNativeRuntime("canvas.art-director"),
      metadata: { role: "coordinator", group: "Direction", focus: "Prompt interpretation and scene contract" },
    }],
    limits: {
      maxNodes: Math.max(8, demands.length + 1, Math.floor(maxNodes)),
      maxTasks: 128,
      maxParallel: Math.max(1, Math.floor(maxParallel)),
      maxDepth: 5,
    },
  });
  return { pack: registry.pack, registry };
};

export const canvasAdaptiveDomain = (
  maxParallel: number,
  demands: ReadonlyArray<CanvasNodeDemand> = [],
  maxNodes = 16
): { readonly pack: DomainPack; readonly registry: DomainRegistry } => {
  return defineCanvasRoster(maxParallel, demands, maxNodes);
};

export const materializeCanvasNode = (input: {
  readonly runId: string;
  readonly reflectionId: string;
  readonly index: number;
  readonly demand: CanvasNodeDemand;
  readonly runtime?: WorkspaceNodeRuntime;
}): CanvasNodeSpec => {
  const created = materializeNodeDemand({ ...input, coordinatorId: "orchestrator" });
  return {
    ...created,
    ...(input.runtime ? { runtime: input.runtime } : {}),
    role: input.demand.role,
    focus: input.demand.focus ?? input.demand.objective,
    metadata: { ...(created.metadata ?? {}), role: input.demand.role },
  };
};

const safeSlug = (value: string, fallback: string): string => {
  const slug = value.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 64);
  return slug || fallback;
};

const hexRgb = (value: string): readonly [number, number, number] | undefined => {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match?.[1]) return undefined;
  const encoded = match[1];
  return [
    Number.parseInt(encoded.slice(0, 2), 16),
    Number.parseInt(encoded.slice(2, 4), 16),
    Number.parseInt(encoded.slice(4, 6), 16),
  ];
};

const relativeLuminance = (rgb: readonly [number, number, number]): number => {
  const channels = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
  });
  return .2126 * (channels[0] ?? 0) + .7152 * (channels[1] ?? 0) + .0722 * (channels[2] ?? 0);
};

const effectiveContrast = (foreground: string, background: string, opacity: number): number => {
  const fg = hexRgb(foreground);
  const bg = hexRgb(background);
  if (!fg || !bg) return 0;
  const alpha = Math.max(0, Math.min(1, opacity));
  const composite: readonly [number, number, number] = [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
  const lighter = Math.max(relativeLuminance(composite), relativeLuminance(bg));
  const darker = Math.min(relativeLuminance(composite), relativeLuminance(bg));
  return (lighter + .05) / (darker + .05);
};

type PrimitiveBounds = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

type PrimitiveDraft = {
  readonly name: string;
  readonly type: Exclude<CanvasObjectType, "group">;
  readonly geometry: Readonly<Record<string, CanvasGeometryValue>>;
  readonly style: { readonly stroke: string; readonly strokeWidth: number };
};

const geometryNumber = (draft: PrimitiveDraft, key: string): number => {
  const value = draft.geometry[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${draft.name} has invalid ${key} geometry`);
  }
  return value;
};

const primitiveBounds = (draft: PrimitiveDraft): PrimitiveBounds | undefined => {
  if (draft.type === "path") {
    const bounds = canvasSvgPathBounds(String(draft.geometry.d ?? ""));
    const strokePad = draft.style.stroke === "none" ? 0 : Math.max(0, draft.style.strokeWidth) / 2;
    return {
      minX: bounds.minX - strokePad,
      minY: bounds.minY - strokePad,
      maxX: bounds.maxX + strokePad,
      maxY: bounds.maxY + strokePad,
    };
  }
  const strokePad = draft.style.stroke === "none" ? 0 : Math.max(0, draft.style.strokeWidth) / 2;
  const padded = (minX: number, minY: number, maxX: number, maxY: number): PrimitiveBounds => ({
    minX: minX - strokePad,
    minY: minY - strokePad,
    maxX: maxX + strokePad,
    maxY: maxY + strokePad,
  });
  switch (draft.type) {
    case "rect": {
      const x = geometryNumber(draft, "x");
      const y = geometryNumber(draft, "y");
      const width = geometryNumber(draft, "width");
      const height = geometryNumber(draft, "height");
      if (width <= 0 || height <= 0) throw new Error(`${draft.name} has a non-positive rectangle size`);
      const rx = draft.geometry.rx;
      const ry = draft.geometry.ry;
      if ((rx !== undefined && (typeof rx !== "number" || rx < 0 || rx > width / 2))
        || (ry !== undefined && (typeof ry !== "number" || ry < 0 || ry > height / 2))) {
        throw new Error(`${draft.name} has an invalid rounded rectangle radius`);
      }
      return padded(x, y, x + width, y + height);
    }
    case "circle": {
      const cx = geometryNumber(draft, "cx");
      const cy = geometryNumber(draft, "cy");
      const radius = geometryNumber(draft, "r");
      if (radius <= 0) throw new Error(`${draft.name} has a non-positive circle radius`);
      return padded(cx - radius, cy - radius, cx + radius, cy + radius);
    }
    case "ellipse": {
      const cx = geometryNumber(draft, "cx");
      const cy = geometryNumber(draft, "cy");
      const rx = geometryNumber(draft, "rx");
      const ry = geometryNumber(draft, "ry");
      if (rx <= 0 || ry <= 0) throw new Error(`${draft.name} has a non-positive ellipse radius`);
      return padded(cx - rx, cy - ry, cx + rx, cy + ry);
    }
    case "line": {
      const x1 = geometryNumber(draft, "x1");
      const y1 = geometryNumber(draft, "y1");
      const x2 = geometryNumber(draft, "x2");
      const y2 = geometryNumber(draft, "y2");
      return padded(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2));
    }
    case "polygon":
    case "polyline": {
      const raw = draft.geometry.points;
      if (!Array.isArray(raw) || raw.length < 6 || raw.length % 2 !== 0
        || raw.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))) {
        throw new Error(`${draft.name} has invalid polygon points`);
      }
      const xs = raw.filter((_coordinate, index) => index % 2 === 0);
      const ys = raw.filter((_coordinate, index) => index % 2 === 1);
      return padded(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    }
  }
};

const validatePainterDraftGeometry = (
  part: CanvasPainterPlanPart,
  drafts: ReadonlyArray<CanvasObjectDraft>,
  canvasBackground: string
): void => {
  const bleed = part.allowBleed ? 24 : 0;
  let footprint: PrimitiveBounds | undefined;
  for (const draft of drafts) {
    const rawBounds = primitiveBounds(draft);
    if (!rawBounds) continue;
    // Background overscan is clipped by the 1000×1000 SVG viewport and avoids
    // antialiased seams at the edge. It is safe only for the foundation layer;
    // every focal/detail mode remains constrained to its planned region.
    const bounds = part.paintMode === "background"
      ? {
          minX: Math.max(0, rawBounds.minX),
          minY: Math.max(0, rawBounds.minY),
          maxX: Math.min(1_000, rawBounds.maxX),
          maxY: Math.min(1_000, rawBounds.maxY),
        }
      : rawBounds;
    // SVG strokes are centered on their geometry. Permit only that bounded
    // half-stroke at an envelope edge; the underlying geometry must still be
    // inside the assigned region (plus explicit bleed).
    const strokeEdge = draft.style.stroke === "none"
      ? 0
      : Math.min(40, Math.max(0, draft.style.strokeWidth) / 2);
    const minX = part.region.x - bleed - strokeEdge;
    const minY = part.region.y - bleed - strokeEdge;
    const maxX = part.region.x + part.region.width + bleed + strokeEdge;
    const maxY = part.region.y + part.region.height + bleed + strokeEdge;
    if (bounds.minX < minX || bounds.minY < minY || bounds.maxX > maxX || bounds.maxY > maxY) {
      throw new Error(
        `${draft.name} leaves the assigned region for ${part.id}${part.allowBleed ? " beyond the 24 pixel bleed" : ""}; `
        + `mark bounds x=${bounds.minX.toFixed(1)}..${bounds.maxX.toFixed(1)}, y=${bounds.minY.toFixed(1)}..${bounds.maxY.toFixed(1)}; `
        + `allowed including centered stroke x=${minX.toFixed(1)}..${maxX.toFixed(1)}, y=${minY.toFixed(1)}..${maxY.toFixed(1)}`
      );
    }
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const broad = width > 250 || height > 250;
    if (part.paintMode === "transparent-shell" && broad
      && draft.style.fill !== "none" && draft.style.opacity > .22) {
      throw new Error(`${draft.name} is a broad transparent-shell fill with opacity above 0.22`);
    }
    if ((part.paintMode === "linework" || part.paintMode === "accent") && broad
      && draft.style.fill !== "none" && draft.style.opacity > .35) {
      throw new Error(`${draft.name} is a broad ${part.paintMode} fill with opacity above 0.35`);
    }
    footprint = footprint
      ? {
          minX: Math.min(footprint.minX, bounds.minX),
          minY: Math.min(footprint.minY, bounds.minY),
          maxX: Math.max(footprint.maxX, bounds.maxX),
          maxY: Math.max(footprint.maxY, bounds.maxY),
        }
      : bounds;
  }
  if (footprint && (
    footprint.maxX - footprint.minX > part.maxFootprint.width
    || footprint.maxY - footprint.minY > part.maxFootprint.height
  )) {
    throw new Error(`Canvas part ${part.id} exceeds its ${part.maxFootprint.width} by ${part.maxFootprint.height} maximum footprint`);
  }
  if (part.paintMode === "transparent-shell") {
    const hasReadableContour = drafts.some((draft) =>
      draft.style.fill === "none"
      && draft.style.stroke !== "none"
      && draft.style.strokeWidth >= 4
      && draft.style.strokeWidth <= 14
      && draft.style.opacity >= .5
      && effectiveContrast(draft.style.stroke, canvasBackground, draft.style.opacity) >= 1.8
    );
    if (!hasReadableContour) {
      throw new Error(
        `Canvas part ${part.id} needs an unfilled 4–14 pixel shell contour with opacity at least 0.5 and effective contrast at least 1.8`
      );
    }
  }
};

export const createCanvasPatchForPart = (input: {
  readonly runId: string;
  readonly plan: CanvasScenePlan;
  readonly part: CanvasPlanPart;
  readonly agentId: string;
  readonly taskId: string;
  readonly baseSceneHash: string;
  readonly supersedesPatchId?: string;
  readonly objects: ReadonlyArray<CanvasObjectDraft>;
}): CanvasPatch => {
  if (input.part.kind !== "painter") throw new Error(`Canvas part ${input.part.id} is not paintable`);
  const drafts = input.objects.slice(0, input.part.maxObjects);
  if (drafts.length < input.part.minObjects) {
    throw new Error(`${input.part.artistName} returned ${drafts.length} objects; ${input.part.minObjects} required`);
  }
  validatePainterDraftGeometry(input.part, drafts, input.plan.palette.background);
  const subject = safeSlug(input.plan.subject, "subject");
  const objects = drafts.map((draft, index): CanvasObject => normalizeCanvasObject({
    id: `${input.part.id}.${safeSlug(draft.name, `mark.${index + 1}`)}.${index + 1}`,
    semanticId: `${subject}.${input.part.id}.${safeSlug(draft.semanticKey, `mark.${index + 1}`)}`,
    ownerAgentId: input.agentId,
    taskId: input.taskId,
    partId: input.part.id,
    type: draft.type,
    geometry: { ...draft.geometry },
      style: {
        fill: draft.style.fill,
        stroke: draft.style.stroke,
        strokeWidth: draft.style.strokeWidth,
        opacity: draft.style.opacity,
        ...(draft.style.fillOpacity !== undefined ? { fillOpacity: draft.style.fillOpacity } : {}),
        ...(draft.style.strokeOpacity !== undefined ? { strokeOpacity: draft.style.strokeOpacity } : {}),
        strokeLinecap: draft.style.strokeLinecap ?? "round",
        strokeLinejoin: draft.style.strokeLinejoin ?? "round",
        ...(draft.style.strokeDasharray ? { strokeDasharray: [...draft.style.strokeDasharray] } : {}),
      },
    layer: input.part.layerBase + Math.max(0, Math.min(99, Math.floor(draft.layerOffset))),
    rank: Math.max(0, Math.min(1_000_000, Math.floor(draft.rank))),
  }));
  return createCanvasPatch({
    runId: input.runId,
    planVersion: input.plan.planVersion,
    baseSceneHash: input.baseSceneHash,
    supersedesPatchId: input.supersedesPatchId,
    agentId: input.agentId,
    taskId: input.taskId,
    partId: input.part.id,
    objects,
  });
};

export const validateCanvasScene = (
  plan: CanvasScenePlan,
  objects: ReadonlyArray<CanvasObject>,
  conflicts: ReadonlyArray<CanvasSceneConflict> = []
): CanvasReview => {
  const notes: string[] = [];
  if (objects.length > CANVAS_MAX_SCENE_OBJECTS) {
    notes.push(`Scene has ${objects.length} objects; ${CANVAS_MAX_SCENE_OBJECTS} allowed`);
  }
  for (const object of objects) {
    try {
      normalizeCanvasObject(object);
    } catch (error) {
      notes.push(error instanceof Error ? error.message : String(error));
    }
  }
  const painterParts = canvasPainterParts(plan);
  const partIds = new Set(painterParts.map((part) => part.id));
  for (const object of objects) {
    const part = painterParts.find((candidate) => candidate.id === object.partId);
    if (!part) {
      notes.push(`Object ${object.id} belongs to unplanned part ${object.partId}`);
      continue;
    }
    if (object.layer < part.layerBase || object.layer > part.layerBase + 99) {
      notes.push(`Object ${object.id} crosses the layer boundary for ${part.id}`);
    }
  }
  for (const part of painterParts) {
    const count = objects.filter((object) => object.partId === part.id).length;
    if (count < part.minObjects) notes.push(`Part ${part.id} has ${count} objects; ${part.minObjects} required`);
    if (count > part.maxObjects) notes.push(`Part ${part.id} has ${count} objects; ${part.maxObjects} allowed`);
  }
  if (partIds.size !== painterParts.length) notes.push("Scene plan contains duplicate painter parts");
  if (conflicts.length > 0) notes.push(`${conflicts.length} Yjs scene conflict(s) remain`);
  return {
    verdict: notes.length === 0 ? "pass" : "fail",
    scope: "structural",
    checks: [
      `${objects.length} constrained SVG objects passed the supported primitive contract`,
      `${painterParts.length} prompt-derived artist parts published their required marks`,
      "Every object remains inside its artist, task, and layer ownership boundary",
      "No concurrent Yjs candidate conflicts remain",
    ],
    notes,
  };
};

export { canonicalCanvasScene, canvasSceneHash as sceneHash };
