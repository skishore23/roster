import { hashCanonical } from "../core/canonical.js";
import type { Decide, Reducer } from "../core/types.js";
import type { CanvasObject, CanvasPatch } from "../engine/visual/scene.js";
import { normalizeCanvasObject, normalizeCanvasPatch } from "../engine/visual/scene.js";
import type { OrchestrationEvent, OrchestrationState } from "./orchestration.js";
import { initialOrchestrationState, isOrchestrationEvent, reduceOrchestration } from "./orchestration.js";

export type { CanvasObject, CanvasPatch } from "../engine/visual/scene.js";

export type CanvasCompositionRole = "FOUNDATION" | "PRIMARY" | "SECONDARY" | "DETAIL" | "ACCENT";
export type CanvasPaintMode = "background" | "solid" | "transparent-shell" | "linework" | "accent";
export type CanvasFeatureKind =
  | "environment"
  | "primary-subject"
  | "secondary-subject"
  | "structure"
  | "material-detail"
  | "foreground-contact"
  | "lighting-accent";

export const CANVAS_MIN_PAINTERS = 3;
export const CANVAS_MAX_PAINTERS = 8;
export const CANVAS_MAX_OBJECTS_PER_PAINTER = 32;
export const CANVAS_MAX_SCENE_OBJECTS = CANVAS_MAX_PAINTERS * CANVAS_MAX_OBJECTS_PER_PAINTER;

/** Models are routed by studio responsibility instead of being shared blindly. */
export type CanvasModelRouting = {
  readonly director: string;
  readonly painter: string;
  readonly critic: string;
  readonly finisher: string;
  readonly finisherEscalation: string;
};

export type CanvasBounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type CanvasScaffoldMark = {
  readonly id: string;
  /** Semantic feature owned by exactly one painter part. */
  readonly featureId: string;
  readonly type: Exclude<CanvasObject["type"], "group">;
  readonly geometry: CanvasObject["geometry"];
  readonly style: CanvasObject["style"];
  readonly layer: number;
  readonly rank: number;
};

export type CanvasCompositionScaffold = {
  readonly scaffoldVersion: string;
  readonly summary: string;
  /** Low-detail shared geometry used for composition, scale, and attachment alignment. */
  readonly marks: ReadonlyArray<CanvasScaffoldMark>;
};

type CanvasPlanPartBase = {
  readonly id: string;
  readonly role: string;
  readonly label: string;
  readonly artistName: string;
  readonly focus: string;
  readonly objective: string;
  /** Other painters whose composition contract shares anchors with this part. */
  readonly coordinatesWith: ReadonlyArray<string>;
  readonly needs: ReadonlyArray<string>;
  readonly outputKey: string;
  readonly layerBase: number;
  readonly minObjects: number;
  readonly maxObjects: number;
};

export type CanvasPainterPlanPart = CanvasPlanPartBase & {
  readonly kind: "painter";
  readonly compositionRole: CanvasCompositionRole;
  readonly paintMode: CanvasPaintMode;
  readonly featureKind: CanvasFeatureKind;
  /** Features are exclusive semantic ownership boundaries; regions are only working envelopes. */
  readonly ownedFeatures: ReadonlyArray<string>;
  readonly maxFootprint: { readonly width: number; readonly height: number };
  readonly protectedAnchors: ReadonlyArray<string>;
  readonly allowBleed: boolean;
  readonly region: CanvasBounds;
};

type CanvasFinishingPlanPart = CanvasPlanPartBase & {
  readonly kind: "critic" | "composer";
  readonly compositionRole?: undefined;
  readonly paintMode?: undefined;
  readonly maxFootprint?: undefined;
  readonly protectedAnchors?: undefined;
  readonly allowBleed?: undefined;
  readonly region?: undefined;
};

export type CanvasPlanPart = CanvasPainterPlanPart | CanvasFinishingPlanPart;

export type CanvasScenePlan = {
  readonly schemaVersion: 3;
  readonly planVersion: string;
  readonly width: number;
  readonly height: number;
  /** Exact number of painters requested for this run. */
  readonly painterCount: number;
  readonly subject: string;
  readonly artDirection: string;
  readonly compositionScaffold: CanvasCompositionScaffold;
  readonly focalBounds: CanvasBounds & { readonly description: string };
  readonly anchors: ReadonlyArray<{
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly description: string;
  }>;
  readonly palette: {
    readonly background: string;
    readonly primary: string;
    readonly secondary: string;
    readonly highlight: string;
    readonly ink: string;
    readonly focal: string;
    readonly accent: string;
    readonly glow: string;
  };
  readonly parts: ReadonlyArray<CanvasPlanPart>;
};

export type CanvasReview = {
  readonly verdict: "pass" | "fail";
  readonly qualityStatus?: "certified" | "accepted-with-notes";
  readonly scope:
    | "structural"
    | "rendered-visual"
    | "validator-semantic"
    | "validator-composition"
    | "validator-consistency";
  readonly scores?: {
    readonly promptMatch: number;
    readonly recognizability: number;
    readonly composition: number;
    readonly coherence: number;
    readonly polish: number;
  };
  readonly checks: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
};

export type CanvasFailure = {
  readonly class:
    | "contract"
    | "authentication"
    | "authorization"
    | "budget"
    | "rate-limit"
    | "timeout"
    | "provider-uncertain"
    | "provider"
    | "unknown";
  readonly retryable: boolean;
};

export type CanvasEvent =
  | OrchestrationEvent
  | {
      readonly type: "prompt.set";
      readonly runId: string;
      readonly prompt: string;
      readonly agentId: string;
    }
  | {
      readonly type: "run.configured";
      readonly runId: string;
      readonly agentId: string;
      readonly models: CanvasModelRouting;
      readonly promptHash?: string;
      readonly promptPath?: string;
      readonly config: { readonly maxParallel: number; readonly staggerMs: number };
      readonly workflow: { readonly id: string; readonly version: string };
    }
  | {
      readonly type: "run.status";
      readonly runId: string;
      readonly agentId: string;
      readonly status: "planning" | "running" | "reviewing" | "completed" | "failed";
      readonly note?: string;
      readonly failure?: CanvasFailure;
    }
  | {
      readonly type: "scene.planned";
      readonly runId: string;
      readonly agentId: string;
      readonly plan: CanvasScenePlan;
    }
  | {
      readonly type: "scene.patch.applied";
      readonly runId: string;
      readonly agentId: string;
      readonly patch: CanvasPatch;
      readonly updateHash: string;
    }
  | {
      readonly type: "scene.reviewed";
      readonly runId: string;
      readonly agentId: string;
      readonly review: CanvasReview;
      readonly sceneHash: string;
    }
  | {
      readonly type: "scene.finalized";
      readonly runId: string;
      readonly agentId: string;
      readonly sceneHash: string;
      readonly objectCount: number;
      readonly content: string;
    };

export type CanvasCmd = {
  readonly type: "emit";
  readonly event: CanvasEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type CanvasState = {
  readonly runId?: string;
  readonly prompt: string;
  readonly status: "idle" | "planning" | "running" | "reviewing" | "completed" | "failed";
  readonly statusNote?: string;
  readonly failure?: CanvasFailure;
  readonly config?: {
    readonly models: CanvasModelRouting;
    readonly promptHash?: string;
    readonly promptPath?: string;
    readonly maxParallel: number;
    readonly staggerMs: number;
    readonly workflowId: string;
    readonly workflowVersion: string;
    readonly updatedAt: number;
  };
  readonly plan?: CanvasScenePlan;
  readonly patches: Readonly<Record<string, CanvasPatch & { readonly updatedAt: number }>>;
  readonly objects: Readonly<Record<string, CanvasObject & { readonly updatedAt: number }>>;
  readonly review?: CanvasReview & { readonly sceneHash: string; readonly updatedAt: number };
  readonly final?: { readonly sceneHash: string; readonly objectCount: number; readonly content: string; readonly updatedAt: number };
  readonly orchestration: OrchestrationState;
};

export const initialCanvas: CanvasState = {
  prompt: "",
  status: "idle",
  patches: {},
  objects: {},
  orchestration: initialOrchestrationState,
};

export const decideCanvas: Decide<CanvasCmd, CanvasEvent> = (command) => [command.event];

export const reduceCanvas: Reducer<CanvasState, CanvasEvent> = (state, event, ts) => {
  if (isOrchestrationEvent(event)) {
    return { ...state, orchestration: reduceOrchestration(state.orchestration, event, ts) };
  }
  switch (event.type) {
    case "prompt.set":
      return {
        ...initialCanvas,
        runId: event.runId,
        prompt: event.prompt,
        status: "planning",
      };
    case "run.configured":
      return {
        ...state,
        runId: event.runId,
        config: {
          models: { ...event.models },
          promptHash: event.promptHash,
          promptPath: event.promptPath,
          maxParallel: event.config.maxParallel,
          staggerMs: event.config.staggerMs,
          workflowId: event.workflow.id,
          workflowVersion: event.workflow.version,
          updatedAt: ts,
        },
      };
    case "run.status":
      return {
        ...state,
        status: event.status,
        statusNote: event.note ?? state.statusNote,
        failure: event.status === "failed" ? event.failure : undefined,
      };
    case "scene.planned":
      if (event.plan.width !== 1_000 || event.plan.height !== 1_000) {
        throw new Error("Canvas scene plan must use the 1000 by 1000 coordinate space");
      }
      return { ...state, plan: event.plan, status: "running" };
    case "scene.patch.applied": {
      const patch = normalizeCanvasPatch(event.patch);
      if (patch.runId !== event.runId || patch.agentId !== event.agentId) {
        throw new Error(`Patch ${patch.patchId} does not match its receipt authority`);
      }
      const existingPatch = state.patches[patch.patchId];
      if (existingPatch) {
        const { updatedAt: _updatedAt, ...existing } = existingPatch;
        if (hashCanonical(existing) !== hashCanonical(patch)) {
          throw new Error(`Patch ${patch.patchId} changed after publication`);
        }
        return state;
      }
      const patches = { ...state.patches };
      if (patch.supersedesPatchId) {
        const parent = patches[patch.supersedesPatchId];
        if (!parent) throw new Error(`Patch ${patch.patchId} supersedes unknown patch ${patch.supersedesPatchId}`);
        if (parent.runId !== patch.runId || parent.planVersion !== patch.planVersion || parent.partId !== patch.partId) {
          throw new Error(`Patch ${patch.patchId} crosses the revision boundary for ${patch.partId}`);
        }
        const competing = Object.values(patches).find((candidate) =>
          candidate.supersedesPatchId === patch.supersedesPatchId && candidate.patchId !== patch.patchId
        );
        if (competing) throw new Error(`Patch ${patch.patchId} competes with revision ${competing.patchId}`);
      }
      const objects = { ...state.objects };
      if (patch.supersedesPatchId) {
        for (const object of patches[patch.supersedesPatchId]!.objects) delete objects[object.id];
      }
      for (const candidate of patch.objects.map(normalizeCanvasObject)) {
        const existingObject = objects[candidate.id];
        if (existingObject) {
          const { updatedAt: _updatedAt, ...existing } = existingObject;
          if (hashCanonical(existing) !== hashCanonical(candidate)) {
            throw new Error(`Canvas object ${candidate.id} has divergent owners or geometry`);
          }
          continue;
        }
        objects[candidate.id] = { ...candidate, updatedAt: ts };
      }
      return {
        ...state,
        status: "running",
        review: undefined,
        final: undefined,
        patches: { ...patches, [patch.patchId]: { ...patch, updatedAt: ts } },
        objects,
      };
    }
    case "scene.reviewed":
      return {
        ...state,
        status: "reviewing",
        review: { ...event.review, sceneHash: event.sceneHash, updatedAt: ts },
      };
    case "scene.finalized":
      if (state.review?.verdict !== "pass" || state.review.sceneHash !== event.sceneHash) {
        throw new Error("Canvas scene cannot finalize without passing review of the same scene hash");
      }
      if (event.objectCount !== Object.keys(state.objects).length) {
        throw new Error("Canvas final object count does not match the projected scene");
      }
      return {
        ...state,
        status: "completed",
        statusNote: state.review.qualityStatus === "accepted-with-notes"
          ? "Scene completed with visual notes after the bounded finishing passes."
          : "Scene certified against the complete visual frontier.",
        final: {
          sceneHash: event.sceneHash,
          objectCount: event.objectCount,
          content: event.content,
          updatedAt: ts,
        },
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
};

export const initial = initialCanvas;
export const decide = decideCanvas;
export const reduce = reduceCanvas;
