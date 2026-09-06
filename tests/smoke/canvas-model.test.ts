import assert from "node:assert/strict";
import test from "node:test";

import type { LlmStructured } from "../../src/adapters/openai.ts";
import {
  CANVAS_MODEL_ESTIMATED_COST_MICROS,
  CANVAS_RECOMMENDED_MODELS,
  canvasVisualCompletionGate,
  canvasVisualQualityGate,
  createCanvasModel,
  resolveCanvasModelRouting,
  type CanvasModelBudget,
} from "../../src/agents/canvas.model.ts";
import { loadCanvasPrompts } from "../../src/prompts/canvas.ts";
import { createCanvasScenePlan, type CanvasScenePlanDraft } from "../../src/domains/canvas.ts";

const featureKindForRole = (role: string) => role === "FOUNDATION" ? "environment" as const
  : role === "PRIMARY" ? "primary-subject" as const
    : role === "SECONDARY" ? "secondary-subject" as const
      : role === "ACCENT" ? "lighting-accent" as const
        : "material-detail" as const;

const structuredScaffold = (featureIds: ReadonlyArray<string>, primaryFeatureId: string) => ({
  summary: "A shared low-detail composition with one focal mass and supporting forms.",
  marks: Array.from({ length: 6 }, (_value, index) => ({
    id: `blockout-${index + 1}`,
    featureId: index === 0 ? primaryFeatureId : featureIds[index % featureIds.length]!,
    type: index % 2 === 0 ? "rect" as const : "ellipse" as const,
    geometry: index % 2 === 0
      ? JSON.stringify({ x: 120 + index * 80, y: 140 + index * 45, width: 180, height: 140 })
      : JSON.stringify({ cx: 220 + index * 90, cy: 240 + index * 55, rx: 80, ry: 55 }),
    fill: index === 0 ? "#418bd4" : "#7cc7f2",
    stroke: "#14233a",
    strokeWidth: 6,
    opacity: .72,
    layer: index * 10,
    rank: index,
  })),
});

const unusedAdvancedStyle = {
  fillGradient: null,
  fillOpacity: null,
  strokeOpacity: null,
  strokeLinecap: null,
  strokeLinejoin: null,
  strokeDasharray: null,
} as const;

test("canvas certification distinguishes semantic blockers from style notes", () => {
  const scores = { promptMatch: 85, recognizability: 88, composition: 74, coherence: 66, polish: 58 };
  assert.equal(canvasVisualQualityGate({
    scores,
    issues: [{ partId: "cabin", severity: "minor", problem: "Heavy outline", repairInstruction: "Soften it" }],
  }).pass, true);
  assert.equal(canvasVisualQualityGate({
    scores,
    issues: [{ partId: "cabin", severity: "major", problem: "The cabin is missing", repairInstruction: "Add it" }],
  }).pass, false);
  assert.equal(canvasVisualCompletionGate({ scores }).pass, true, "a recognizable render remains usable after its repair budget");
  assert.equal(canvasVisualCompletionGate({
    scores: { promptMatch: 28, recognizability: 31, composition: 44, coherence: 50, polish: 48 },
  }).pass, false, "a fundamentally unrecognizable render still hard-blocks");
});

test("canvas model routing defaults by responsibility and supports shared or role overrides", () => {
  assert.deepEqual(CANVAS_RECOMMENDED_MODELS, {
    director: "gpt-5.6-terra",
    painter: "gpt-5.6-luna",
    critic: "gpt-5.6-terra",
    finisher: "gpt-5.6-luna",
    finisherEscalation: "gpt-5.6-terra",
  });
  assert.deepEqual(resolveCanvasModelRouting({}), CANVAS_RECOMMENDED_MODELS);
  assert.deepEqual(resolveCanvasModelRouting({ CANVAS_MODEL: "shared-model" }), {
    director: "shared-model",
    painter: "shared-model",
    critic: "shared-model",
    finisher: "shared-model",
    finisherEscalation: "shared-model",
  });
  assert.deepEqual(
    resolveCanvasModelRouting({ OPENAI_MODEL: "unscoped-model" }),
    CANVAS_RECOMMENDED_MODELS,
    "Roster v2 ignores the pre-v2 global model variable",
  );
  assert.deepEqual(resolveCanvasModelRouting({
    CANVAS_MODEL: "shared-model",
    CANVAS_CRITIC_MODEL: "vision-specialist",
    CANVAS_FINISHER_ESCALATION_MODEL: "repair-specialist",
  }), {
    director: "shared-model",
    painter: "shared-model",
    critic: "vision-specialist",
    finisher: "shared-model",
    finisherEscalation: "repair-specialist",
  });
});

test("canvas escalates a repeatedly invalid painter patch to the stronger model", async () => {
  const routed: string[] = [];
  let escalationPrompt = "";
  const llmStructured = (async (input: Parameters<LlmStructured>[0]) => {
    routed.push(input.model ?? "");
    if (input.model === "repair-specialist") escalationPrompt = input.user;
    const valid = input.model === "repair-specialist";
    const value = {
      summary: valid ? "Corrected inside the assigned region." : "Invalid overshoot.",
      objects: [0, 1].map((index) => ({
        ...unusedAdvancedStyle,
        name: `mark-${index}`,
        semanticKey: `mark-${index}`,
        type: "rect" as const,
        geometry: JSON.stringify(valid
          ? { x: 120 + index * 110, y: 120, width: 90, height: 80 }
          : { x: 900 + index * 110, y: 900, width: 90, height: 80 }),
        fill: "#446688",
        stroke: "none",
        strokeWidth: 0,
        opacity: 1,
        layerOffset: 0,
        rank: 0,
      })),
    };
    return { parsed: input.schema.parse(value), raw: JSON.stringify(value) };
  }) as LlmStructured;
  const draft: CanvasScenePlanDraft = {
    subject: "test subject",
    artDirection: "A constrained test composition.",
    focalBounds: { x: 100, y: 100, width: 200, height: 200, description: "test" },
    anchors: [
      { id: "focus", x: 200, y: 200, description: "test" },
      { id: "baseline", x: 200, y: 360, description: "test baseline" },
    ],
    palette: {
      background: "#101820", primary: "#446688", secondary: "#6688aa", highlight: "#ffffff",
      ink: "#081018", focal: "#ffaa44", accent: "#ff6688", glow: "#aaddff",
    },
    parts: ["foundation", "subject", "detail"].map((id, index) => ({
      id, label: id, artistName: `Painter ${index + 1}`, focus: id, objective: `Paint ${id}`,
      compositionRole: index === 0 ? "FOUNDATION" as const : index === 1 ? "PRIMARY" as const : "DETAIL" as const,
      paintMode: index === 0 ? "background" as const : "solid" as const, coordinatesWith: [],
      region: index === 0 ? { x: 0, y: 0, width: 1_000, height: 1_000 } : { x: 100, y: 100, width: 300, height: 300 },
      maxFootprint: index === 0 ? { width: 1_000, height: 1_000 } : { width: 300, height: 300 }, protectedAnchors: ["focus"], allowBleed: false,
      minObjects: 2, maxObjects: 4,
    })),
  };
  const plan = createCanvasScenePlan("test", draft, 3);
  const part = plan.parts.find((candidate) => candidate.id === "subject");
  assert.ok(part?.kind === "painter");
  const model = createCanvasModel({
    llmStructured,
    prompts: loadCanvasPrompts(),
    models: {
      director: "director", painter: "economy-painter", critic: "critic",
      finisher: "finisher", finisherEscalation: "repair-specialist",
    },
  });
  const painted = await model.paint({
    prompt: "test", runId: "run", plan, part, agentId: "artist", taskId: "paint.subject", baseSceneHash: "base",
  });
  assert.deepEqual(routed, ["economy-painter", "economy-painter", "repair-specialist"]);
  assert.equal(painted.patch.objects.length, 2);
  assert.match(escalationPrompt, /exact rejection/i);
  assert.match(escalationPrompt, /leaves the assigned region/i);
  assert.match(escalationPrompt, /mark bounds x=/i);
  assert.match(escalationPrompt, /allowed including centered stroke x=/i);
});

test("canvas Art Director can plan eight distinct painters with a larger structured-output budget", async () => {
  const ids = [
    "night-sky",
    "distant-mountains",
    "harbor-water",
    "lighthouse-tower",
    "sailing-ships",
    "cliffside-village",
    "foreground-flowers",
    "light-accents",
  ] as const;
  let renderedPrompt = "";
  let renderedSystem = "";
  let outputBudget = 0;
  let attempts = 0;
  const llmStructured = (async (input: Parameters<LlmStructured>[0]) => {
    attempts += 1;
    renderedPrompt = input.user;
    renderedSystem = input.system;
    outputBudget = input.maxOutputTokens ?? 0;
    const roles = ["FOUNDATION", "SECONDARY", "SECONDARY", "PRIMARY", "SECONDARY", "DETAIL", "DETAIL", "ACCENT"] as const;
    const modes = ["background", "solid", "solid", "solid", "solid", "linework", "solid", "accent"] as const;
    const value = {
      subject: "an enchanted moonlit harbor",
      artDirection: "Layered storybook vector art with a clear lighthouse focal point and restrained luminous details.",
      focalBounds: { x: 330, y: 150, width: 360, height: 600, description: "The lighthouse remains the unmistakable focal payload." },
      anchors: [
        { id: "focal-center", x: 510, y: 440, description: "Center of the lighthouse" },
        { id: "harbor-line", x: 500, y: 700, description: "Shared water and shore boundary" },
      ],
      palette: {
        background: "#10183f",
        primary: "#f2e7cf",
        secondary: "#466b8f",
        highlight: "#ffe7a3",
        ink: "#18243d",
        focal: "#ffb84d",
        accent: "#e36f6f",
        glow: "#b9f5ff",
      },
      compositionScaffold: structuredScaffold(ids, "lighthouse-tower"),
      parts: ids.map((id, index) => ({
        id,
        label: id.replaceAll("-", " "),
        artistName: `Painter ${index + 1}`,
        focus: `Visible responsibility ${index + 1}`,
        objective: `Own ${id} without duplicating another painter's silhouette.`,
        compositionRole: roles[index],
        paintMode: modes[index],
        featureKind: featureKindForRole(roles[index]!),
        ownedFeatures: [id],
        coordinatesWith: ids.filter((peer) => peer !== id),
        region: index === 0
          ? { x: 0, y: 0, width: 1_000, height: 1_000 }
          : { x: 100, y: 100, width: 800, height: 800 },
        maxFootprint: index === 0
          ? { width: 1_000, height: 1_000 }
          : attempts === 1 && index === 1
            ? { width: 900, height: 900 }
            : { width: 800, height: 800 },
        protectedAnchors: [index === 0 ? "focal-center" : "harbor-line"],
        allowBleed: false,
        minObjects: 3,
        maxObjects: 10,
      })),
    };
    const parsed = input.schema.parse(value);
    return { parsed, raw: JSON.stringify(value) };
  }) as LlmStructured;
  const model = createCanvasModel({ llmStructured, prompts: loadCanvasPrompts() });
  const plan = await model.plan({
    prompt: "Draw an enchanted harbor with a lighthouse, ships, village, flowers, and moonlight",
    painterCount: 99,
    runId: "canvas-eight-painters",
    taskId: "__canvas_coordinator__",
  });

  assert.equal(plan.painterCount, 8, "requests above the safety ceiling clamp to eight painters");
  assert.equal(plan.parts.filter((part) => part.kind === "painter").length, 8);
  assert.equal(plan.parts[0]?.coordinatesWith.length, 7, "an eight-painter plan may coordinate with all seven peers");
  assert.equal(outputBudget, 12_288);
  assert.equal(attempts, 2, "a rejected high-capacity plan receives a bounded whole-plan correction");
  assert.match(renderedPrompt, /Painter count: exactly 8/i);
  assert.match(renderedPrompt, /extra painters must increase visible detail/i);
  assert.match(renderedPrompt, /seventh and eighth contributions visible/i);
  assert.match(renderedPrompt, /semantic features, never isolated page sections/i);
  assert.match(renderedPrompt, /Create compositionScaffold with 6–24 low-detail marks/i);
  assert.match(renderedSystem, /ART DIRECTOR SCAFFOLD SVG CONTRACT/);
  assert.doesNotMatch(renderedSystem, /Every advanced style field is required/);
  assert.match(renderedPrompt, /Re-audit the COMPLETE plan/i);
  assert.match(renderedPrompt, /every maxFootprint inside its region/i);
});

test("canvas high-capacity planning has one final bounded correction for successive contract issues", async () => {
  const ids = ["sky", "loop-body", "rear-steps", "front-steps", "arches", "figures", "shadows", "highlights"] as const;
  let attempts = 0;
  const llmStructured = (async (input: Parameters<LlmStructured>[0]) => {
    attempts += 1;
    const roles = ["FOUNDATION", "PRIMARY", "SECONDARY", "SECONDARY", "SECONDARY", "DETAIL", "DETAIL", "ACCENT"] as const;
    const value = {
      subject: "an impossible architectural loop",
      artDirection: "One continuous impossible stair loop with a strong central silhouette and restrained supporting detail.",
      focalBounds: { x: 180, y: 150, width: 640, height: 650, description: "The impossible stair loop remains readable." },
      anchors: [
        { id: "loop-center", x: 500, y: 480, description: "Center of the impossible loop" },
        { id: "ground-line", x: 500, y: 800, description: "Shared grounding line" },
      ],
      palette: {
        background: "#f4efe4", primary: "#334455", secondary: "#778899", highlight: "#ffffff",
        ink: "#182028", focal: "#cc7744", accent: "#bb4455", glow: "#ddeeff",
      },
      compositionScaffold: {
        ...structuredScaffold(ids, "loop-body"),
        marks: structuredScaffold(ids, "loop-body").marks.map((mark, index) => index === 0
          ? {
              ...mark,
              type: "polygon" as const,
              geometry: JSON.stringify({ points: [[180, 760], [500, 810], [820, 760], [500, 720]] }),
            }
          : mark),
      },
      parts: ids.map((id, index) => ({
        id,
        label: id,
        artistName: `Feature Artist ${index + 1}`,
        focus: id,
        objective: `Own ${id} and preserve the shared impossible-loop composition.`,
        compositionRole: roles[index],
        paintMode: index === 0 ? "background" as const : index === 7 ? "accent" as const : "solid" as const,
        featureKind: featureKindForRole(roles[index]!),
        ownedFeatures: [id],
        coordinatesWith: ids.filter((peer) => peer !== id),
        region: index === 0 ? { x: 0, y: 0, width: 1_000, height: 1_000 } : { x: 100, y: 100, width: 800, height: 800 },
        maxFootprint: index === 0
          ? { width: 1_000, height: 1_000 }
          : attempts === 1 && index === 2
            ? { width: 900, height: 900 }
            : { width: 800, height: 800 },
        protectedAnchors: attempts === 2 && index === 3 ? ["missing-anchor"] : ["loop-center"],
        allowBleed: false,
        minObjects: 3,
        maxObjects: 12,
      })),
    };
    return { parsed: input.schema.parse(value), raw: JSON.stringify(value) };
  }) as LlmStructured;
  const model = createCanvasModel({ llmStructured, prompts: loadCanvasPrompts() });
  const plan = await model.plan({
    prompt: "escher loop",
    painterCount: 8,
    runId: "canvas-plan-correction",
    taskId: "__canvas_coordinator__",
  });
  assert.equal(attempts, 3);
  assert.equal(plan.painterCount, 8);
  assert.equal(plan.compositionScaffold.marks.length, 6);
  assert.deepEqual(plan.compositionScaffold.marks[0]?.geometry.points, [180, 760, 500, 810, 820, 760, 500, 720]);
});

test("canvas model turns structured Art Director and artist responses into an owned patch", async () => {
  const calls: string[] = [];
  const routedModels: string[] = [];
  const providerRequestIds: string[] = [];
  const reservations: Array<Parameters<CanvasModelBudget["reserve"]>[0]> = [];
  const settlements: Array<{ readonly requestId: string; readonly model?: string }> = [];
  const releases: string[] = [];
  const budget: CanvasModelBudget = {
    reserve: async (reservation) => {
      reservations.push(reservation);
      return {
        settle: async (usage) => { settlements.push({ requestId: reservation.requestId, model: usage?.model }); },
        release: async () => { releases.push(reservation.requestId); },
      };
    },
  };
  let criticImageDataUrl = "";
  let painterScaffoldImageDataUrl = "";
  let repairImageDataUrl = "";
  let criticAttempts = 0;
  const llmStructured = (async (input: Parameters<LlmStructured>[0]) => {
    calls.push(input.schemaName);
    routedModels.push(input.model ?? "");
    providerRequestIds.push(input.requestId ?? "");
    let value: unknown;
    if (input.schemaName === "canvas_scene_plan_v3") {
      value = {
          subject: "a blue whale flying over a city",
          artDirection: "Playful editorial vector art with a dramatic sky and tiny geometric buildings.",
          focalBounds: { x: 180, y: 160, width: 650, height: 430, description: "The flying whale is the focal payload." },
          anchors: [
            { id: "whale-center", x: 500, y: 360, description: "Center of the flying whale" },
            { id: "city-horizon", x: 500, y: 760, description: "Top of the skyline" },
          ],
          palette: {
            background: "#101b3f",
            primary: "#418bd4",
            secondary: "#7cc7f2",
            highlight: "#d8f3ff",
            ink: "#14233a",
            focal: "#ffd166",
            accent: "#ef6f6c",
            glow: "#b9f5ff",
          },
          compositionScaffold: structuredScaffold(
            ["sky-atmosphere", "whale-silhouette", "city-skyline"],
            "whale-silhouette"
          ),
          parts: [
            { id: "sky-foundation", label: "Sky", artistName: "Sky Artist", focus: "Atmosphere", objective: "Paint a luminous sky.", compositionRole: "FOUNDATION", paintMode: "background", featureKind: "environment", ownedFeatures: ["sky-atmosphere"], coordinatesWith: ["flying-whale", "city-detail"], region: { x: 0, y: 0, width: 1_000, height: 1_000 }, maxFootprint: { width: 1_000, height: 1_000 }, protectedAnchors: ["whale-center"], allowBleed: false, minObjects: 2, maxObjects: 8 },
            { id: "flying-whale", label: "Flying whale", artistName: "Whale Artist", focus: "Whale silhouette", objective: "Paint a recognizable blue whale in flight.", compositionRole: "PRIMARY", paintMode: "solid", featureKind: "primary-subject", ownedFeatures: ["whale-silhouette"], coordinatesWith: ["sky-foundation", "city-detail"], region: { x: 180, y: 160, width: 650, height: 430 }, maxFootprint: { width: 650, height: 430 }, protectedAnchors: ["city-horizon"], allowBleed: false, minObjects: 2, maxObjects: 12 },
            { id: "city-detail", label: "Tiny city", artistName: "City Artist", focus: "Skyline", objective: "Paint a tiny city below.", compositionRole: "DETAIL", paintMode: "linework", featureKind: "material-detail", ownedFeatures: ["city-skyline"], coordinatesWith: ["sky-foundation", "flying-whale"], region: { x: 0, y: 650, width: 1_000, height: 350 }, maxFootprint: { width: 1_000, height: 350 }, protectedAnchors: ["city-horizon"], allowBleed: false, minObjects: 2, maxObjects: 12 },
          ],
        };
    } else if (input.schemaName === "canvas_visual_critique_v3") {
      criticAttempts += 1;
      criticImageDataUrl = input.images?.[0]?.dataUrl ?? "";
      value = input.model === "finisher-model"
        ? {
            verdict: "repair",
            summary: "Malformed lower-cost specialty report.",
            scores: { promptMatch: 80, recognizability: 80, composition: 80, coherence: 80, polish: 80 },
            issues: [{
              partId: "unknown-part",
              severity: "major",
              problem: "Invalid ownership target.",
              repairInstruction: "This report must be rejected.",
            }],
          }
        : {
            verdict: "pass",
            summary: "This incorrectly claims a pass below the enforced quality floor.",
            scores: { promptMatch: 59, recognizability: 88, composition: 84, coherence: 86, polish: 82 },
            issues: [],
          };
    } else {
      if (input.schemaName === "canvas_artist_patch_v3") {
        painterScaffoldImageDataUrl = input.images?.[0]?.dataUrl ?? "";
      }
      if (input.schemaName === "canvas_artist_repair_v3") {
        repairImageDataUrl = input.images?.[0]?.dataUrl ?? "";
      }
      const malformedEconomyRepair = input.schemaName === "canvas_artist_repair_v3"
        && input.model === "finisher-model";
      value = {
          summary: "A deep sky and glowing moon establish the atmosphere.",
          objects: [
            { ...unusedAdvancedStyle, name: "sky", semanticKey: "deep-sky", type: "rect", geometry: malformedEconomyRepair ? "not valid geometry" : JSON.stringify({ x: 0, y: 0, width: 1_000, height: 1_000, rx: 18, ry: 18 }), fill: "#101b3f", ...(input.schemaName === "canvas_artist_patch_v3" ? { fillGradient: { kind: "linear-gradient", x1: 0, y1: 0, x2: 0, y2: 1, cx: null, cy: null, r: null, stops: [{ offset: 0, color: "#101b3f", opacity: 1 }, { offset: 1, color: "#418bd4", opacity: .8 }] }, fillOpacity: .95 } : {}), stroke: "none", strokeWidth: 0, opacity: 1, layerOffset: 0, rank: 0 },
            { ...unusedAdvancedStyle, name: "moon", semanticKey: "moon", type: "circle", geometry: malformedEconomyRepair ? "still not valid geometry" : JSON.stringify({ cx: 180, cy: 180, r: 70 }), fill: "#ffd166", stroke: "#d8f3ff", strokeWidth: 2, opacity: 1, strokeOpacity: .8, strokeLinecap: "round", strokeLinejoin: "round", strokeDasharray: [8, 4], layerOffset: 10, rank: 1 },
            ...(input.schemaName === "canvas_artist_repair_v3" ? [{ ...unusedAdvancedStyle, name: "glint", semanticKey: "sky-glint", type: "path" as const, geometry: "M120 120 Q180 90 240 120", fill: "none", stroke: "#d8f3ff", strokeWidth: 4, opacity: 0.7, layerOffset: 20, rank: 2 }] : []),
          ],
        };
    }
    const parsed = input.schema.parse(value);
    return {
      parsed,
      raw: JSON.stringify(value),
      usage: {
        model: input.model ?? "test-model",
        inputTokens: 1_000,
        cachedInputTokens: 100,
        outputTokens: 500,
        reasoningTokens: 0,
        totalTokens: 1_500,
      },
    };
  }) as LlmStructured;

  const model = createCanvasModel({
    llmStructured,
    prompts: loadCanvasPrompts(),
    models: {
      director: "director-model",
      painter: "painter-model",
      critic: "critic-model",
      finisher: "finisher-model",
      finisherEscalation: "escalation-model",
    },
    budget,
  });
  const prompt = "Draw a blue whale flying over a city";
  const plan = await model.plan({
    prompt,
    painterCount: 3,
    runId: "canvas-model",
    taskId: "__canvas_coordinator__",
  });
  assert.deepEqual(model.routing, {
    director: "director-model",
    painter: "painter-model",
    critic: "critic-model",
    finisher: "finisher-model",
    finisherEscalation: "escalation-model",
  });
  assert.equal(plan.subject, "a blue whale flying over a city");
  assert.equal(plan.schemaVersion, 3);
  assert.match(plan.compositionScaffold.scaffoldVersion, /^canvas-scaffold-/);
  assert.deepEqual(
    plan.parts.filter((candidate) => candidate.kind === "painter").map((candidate) => candidate.ownedFeatures),
    [["sky-atmosphere"], ["whale-silhouette"], ["city-skyline"]]
  );
  assert.deepEqual(plan.parts.filter((part) => part.kind === "painter").map((part) => part.id), ["sky-foundation", "flying-whale", "city-detail"]);

  const part = plan.parts.find((candidate) => candidate.id === "sky-foundation");
  assert.ok(part && part.kind === "painter");
  const painted = await model.paint({
    prompt,
    runId: "canvas-model",
    plan,
    part,
    agentId: "sky-artist",
    taskId: "paint.sky",
    baseSceneHash: "empty-scene",
  });
  assert.equal(painted.patch.partId, "sky-foundation");
  assert.equal(painted.patch.objects.length, 2);
  assert.ok(painted.patch.objects.every((object) => object.ownerAgentId === "sky-artist"));
  assert.ok(painted.patch.objects.every((object) => object.semanticId.includes("blue.whale")));
  assert.equal((painted.patch.objects[0]?.style.fill as { readonly kind?: string } | undefined)?.kind, "linear-gradient");
  assert.deepEqual(painted.patch.objects[1]?.style.strokeDasharray, [8, 4]);
  assert.match(painterScaffoldImageDataUrl, /^data:image\/png;base64,/);

  const critique = await model.critique({
    prompt,
    plan,
    objects: painted.patch.objects,
    runId: "canvas-model",
    taskId: "review.initial",
  });
  assert.equal(critique.verdict, "repair");
  assert.equal(critique.issues[0]?.partId, "flying-whale");
  assert.equal(criticAttempts, 1, "the server must not invite score inflation on unchanged pixels");
  assert.match(criticImageDataUrl, /^data:image\/png;base64,/);
  const png = Buffer.from(criticImageDataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  await model.critique({
    prompt,
    plan,
    objects: painted.patch.objects,
    runId: "canvas-model",
    taskId: "review.composition",
    specialty: {
      id: "composition",
      label: "Composition validator",
      instructions: "Inspect hierarchy and balance independently.",
      modelTier: "finisher",
    },
  });

  const repairCritique = {
    verdict: "repair" as const,
    summary: "The sky needs a stronger moon.",
    scores: { promptMatch: 72, recognizability: 70, composition: 64, coherence: 70, polish: 58 },
    issues: [{
      partId: "sky-foundation",
      severity: "major" as const,
      problem: "The moon is too small in the rendered PNG.",
      repairInstruction: "Increase the moon scale without changing the skyline.",
    }],
  };
  const firstRepair = await model.repair({
    prompt,
    runId: "canvas-model",
    plan,
    part,
    agentId: "finishing-artist",
    taskId: "repair.scene",
    baseSceneHash: "reviewed-scene",
    originalPatch: painted.patch,
    sceneObjects: painted.patch.objects,
    critique: repairCritique,
    repairStage: "first",
  });
  assert.equal(firstRepair.patch.agentId, "finishing-artist");
  const repaired = await model.repair({
    prompt,
    runId: "canvas-model",
    plan,
    part,
    agentId: "finishing-artist",
    taskId: "repair.final",
    baseSceneHash: "reviewed-scene",
    originalPatch: painted.patch,
    sceneObjects: painted.patch.objects,
    critique: repairCritique,
    repairStage: "final",
  });
  assert.equal(repaired.patch.supersedesPatchId, painted.patch.patchId);
  assert.equal(repaired.patch.agentId, "finishing-artist");
  assert.match(repairImageDataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(calls, [
    "canvas_scene_plan_v3",
    "canvas_artist_patch_v3",
    "canvas_visual_critique_v3",
    "canvas_visual_critique_v3",
    "canvas_visual_critique_v3",
    "canvas_visual_critique_v3",
    "canvas_artist_repair_v3",
    "canvas_artist_repair_v3",
    "canvas_artist_repair_v3",
    "canvas_artist_repair_v3",
  ]);
  assert.deepEqual(routedModels, [
    "director-model",
    "painter-model",
    "critic-model",
    "finisher-model",
    "finisher-model",
    "escalation-model",
    "finisher-model",
    "finisher-model",
    "escalation-model",
    "escalation-model",
  ]);
  assert.deepEqual(
    providerRequestIds,
    reservations.map((reservation) => reservation.requestId),
    "the durable reservation ID must also identify the provider request"
  );
  assert.deepEqual(reservations.map(({ runId, taskId, model, estimatedCostMicros }) => ({
    runId,
    taskId,
    model,
    estimatedCostMicros,
  })), [
    { runId: "canvas-model", taskId: "__canvas_coordinator__", model: "director-model", estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.plan },
    { runId: "canvas-model", taskId: "paint.sky", model: "painter-model", estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.paint },
    { runId: "canvas-model", taskId: "review.initial", model: "critic-model", estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.critique },
    { runId: "canvas-model", taskId: "review.composition", model: "finisher-model", estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.specialistCritique },
    { runId: "canvas-model", taskId: "review.composition", model: "finisher-model", estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.specialistCritique },
    { runId: "canvas-model", taskId: "review.composition", model: "escalation-model", estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.critique },
    { runId: "canvas-model", taskId: "repair.scene", model: "finisher-model", estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.repair },
    { runId: "canvas-model", taskId: "repair.scene", model: "finisher-model", estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.repair },
    { runId: "canvas-model", taskId: "repair.scene", model: "escalation-model", estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.repairEscalation },
    { runId: "canvas-model", taskId: "repair.final", model: "escalation-model", estimatedCostMicros: CANVAS_MODEL_ESTIMATED_COST_MICROS.repairEscalation },
  ]);
  assert.equal(settlements.length, 10, "every provider response settles exactly one role-specific reservation");
  assert.deepEqual(settlements.map((entry) => entry.model), routedModels);
  assert.deepEqual(releases, []);
});

test("Canvas model fails before the provider when its durable budget reservation is rejected", async () => {
  let providerCalls = 0;
  const llmStructured = (async () => {
    providerCalls += 1;
    throw new Error("provider must not be reached");
  }) as LlmStructured;
  const model = createCanvasModel({
    llmStructured,
    prompts: loadCanvasPrompts(),
    budget: {
      reserve: async () => { throw new Error("run model budget would be exceeded"); },
    },
  });
  await assert.rejects(() => model.plan({
    prompt: "Draw a cat",
    painterCount: 3,
    runId: "canvas-budget-rejected",
    taskId: "__canvas_coordinator__",
  }), /budget would be exceeded/);
  assert.equal(providerCalls, 0);
});

test("Canvas model releases clearly rejected calls but retains ambiguous provider outcomes", async () => {
  const execute = async (providerError: Error & { status?: number }) => {
    let providerCalls = 0;
    let releaseCalls = 0;
    const llmStructured = (async () => {
      providerCalls += 1;
      throw providerError;
    }) as LlmStructured;
    const model = createCanvasModel({
      llmStructured,
      prompts: loadCanvasPrompts(),
      budget: {
        reserve: async () => ({
          settle: async () => undefined,
          release: async () => { releaseCalls += 1; },
        }),
      },
    });
    const result = model.plan({
      prompt: "Draw a cat",
      painterCount: 3,
      runId: "canvas-provider-outcome",
      taskId: "__canvas_coordinator__",
    });
    return { result, counts: () => ({ providerCalls, releaseCalls }) };
  };

  const rejected = await execute(Object.assign(new Error("authentication failed"), { status: 401 }));
  await assert.rejects(rejected.result, /authentication failed/);
  assert.deepEqual(rejected.counts(), { providerCalls: 1, releaseCalls: 1 });

  const uncertain = await execute(Object.assign(new Error("connection timed out after upload"), { status: 500 }));
  await assert.rejects(uncertain.result, /outcome is uncertain.*reservation remains held/i);
  assert.deepEqual(uncertain.counts(), { providerCalls: 1, releaseCalls: 0 });
});

test("Canvas model retains a reservation and does not repeat the provider after settlement failure", async () => {
  let providerCalls = 0;
  let reserveCalls = 0;
  let releaseCalls = 0;
  const llmStructured = (async () => {
    providerCalls += 1;
    return {
      parsed: {} as never,
      raw: "{}",
      usage: {
        model: "director-model",
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
        totalTokens: 20,
      },
    };
  }) as LlmStructured;
  const model = createCanvasModel({
    llmStructured,
    prompts: loadCanvasPrompts(),
    models: {
      director: "director-model",
      painter: "painter-model",
      critic: "critic-model",
      finisher: "finisher-model",
      finisherEscalation: "escalation-model",
    },
    budget: {
      reserve: async () => {
        reserveCalls += 1;
        return {
          settle: async () => { throw new Error("Spacetime settlement unavailable"); },
          release: async () => { releaseCalls += 1; },
        };
      },
    },
  });
  await assert.rejects(() => model.plan({
    prompt: "Draw a cat",
    painterCount: 3,
    runId: "canvas-settlement-failure",
    taskId: "__canvas_coordinator__",
  }), /reservation remains held for reconciliation/);
  assert.equal(providerCalls, 1);
  assert.equal(reserveCalls, 1);
  assert.equal(releaseCalls, 0);
});
