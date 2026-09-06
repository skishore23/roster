import { z } from "zod";
import sharp from "sharp";

import type { LlmStructured, LlmStructuredOptions } from "../adapters/openai.js";
import { hashCanonical } from "../core/canonical.js";
import {
  defineModelEscalationPolicy,
  executeModelEscalation,
  type ModelEscalationBudget,
} from "../engine/runtime/model-escalation.js";
import type { DistributedControlAction } from "../engine/orchestration/distributed-control.js";
import {
  createCanvasPatchForPart,
  createCanvasScenePlan,
  type CanvasObjectDraft,
  type CanvasScaffoldMarkDraft,
  type CanvasScenePlanDraft,
} from "../domains/canvas.js";
import type { CanvasGradient, CanvasObject, CanvasPatch } from "../engine/visual/scene.js";
import { CANVAS_MAX_OBJECTS_PER_PAINTER, CANVAS_MAX_PAINTERS, CANVAS_MIN_PAINTERS } from "../modules/canvas.js";
import type { CanvasModelRouting, CanvasPainterPlanPart, CanvasScenePlan } from "../modules/canvas.js";
import { renderCanvasPrompt, type CanvasPromptConfig } from "../prompts/canvas.js";

export const CANVAS_RECOMMENDED_MODELS: CanvasModelRouting = Object.freeze({
  director: "gpt-5.6-terra",
  painter: "gpt-5.6-luna",
  critic: "gpt-5.6-terra",
  finisher: "gpt-5.6-luna",
  finisherEscalation: "gpt-5.6-terra",
});

/**
 * CANVAS_MODEL pins the whole studio to one model.
 * A role-specific variable takes precedence, making quality/cost experiments
 * possible without code edits.
 */
export const resolveCanvasModelRouting = (
  env: Readonly<Record<string, string | undefined>> = process.env
): CanvasModelRouting => {
  const shared = env.CANVAS_MODEL?.trim();
  const resolve = (key: string, recommended: string): string =>
    env[key]?.trim() || shared || recommended;
  return {
    director: resolve("CANVAS_DIRECTOR_MODEL", CANVAS_RECOMMENDED_MODELS.director),
    painter: resolve("CANVAS_PAINTER_MODEL", CANVAS_RECOMMENDED_MODELS.painter),
    critic: resolve("CANVAS_CRITIC_MODEL", CANVAS_RECOMMENDED_MODELS.critic),
    finisher: resolve("CANVAS_FINISHER_MODEL", CANVAS_RECOMMENDED_MODELS.finisher),
    finisherEscalation: resolve(
      "CANVAS_FINISHER_ESCALATION_MODEL",
      CANVAS_RECOMMENDED_MODELS.finisherEscalation
    ),
  };
};

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/).max(31);
const semanticPartIdSchema = idSchema.refine(
  (value) => !/^(?:p|part|artist|layer)-?\d+$/.test(value),
  "Use a semantic part id such as sky-foundation or glass-city, never p1 or part-2"
);
const colorSchema = z.string().regex(/^(?:none|#[0-9a-fA-F]{6})$/);
const coordinateSchema = z.number().min(-100).max(1_100);
const canvasCoordinateSchema = z.number().min(0).max(1_000);
const featureKindSchema = z.enum([
  "environment", "primary-subject", "secondary-subject", "structure",
  "material-detail", "foreground-contact", "lighting-accent",
]);
const gradientStopSchema = z.object({
  offset: z.number().min(0).max(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  opacity: z.number().min(0).max(1),
}).strict();
// Keep this provider schema flat: nested oneOf/discriminated unions are not
// accepted by every Responses structured-output endpoint. Kind-specific
// coordinates are normalized and checked again at the trusted model boundary.
const gradientSchema = z.object({
  kind: z.enum(["linear-gradient", "radial-gradient"]),
  x1: z.number().min(0).max(1).nullable(),
  y1: z.number().min(0).max(1).nullable(),
  x2: z.number().min(0).max(1).nullable(),
  y2: z.number().min(0).max(1).nullable(),
  cx: z.number().min(0).max(1).nullable(),
  cy: z.number().min(0).max(1).nullable(),
  r: z.number().min(0.01).max(1).nullable(),
  stops: z.array(gradientStopSchema).min(2).max(4),
}).strict();

const regionSchema = z.object({
  x: canvasCoordinateSchema,
  y: canvasCoordinateSchema,
  width: z.number().min(1).max(1_000),
  height: z.number().min(1).max(1_000),
}).strict();

const footprintSchema = z.object({
  width: z.number().min(1).max(1_000),
  height: z.number().min(1).max(1_000),
}).strict();

export const canvasScenePlanDraftSchema = z.object({
  subject: z.string().min(1).max(160),
  artDirection: z.string().min(1).max(2_000),
  focalBounds: regionSchema.extend({
    description: z.string().min(1).max(400),
  }).strict(),
  anchors: z.array(z.object({
    id: idSchema,
    x: canvasCoordinateSchema,
    y: canvasCoordinateSchema,
    description: z.string().min(1).max(220),
  }).strict()).min(2).max(8),
  palette: z.object({
    background: colorSchema,
    primary: colorSchema,
    secondary: colorSchema,
    highlight: colorSchema,
    ink: colorSchema,
    focal: colorSchema,
    accent: colorSchema,
    glow: colorSchema,
  }).strict(),
  compositionScaffold: z.object({
    summary: z.string().min(1).max(600),
    marks: z.array(z.object({
      id: idSchema,
      featureId: semanticPartIdSchema,
      type: z.enum(["rect", "circle", "ellipse", "line", "polygon", "polyline", "path"]),
      geometry: z.string().min(2).max(4_000),
      fill: colorSchema,
      stroke: colorSchema,
      strokeWidth: z.number().min(0).max(80),
      opacity: z.number().min(0).max(1),
      layer: z.number().int().min(0).max(799),
      rank: z.number().int().min(0).max(10_000),
    }).strict()).min(6).max(24),
  }).strict(),
  parts: z.array(z.object({
    id: semanticPartIdSchema,
    label: z.string().min(1).max(80),
    artistName: z.string().min(1).max(80),
    focus: z.string().min(1).max(160),
    objective: z.string().min(1).max(1_200),
    compositionRole: z.enum(["FOUNDATION", "PRIMARY", "SECONDARY", "DETAIL", "ACCENT"]),
    paintMode: z.enum(["background", "solid", "transparent-shell", "linework", "accent"]),
    featureKind: featureKindSchema,
    ownedFeatures: z.array(semanticPartIdSchema).min(1).max(8),
    coordinatesWith: z.array(semanticPartIdSchema).max(CANVAS_MAX_PAINTERS - 1)
      .describe("Only semantic painter part ids from this same parts array; never anchor ids"),
    region: regionSchema,
    maxFootprint: footprintSchema,
    protectedAnchors: z.array(idSchema).min(1).max(8),
    allowBleed: z.boolean(),
    minObjects: z.number().int().min(2).max(CANVAS_MAX_OBJECTS_PER_PAINTER),
    maxObjects: z.number().int().min(2).max(CANVAS_MAX_OBJECTS_PER_PAINTER),
  }).strict()).min(CANVAS_MIN_PAINTERS).max(CANVAS_MAX_PAINTERS),
}).strict();

const canvasMarkSchema = z.object({
  name: z.string().min(1).max(80),
  semanticKey: z.string().min(1).max(80),
  type: z.enum(["rect", "circle", "ellipse", "line", "polygon", "polyline", "path"]),
  geometry: z.string().min(2).max(4_000),
  fill: colorSchema,
  fillGradient: gradientSchema.nullable(),
  stroke: colorSchema,
  strokeWidth: z.number().min(0).max(80),
  opacity: z.number().min(0).max(1),
  fillOpacity: z.number().min(0).max(1).nullable(),
  strokeOpacity: z.number().min(0).max(1).nullable(),
  strokeLinecap: z.enum(["butt", "round", "square"]).nullable(),
  strokeLinejoin: z.enum(["miter", "round", "bevel"]).nullable(),
  strokeDasharray: z.array(z.number().min(0).max(100)).min(1).max(8).nullable(),
  layerOffset: z.number().int().min(0).max(99),
  rank: z.number().int().min(0).max(10_000),
}).strict();

const geometrySchemas = {
  rect: z.object({
    x: coordinateSchema,
    y: coordinateSchema,
    width: z.number().min(1).max(1_200),
    height: z.number().min(1).max(1_200),
    rx: z.number().min(0).max(600).optional(),
    ry: z.number().min(0).max(600).optional(),
  }).strict(),
  circle: z.object({ cx: coordinateSchema, cy: coordinateSchema, r: z.number().min(1).max(600) }).strict(),
  ellipse: z.object({
    cx: coordinateSchema,
    cy: coordinateSchema,
    rx: z.number().min(1).max(600),
    ry: z.number().min(1).max(600),
  }).strict(),
  line: z.object({
    x1: coordinateSchema,
    y1: coordinateSchema,
    x2: coordinateSchema,
    y2: coordinateSchema,
  }).strict(),
  polygon: z.object({ points: z.array(coordinateSchema).min(6).max(64) }).strict(),
  polyline: z.object({ points: z.array(coordinateSchema).min(4).max(64) }).strict(),
  path: z.object({
    d: z.string().min(1).max(4_000).regex(/^[MmZzLlHhVvCcSsQqTtAaEe0-9,.\-+\s]+$/),
  }).strict(),
} as const;

export const canvasArtistOutputSchema = z.object({
  summary: z.string().min(1).max(300),
  objects: z.array(canvasMarkSchema).min(2).max(CANVAS_MAX_OBJECTS_PER_PAINTER),
}).strict();

type CanvasArtistOutput = z.infer<typeof canvasArtistOutputSchema>;

const visualScoreSchema = z.number().int().min(0).max(100);

export const canvasVisualCritiqueSchema = z.object({
  verdict: z.enum(["pass", "repair"]),
  summary: z.string().min(1).max(500),
  scores: z.object({
    promptMatch: visualScoreSchema,
    recognizability: visualScoreSchema,
    composition: visualScoreSchema,
    coherence: visualScoreSchema,
    polish: visualScoreSchema,
  }).strict(),
  issues: z.array(z.object({
    partId: idSchema,
    severity: z.enum(["major", "minor"]),
    problem: z.string().min(1).max(300),
    repairInstruction: z.string().min(1).max(500),
  }).strict()).max(8),
}).strict();

export type CanvasVisualCritique = z.infer<typeof canvasVisualCritiqueSchema>;

export const canvasControlVoteSchema = z.object({
  verdict: z.enum(["endorse", "object", "abstain"]),
  reason: z.string().min(1).max(800),
}).strict();

export type CanvasControlVote = z.infer<typeof canvasControlVoteSchema>;

export const CANVAS_VISUAL_SCORE_FLOORS = {
  promptMatch: 70,
  recognizability: 70,
  composition: 65,
  coherence: 60,
  polish: 55,
} as const satisfies Readonly<Record<keyof CanvasVisualCritique["scores"], number>>;

export const canvasVisualQualityGate = (
  critique: Pick<CanvasVisualCritique, "scores" | "issues">
): {
  readonly pass: boolean;
  readonly mean: number;
  readonly failedDimensions: ReadonlyArray<keyof CanvasVisualCritique["scores"]>;
  readonly majorIssueCount: number;
} => {
  const entries = Object.entries(critique.scores) as ReadonlyArray<
    [keyof CanvasVisualCritique["scores"], number]
  >;
  const mean = entries.reduce((total, [, score]) => total + score, 0) / entries.length;
  const failedDimensions = entries
    .filter(([name, score]) => score < CANVAS_VISUAL_SCORE_FLOORS[name])
    .map(([name]) => name);
  const majorIssueCount = critique.issues.filter((issue) => issue.severity === "major").length;
  return {
    pass: majorIssueCount === 0 && failedDimensions.length === 0 && mean >= 72,
    mean,
    failedDimensions,
    majorIssueCount,
  };
};

export const canvasVisualCompletionGate = (
  critique: Pick<CanvasVisualCritique, "scores">
): { readonly pass: boolean; readonly mean: number } => {
  const scores = Object.values(critique.scores);
  const mean = scores.reduce((total, score) => total + score, 0) / scores.length;
  return {
    pass: critique.scores.promptMatch >= 50
      && critique.scores.recognizability >= 50
      && critique.scores.composition >= 45
      && mean >= 50,
    mean,
  };
};

const XML_ESCAPE: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&apos;",
};

const escapeXml = (value: unknown): string => String(value).replace(/[&<>"']/g, (character) => XML_ESCAPE[character] ?? character);

const geometryAttributes: Readonly<Record<string, string>> = {
  cx: "cx", cy: "cy", r: "r", rx: "rx", ry: "ry",
  x: "x", y: "y", x1: "x1", y1: "y1", x2: "x2", y2: "y2",
  width: "width", height: "height", points: "points", d: "d",
};

const styleAttributes: Readonly<Record<string, string>> = {
  fill: "fill",
  stroke: "stroke",
  strokeWidth: "stroke-width",
  opacity: "opacity",
  fillOpacity: "fill-opacity",
  strokeOpacity: "stroke-opacity",
  strokeLinecap: "stroke-linecap",
  strokeLinejoin: "stroke-linejoin",
  strokeDasharray: "stroke-dasharray",
};

const renderAttribute = (name: string, value: unknown): string => {
  const encoded = Array.isArray(value) ? value.join(" ") : value;
  return `${name}="${escapeXml(encoded)}"`;
};

const gradientId = (object: CanvasObject, gradient: CanvasGradient): string =>
  `canvas-gradient-${hashCanonical({ objectId: object.id, gradient }).slice(0, 24)}`;

const renderGradientDefinition = (object: CanvasObject, gradient: CanvasGradient): string => {
  const id = gradientId(object, gradient);
  const stops = gradient.stops.map((stop) =>
    `<stop offset="${stop.offset * 100}%" stop-color="${escapeXml(stop.color)}" stop-opacity="${stop.opacity}" />`
  ).join("");
  return gradient.kind === "linear-gradient"
    ? `<linearGradient id="${id}" x1="${gradient.x1}" y1="${gradient.y1}" x2="${gradient.x2}" y2="${gradient.y2}">${stops}</linearGradient>`
    : `<radialGradient id="${id}" cx="${gradient.cx}" cy="${gradient.cy}" r="${gradient.r}">${stops}</radialGradient>`;
};

export const renderCanvasSvg = (
  plan: CanvasScenePlan,
  objects: ReadonlyArray<CanvasObject>
): string => {
  const orderedObjects = [...objects]
    .sort((left, right) => left.layer - right.layer || left.rank - right.rank || left.id.localeCompare(right.id))
    .filter((object) => object.type !== "group");
  const definitions = orderedObjects.flatMap((object) => {
    const fill = object.style.fill;
    return fill && typeof fill === "object" && !Array.isArray(fill)
      ? [renderGradientDefinition(object, fill as CanvasGradient)]
      : [];
  }).join("");
  const marks = orderedObjects
    .map((object) => {
      const geometry = Object.entries(object.geometry)
        .map(([key, value]) => geometryAttributes[key] ? renderAttribute(geometryAttributes[key], value) : "")
        .filter(Boolean);
      const style = Object.entries(object.style)
        .map(([key, value]) => {
          if (key === "fill" && value && typeof value === "object" && !Array.isArray(value)) {
            return renderAttribute("fill", `url(#${gradientId(object, value as CanvasGradient)})`);
          }
          return value !== undefined && styleAttributes[key] ? renderAttribute(styleAttributes[key], value) : "";
        })
        .filter(Boolean);
      return `<${object.type} ${[...geometry, ...style].join(" ")} />`;
    })
    .join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${plan.width}" height="${plan.height}" viewBox="0 0 ${plan.width} ${plan.height}">`,
    definitions ? `<defs>${definitions}</defs>` : "",
    `<rect width="${plan.width}" height="${plan.height}" fill="${escapeXml(plan.palette.background)}" />`,
    marks,
    "</svg>",
  ].join("");
};

export const renderCanvasPngDataUrl = async (
  plan: CanvasScenePlan,
  objects: ReadonlyArray<CanvasObject>
): Promise<string> => {
  const png = await sharp(Buffer.from(renderCanvasSvg(plan, objects)))
    .resize(768, 768, { fit: "fill" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
};

export const renderCanvasScaffoldSvg = (plan: CanvasScenePlan): string => renderCanvasSvg(
  plan,
  plan.compositionScaffold.marks.map((mark): CanvasObject => ({
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
  }))
);

export const renderCanvasScaffoldPngDataUrl = async (plan: CanvasScenePlan): Promise<string> => {
  const png = await sharp(Buffer.from(renderCanvasScaffoldSvg(plan)))
    .resize(768, 768, { fit: "fill" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
};

export type CanvasModel = {
  /** Exact routing bound to this implementation; used for honest receipts/UI. */
  readonly routing?: CanvasModelRouting;
  /** Production models expose independent specialist reviews; small injected test models may omit it. */
  readonly validationCouncil?: boolean;
  readonly plan: (input: {
    readonly prompt: string;
    readonly painterCount: number;
    readonly runId: string;
    readonly taskId: string;
  }) => Promise<CanvasScenePlan>;
  readonly paint: (input: {
    readonly prompt: string;
    readonly runId: string;
    readonly plan: CanvasScenePlan;
    readonly part: CanvasPainterPlanPart;
    readonly agentId: string;
    readonly taskId: string;
    readonly baseSceneHash: string;
  }) => Promise<{ readonly patch: CanvasPatch; readonly summary: string }>;
  readonly critique: (input: {
    readonly prompt: string;
    readonly plan: CanvasScenePlan;
    readonly objects: ReadonlyArray<CanvasObject>;
    readonly runId: string;
    readonly taskId: string;
    readonly specialty?: CanvasValidationSpecialty;
  }) => Promise<CanvasVisualCritique>;
  readonly repair: (input: {
    readonly prompt: string;
    readonly runId: string;
    readonly plan: CanvasScenePlan;
    readonly part: CanvasPainterPlanPart;
    readonly agentId: string;
    readonly taskId: string;
    readonly baseSceneHash: string;
    readonly originalPatch: CanvasPatch;
    readonly sceneObjects: ReadonlyArray<CanvasObject>;
    readonly critique: CanvasVisualCritique;
    readonly repairStage: "first" | "final" | "rescue";
  }) => Promise<{ readonly patch: CanvasPatch; readonly summary: string }>;
  /** Optional for injected test models. Production adapters provide it. */
  readonly controlVote?: (input: {
    readonly prompt: string;
    readonly runId: string;
    readonly taskId: string;
    readonly plan: CanvasScenePlan;
    readonly role: "artist" | "finisher";
    readonly responsibility: string;
    readonly action: DistributedControlAction;
    readonly critique: CanvasVisualCritique;
  }) => Promise<CanvasControlVote>;
};

export type CanvasValidationSpecialty = {
  readonly id: "semantic" | "composition" | "consistency";
  readonly label: string;
  readonly instructions: string;
  readonly modelTier: "critic" | "finisher";
};

export type CanvasModelBudget = ModelEscalationBudget;

export const CANVAS_MODEL_ESTIMATED_COST_MICROS = Object.freeze({
  plan: 750_000n,
  paint: 300_000n,
  critique: 400_000n,
  specialistCritique: 180_000n,
  repair: 300_000n,
  repairEscalation: 500_000n,
  controlVote: 120_000n,
});

const retryableStructuredCall = async <Schema extends z.ZodTypeAny, Result>(input: {
  readonly llmStructured: LlmStructured;
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly system: string;
  readonly user: string;
  readonly schema: Schema;
  readonly schemaName: string;
  readonly images?: LlmStructuredOptions<Schema>["images"];
  readonly normalize: (parsed: z.infer<Schema>) => Result;
  readonly budget?: CanvasModelBudget;
  readonly runId?: string;
  readonly taskId?: string;
  readonly estimatedCostMicros?: bigint;
  readonly maxAttempts?: number;
  readonly correctionGuidance?: string;
  readonly escalation?: {
    readonly model: string;
    readonly estimatedCostMicros: bigint;
    readonly instruction: string;
  };
}): Promise<Result> => {
  const escalation = input.escalation && input.escalation.model !== input.model
    ? input.escalation
    : undefined;
  const policy = defineModelEscalationPolicy({
    id: `canvas.${input.schemaName.replaceAll("_", "-")}`,
    stages: [
      {
        id: "primary",
        model: input.model,
        estimatedCostMicros: input.estimatedCostMicros ?? 500_000n,
        maxAttempts: input.maxAttempts ?? 2,
      },
      ...(escalation ? [{
        id: "escalated",
        model: escalation.model,
        estimatedCostMicros: escalation.estimatedCostMicros,
        maxAttempts: 2,
      }] : []),
    ],
    escalateOn: ["contract"],
  });
  return executeModelEscalation({
    policy,
    runId: input.runId,
    taskId: input.taskId,
    requestIdPrefix: "canvas_model",
    budget: input.budget,
    invoke: async ({ requestId, stage, previousError, escalatedFrom }) => {
      const correction = previousError
        ? [
            "",
            "CORRECTION REQUIRED",
            `The previous structured result was rejected: ${previousError}`,
            input.correctionGuidance ?? "Re-audit the complete result, then return a corrected result.",
          ].join("\n")
        : "";
      const escalationInstruction = escalatedFrom && escalation
        ? `\n\nESCALATED RECOVERY\n${escalation.instruction}\nThe exact rejection was: ${previousError ?? "contract failure"}`
        : "";
      const result = await input.llmStructured({
        model: stage.model,
        requestId,
        maxOutputTokens: input.maxOutputTokens,
        system: input.system,
        user: `${input.user}${escalationInstruction}${correction}`,
        images: input.images,
        schema: input.schema,
        schemaName: input.schemaName,
      });
      return { response: result.parsed, usage: result.usage };
    },
    normalize: input.normalize,
  });
};

const CANVAS_FEATURE_PLAN_CONTRACT = [
  "FEATURE OWNERSHIP AND SHARED SCAFFOLD CONTRACT",
  "- Assign painters semantic features, never isolated page sections or grid cells.",
  "- featureKind names the feature system; ownedFeatures lists 1–8 globally exclusive semantic feature ids.",
  "- region is a safety envelope for those features, not the ownership boundary. Feature envelopes may overlap where forms attach or occlude.",
  "- Create compositionScaffold with 6–24 low-detail marks that establish the dominant silhouette, focal scale, horizon, balance, negative space, and important overlaps.",
  "- Every scaffold mark references one owned featureId. Include the PRIMARY silhouette and at least two supporting masses; do not use scaffold marks as decorative detail.",
  "- Scaffold geometry uses the same encoded primitive contract as painter marks, with explicit layer and rank.",
  "- Structural roles may request at most 24 marks; DETAIL and ACCENT roles may request at most 32 marks.",
].join("\n");

const CANVAS_PLAN_CORRECTION_GUIDANCE = [
  "Re-audit the COMPLETE plan, not only the named rejection, before returning it:",
  "- return exactly the requested number of semantic, globally unique feature owners;",
  "- keep parts strictly back-to-front with FOUNDATION first, exactly one PRIMARY, and DETAIL or ACCENT last;",
  "- keep every region inside 1000 by 1000 and every maxFootprint inside its region (plus only permitted bleed);",
  "- reference only declared peer part ids, declared anchor ids, and globally owned feature ids;",
  "- keep structural maxObjects at 24 or less and DETAIL/ACCENT at 32 or less;",
  "- return 6–24 valid low-detail scaffold primitives and include the PRIMARY feature.",
].join("\n");

const CANVAS_SCAFFOLD_SVG_CONTRACT = [
  "ART DIRECTOR SCAFFOLD SVG CONTRACT",
  "- The scene plan contains only low-detail composition scaffold marks, not finished painter artwork.",
  "- Scaffold marks support rect, circle, ellipse, line, polygon, polyline, and parsed SVG path geometry encoded as a JSON string.",
  "- Scaffold styles use only fill, stroke, strokeWidth, and opacity with solid six-digit colors or none.",
  "- Do not add painter-only gradient, advanced stroke, transform, filter, mask, image, text, URL, raw CSS, or defs fields.",
].join("\n");

const CANVAS_SCAFFOLD_PAINT_CONTRACT = [
  "SHARED COMPOSITION SCAFFOLD",
  "- The attached image is the accepted composition scaffold shared by every painter.",
  "- Preserve its focal scale, major silhouette placement, negative space, horizon, and overlap intent.",
  "- You own only YOUR ASSIGNMENT.ownedFeatures, not a rectangular section. Work throughout the assigned region where those features require it.",
  "- Align attachments and shared contours to the scaffold and anchors; do not independently recenter or rescale the composition.",
].join("\n");

const CANVAS_SVG_CAPABILITY_CONTRACT = [
  "CURRENT SAFE SVG CAPABILITY CONTRACT",
  "- This contract supersedes older statements that gradients are unavailable.",
  "- Supported marks are rect, circle, ellipse, line, polygon, polyline, and parsed SVG path.",
  "- Rect geometry may include rx and ry for rounded corners.",
  "- Marks may use fillOpacity, strokeOpacity, strokeLinecap, strokeLinejoin, and a numeric strokeDasharray.",
  "- A mark may use one bounded fillGradient: linear-gradient or radial-gradient with 2–4 ordered solid-color stops and normalized 0–1 coordinates.",
  "- A non-null fillGradient always includes x1, y1, x2, y2, cx, cy, and r; use null for the coordinates irrelevant to its kind.",
  "- Every advanced style field is required by the output schema: use null for fillGradient, fillOpacity, strokeOpacity, strokeLinecap, strokeLinejoin, or strokeDasharray when unused. Rect geometry may omit rx/ry when corners are square.",
  "- Use gradients selectively for material, depth, sky, water, glass, or focal lighting. Do not put a gradient on every mark.",
  "- Scripts, URLs, images, raw CSS, filters, masks, arbitrary defs, and transforms remain forbidden.",
].join("\n");

const canvasSvgSystem = (system: string): string => `${system}\n\n${CANVAS_SVG_CAPABILITY_CONTRACT}`;

const decodeGeometry = (
  name: string,
  type: CanvasArtistOutput["objects"][number]["type"],
  encoded: string
): unknown => {
  const trimmed = encoded.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (type === "path" && /^[Mm]/.test(trimmed)) return { d: trimmed };
  const wrapped = trimmed.startsWith("{") ? trimmed : `{${trimmed}}`;
  const candidates = [
    trimmed,
    wrapped,
    trimmed.replace(/([{,]\s*)([A-Za-z][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
      .replace(/'/g, '"')
      .replace(/,\s*([}\]])/g, "$1"),
    wrapped.replace(/([{,]\s*)([A-Za-z][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
      .replace(/'/g, '"')
      .replace(/,\s*([}\]])/g, "$1"),
  ];
  const open = trimmed.indexOf("{");
  const close = trimmed.lastIndexOf("}");
  if (open >= 0 && close > open) {
    const objectSlice = trimmed.slice(open, close + 1);
    candidates.push(objectSlice, objectSlice
      .replace(/([{,]\s*)([A-Za-z][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
      .replace(/'/g, '"')
      .replace(/,\s*([}\]])/g, "$1"));
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed !== "string") return parsed;
      const nested: unknown = JSON.parse(parsed);
      return nested;
    } catch {
      // Try the next constrained repair form.
    }
  }
  throw new Error(`${name} geometry is not valid encoded JSON`);
};

const normalizeModelGeometry = (
  type: CanvasArtistOutput["objects"][number]["type"],
  decoded: unknown
): unknown => {
  if ((type !== "polygon" && type !== "polyline") || !decoded || typeof decoded !== "object") {
    return decoded;
  }
  const candidate = decoded as { readonly points?: unknown };
  if (!Array.isArray(candidate.points) || !candidate.points.every((point) => (
    Array.isArray(point)
    && point.length === 2
    && point.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ))) {
    return decoded;
  }
  return {
    ...decoded,
    points: candidate.points.flat(),
  };
};

const asObjectDraft = (mark: CanvasArtistOutput["objects"][number]): CanvasObjectDraft => {
  const decoded = normalizeModelGeometry(mark.type, decodeGeometry(mark.name, mark.type, mark.geometry));
  const parsedGeometry = geometrySchemas[mark.type].parse(decoded);
  const geometry = Object.fromEntries(Object.entries(parsedGeometry).filter(([, value]) => value !== null));
  const fillGradient: CanvasGradient | undefined = mark.fillGradient?.kind === "linear-gradient"
    ? (() => {
        const { x1, y1, x2, y2 } = mark.fillGradient;
        if (x1 === null || y1 === null || x2 === null || y2 === null) {
          throw new Error(`${mark.name} linear gradient is missing required coordinates`);
        }
        return { kind: "linear-gradient", x1, y1, x2, y2, stops: mark.fillGradient.stops };
      })()
    : mark.fillGradient?.kind === "radial-gradient"
      ? (() => {
          const { cx, cy, r } = mark.fillGradient;
          if (cx === null || cy === null || r === null) {
            throw new Error(`${mark.name} radial gradient is missing required coordinates`);
          }
          return { kind: "radial-gradient", cx, cy, r, stops: mark.fillGradient.stops };
        })()
      : undefined;
  return {
    name: mark.name,
    semanticKey: mark.semanticKey,
    type: mark.type,
    geometry,
    style: {
      fill: fillGradient ?? mark.fill,
      stroke: mark.stroke,
      strokeWidth: mark.strokeWidth,
      opacity: mark.opacity,
      ...(mark.fillOpacity !== null ? { fillOpacity: mark.fillOpacity } : {}),
      ...(mark.strokeOpacity !== null ? { strokeOpacity: mark.strokeOpacity } : {}),
      ...(mark.strokeLinecap ? { strokeLinecap: mark.strokeLinecap } : {}),
      ...(mark.strokeLinejoin ? { strokeLinejoin: mark.strokeLinejoin } : {}),
      ...(mark.strokeDasharray ? { strokeDasharray: mark.strokeDasharray } : {}),
    },
    layerOffset: mark.layerOffset,
    rank: mark.rank,
  };
};

type CanvasScaffoldModelMark = z.infer<typeof canvasScenePlanDraftSchema>["compositionScaffold"]["marks"][number];

const asScaffoldDraft = (mark: CanvasScaffoldModelMark): CanvasScaffoldMarkDraft => {
  const decoded = normalizeModelGeometry(mark.type, decodeGeometry(mark.id, mark.type, mark.geometry));
  const geometry = geometrySchemas[mark.type].parse(decoded);
  return {
    id: mark.id,
    featureId: mark.featureId,
    type: mark.type,
    geometry,
    style: {
      fill: mark.fill,
      stroke: mark.stroke,
      strokeWidth: mark.strokeWidth,
      opacity: mark.opacity,
    },
    layer: mark.layer,
    rank: mark.rank,
  };
};

const asScaffoldDrafts = (
  marks: ReadonlyArray<CanvasScaffoldModelMark>
): ReadonlyArray<CanvasScaffoldMarkDraft> => {
  const drafts: CanvasScaffoldMarkDraft[] = [];
  const issues: string[] = [];
  for (const mark of marks) {
    try {
      drafts.push(asScaffoldDraft(mark));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      issues.push(`${mark.id}: ${detail}`);
    }
  }
  if (issues.length > 0) {
    throw new Error(`Composition scaffold geometry is invalid:\n- ${issues.join("\n- ")}`);
  }
  return drafts;
};

export const createCanvasModel = (input: {
  readonly llmStructured: LlmStructured;
  readonly prompts: CanvasPromptConfig;
  readonly models?: CanvasModelRouting;
  readonly budget?: CanvasModelBudget;
}): CanvasModel => {
  const models: CanvasModelRouting = Object.freeze({
    ...(input.models ?? CANVAS_RECOMMENDED_MODELS),
  });
  return {
    routing: models,
    validationCouncil: true,
    plan: async ({ prompt, painterCount, runId, taskId }) => {
    const exactPainterCount = Math.max(
      CANVAS_MIN_PAINTERS,
      Math.min(CANVAS_MAX_PAINTERS, Math.floor(painterCount))
    );
    const baseUser = renderCanvasPrompt(input.prompts.user.artDirector, {
      prompt,
      painterCount: String(exactPainterCount),
    });
    const highCapacityGuidance = exactPainterCount >= 7
      ? [
          "HIGH-CAPACITY TEAM CONTRACT",
          "- The extra painters must increase visible detail, storytelling, or depth—not duplicate an existing silhouette.",
          "- Give every painter one independently inspectable responsibility such as a secondary subject, foreground layer, material cues, environmental detail, or restrained lighting accents.",
          "- Keep exactly one strong PRIMARY owner. Never split one simple primary contour into filler assignments merely to reach the requested count.",
          "- Make the seventh and eighth contributions visible at normal canvas scale while preserving hierarchy and calm negative space.",
        ].join("\n")
      : "";
    const user = [baseUser, CANVAS_FEATURE_PLAN_CONTRACT, highCapacityGuidance].filter(Boolean).join("\n\n");
    return retryableStructuredCall({
      llmStructured: input.llmStructured,
      model: models.director,
      maxOutputTokens: 12_288,
      system: `${input.prompts.system.artDirector}\n\n${CANVAS_SCAFFOLD_SVG_CONTRACT}`,
      user,
      schema: canvasScenePlanDraftSchema,
      schemaName: "canvas_scene_plan_v3",
      budget: input.budget,
      runId,
      taskId,
      estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.plan,
      maxAttempts: exactPainterCount >= 7 ? 3 : 2,
      correctionGuidance: CANVAS_PLAN_CORRECTION_GUIDANCE,
      normalize: (parsed) => {
        const draft: CanvasScenePlanDraft = {
          ...parsed,
          compositionScaffold: {
            summary: parsed.compositionScaffold.summary,
            marks: asScaffoldDrafts(parsed.compositionScaffold.marks),
          },
        };
        return createCanvasScenePlan(prompt, draft, exactPainterCount);
      },
    });
    },
    paint: async ({ prompt, runId, plan, part, agentId, taskId, baseSceneHash }) => {
    const user = `${renderCanvasPrompt(input.prompts.user.artist, {
      prompt,
      scenePlan: JSON.stringify(plan),
      part: JSON.stringify(part),
      minObjects: String(part.minObjects),
      maxObjects: String(part.maxObjects),
    })}\n\n${CANVAS_SCAFFOLD_PAINT_CONTRACT}`;
    const scaffoldImageDataUrl = await renderCanvasScaffoldPngDataUrl(plan);
    return retryableStructuredCall({
        llmStructured: input.llmStructured,
        model: models.painter,
        maxOutputTokens: 8_192,
        system: canvasSvgSystem(input.prompts.system.artist),
        user,
        images: [{ dataUrl: scaffoldImageDataUrl, detail: "high" }],
        schema: canvasArtistOutputSchema,
        schemaName: "canvas_artist_patch_v3",
        budget: input.budget,
        runId,
        taskId,
        estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.paint,
        escalation: {
          model: models.finisherEscalation,
          estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.repairEscalation,
          instruction: "The specialist painter exhausted its correction stage. Rebuild the assignment from the scene contract, stay inside the assigned region, and return valid encoded geometry.",
        },
        normalize: (parsed) => ({
          summary: parsed.summary,
          patch: createCanvasPatchForPart({
            runId,
            plan,
            part,
            agentId,
            taskId,
            baseSceneHash,
            objects: parsed.objects.map(asObjectDraft),
          }),
        }),
      });
    },
    critique: async ({ prompt, plan, objects, runId, taskId, specialty }) => {
    const criticPrompts = input.prompts as CanvasPromptConfig & {
      readonly system: { readonly critic: string };
      readonly user: { readonly critic: string };
    };
    const imageDataUrl = await renderCanvasPngDataUrl(plan, objects);
    const partIds = plan.parts
      .filter((part) => part.kind === "painter")
      .map((part) => part.id);
    const partContracts = plan.parts
      .filter((part): part is CanvasPainterPlanPart => part.kind === "painter")
      .map((part, layerOrder) => ({
        id: part.id,
        label: part.label,
        objective: part.objective,
        compositionRole: part.compositionRole,
        paintMode: part.paintMode,
        layerOrder,
      }));
    const baseUser = renderCanvasPrompt(criticPrompts.user.critic, {
      prompt,
      subject: plan.subject,
      artDirection: plan.artDirection,
      partIds: partIds.join(", "),
      partContracts: JSON.stringify(partContracts),
    });
    const user = specialty
      ? `${baseUser}\n\nINDEPENDENT VALIDATOR ASSIGNMENT\n${specialty.label}\n${specialty.instructions}\nJudge independently. Do not defer to another validator or assume another specialty will report the problem.`
      : baseUser;
    const normalizeCritique = (parsed: CanvasVisualCritique): CanvasVisualCritique => {
      for (const issue of parsed.issues) {
        if (!partIds.includes(issue.partId)) {
          throw new Error(`Visual critic assigned an issue to unknown part ${issue.partId}`);
        }
      }
      const gate = canvasVisualQualityGate(parsed);
      // The model supplies observations and severity; the server owns the
      // certification policy. Soft stylistic preferences must not veto an
      // otherwise recognizable, prompt-faithful illustration.
      const verdict = gate.pass ? "pass" as const : "repair" as const;
      if (verdict === "repair" && parsed.issues.length === 0) {
        const primaryPartId = plan.parts.find((part) =>
          part.kind === "painter" && part.compositionRole === "PRIMARY"
        )?.id ?? partIds[0];
        if (!primaryPartId) throw new Error("Visual critic cannot assign the server quality-floor repair");
        return {
          ...parsed,
          verdict,
          issues: [{
            partId: primaryPartId,
            severity: gate.failedDimensions.some((name) => parsed.scores[name] < 60) ? "major" as const : "minor" as const,
            problem: `The rendered image misses the server quality floor for ${gate.failedDimensions.join(", ") || "overall finish"}.`,
            repairInstruction: "Strengthen the focal silhouette, subject-specific cues, and thumbnail readability without disturbing successful surrounding parts.",
          }],
        };
      }
      return { ...parsed, verdict };
    };
    const firstModel = specialty?.modelTier === "finisher" ? models.finisher : models.critic;
    const firstCost = specialty?.modelTier === "finisher"
      ? CANVAS_MODEL_ESTIMATED_COST_MICROS.specialistCritique
      : CANVAS_MODEL_ESTIMATED_COST_MICROS.critique;
    return retryableStructuredCall({
      llmStructured: input.llmStructured,
      model: firstModel,
      system: canvasSvgSystem(criticPrompts.system.critic),
      user,
      images: [{ dataUrl: imageDataUrl, detail: "high" }],
      schema: canvasVisualCritiqueSchema,
      schemaName: "canvas_visual_critique_v3",
      budget: input.budget,
      runId,
      taskId,
      estimatedCostMicros: firstCost,
      escalation: specialty ? {
        model: models.finisherEscalation,
        estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.critique,
        instruction: "The lower-cost validator exhausted its correction stage. Re-inspect the supplied PNG independently and return a fresh valid report for only this specialty.",
      } : undefined,
      normalize: normalizeCritique,
    });
    },
    repair: async ({ prompt, runId, plan, part, agentId, taskId, baseSceneHash, originalPatch, sceneObjects, critique, repairStage }) => {
    const repairPrompts = input.prompts as CanvasPromptConfig & {
      readonly system: { readonly repair: string };
      readonly user: { readonly repair: string };
    };
    const issues = critique.issues.filter((issue) => issue.partId === part.id);
    if (issues.length === 0) throw new Error(`Repair requested for ${part.id} without a targeted visual issue`);
    const imageDataUrl = await renderCanvasPngDataUrl(plan, sceneObjects);
    const user = renderCanvasPrompt(repairPrompts.user.repair, {
      prompt,
      scenePlan: JSON.stringify(plan),
      part: JSON.stringify(part),
      originalPatch: JSON.stringify(originalPatch),
      originalObjectCount: String(originalPatch.objects.length),
      issues: JSON.stringify(issues),
      repairStage,
      minObjects: String(part.minObjects),
      maxObjects: String(part.maxObjects),
    });
    const firstRepair = repairStage === "first";
    return retryableStructuredCall({
      llmStructured: input.llmStructured,
      model: firstRepair ? models.finisher : models.finisherEscalation,
      system: canvasSvgSystem(repairPrompts.system.repair),
      user,
      images: [{ dataUrl: imageDataUrl, detail: "high" }],
      schema: canvasArtistOutputSchema,
      schemaName: "canvas_artist_repair_v3",
      budget: input.budget,
      runId,
      taskId,
      estimatedCostMicros: firstRepair
        ? CANVAS_MODEL_ESTIMATED_COST_MICROS.repair
        : CANVAS_MODEL_ESTIMATED_COST_MICROS.repairEscalation,
      escalation: firstRepair ? {
        model: models.finisherEscalation,
        estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.repairEscalation,
        instruction: "The lower-cost repair model exhausted its correction stage. Produce a fresh valid repair and do not copy malformed geometry from the rejected result.",
      } : undefined,
      normalize: (parsed) => ({
        summary: parsed.summary,
        patch: createCanvasPatchForPart({
          runId,
          plan,
          part,
          agentId,
          taskId,
          baseSceneHash,
          supersedesPatchId: originalPatch.patchId,
          objects: parsed.objects.map(asObjectDraft),
        }),
      }),
    });
    },
    controlVote: async ({ prompt, runId, taskId, plan, role, responsibility, action, critique }) => {
      const user = renderCanvasPrompt(input.prompts.user.controlVote, {
        prompt,
        subject: plan.subject,
        role,
        responsibility,
        action: JSON.stringify(action),
        critique: JSON.stringify(critique),
      });
      const firstModel = role === "finisher" ? models.finisher : models.painter;
      return retryableStructuredCall({
        llmStructured: input.llmStructured,
        model: firstModel,
        maxOutputTokens: 600,
        system: input.prompts.system.controlVote,
        user,
        schema: canvasControlVoteSchema,
        schemaName: "canvas_distributed_control_vote_v1",
        budget: input.budget,
        runId,
        taskId,
        estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.controlVote,
        escalation: {
          model: models.finisherEscalation,
          estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.controlVote,
          instruction: "The lower-cost peer exhausted its correction stage. Re-evaluate the bounded action and return one valid independent vote.",
        },
        normalize: (parsed) => parsed,
      });
    },
  };
};
