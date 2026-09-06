import assert from "node:assert/strict";
import test from "node:test";

import {
  canvasPainterParts,
  createCanvasPatchForPart,
  createCanvasScenePlan,
  validateCanvasScene,
  type CanvasObjectDraft,
} from "../../src/domains/canvas.ts";
import { CanvasSceneLedger, normalizeCanvasObject } from "../../src/engine/visual/scene.ts";
import { canvasSvgPathBounds } from "../../src/engine/visual/svg-path.ts";
import { renderCanvasSvg } from "../../src/agents/canvas.model.ts";
import { initialCanvas, reduceCanvas } from "../../src/modules/canvas.ts";

const prompt = "Draw a tiny red bicycle leaning beside a moonlit lighthouse";

const plan = createCanvasScenePlan(
  prompt,
  {
    subject: "a tiny red bicycle beside a moonlit lighthouse",
    artDirection: "Graphic storybook vector art with a deep blue night, crisp silhouettes, and a warm beacon.",
    focalBounds: { x: 570, y: 180, width: 330, height: 560, description: "The lighthouse and its beacon remain the focal payload." },
    anchors: [
      { id: "horizon", x: 500, y: 720, description: "Shared ground line" },
      { id: "bicycle-center", x: 390, y: 680, description: "Bicycle frame center" },
      { id: "lighthouse-center", x: 720, y: 470, description: "Lighthouse vertical axis" },
    ],
    palette: {
      background: "#08152f",
      primary: "#e54b4b",
      secondary: "#f5eee2",
      highlight: "#ffe39a",
      ink: "#17233b",
      focal: "#ffcf56",
      accent: "#65c7d0",
      glow: "#fff0b5",
    },
    parts: [
      {
        id: "night-coast",
        label: "Night coast",
        artistName: "Atmosphere Artist",
        focus: "Sky, moon, and ground",
        objective: "Establish the moonlit coastal environment.",
        compositionRole: "FOUNDATION",
        paintMode: "background",
        coordinatesWith: ["lighthouse", "bicycle"],
        region: { x: 0, y: 0, width: 1_000, height: 1_000 },
        maxFootprint: { width: 1_000, height: 1_000 },
        protectedAnchors: ["lighthouse-center"],
        allowBleed: false,
        minObjects: 2,
        maxObjects: 8,
      },
      {
        id: "lighthouse",
        label: "Lighthouse",
        artistName: "Beacon Artist",
        focus: "Tower and warm beacon",
        objective: "Paint a clearly recognizable lighthouse on the right.",
        compositionRole: "PRIMARY",
        paintMode: "solid",
        coordinatesWith: ["night-coast", "bicycle"],
        region: { x: 570, y: 180, width: 330, height: 560 },
        maxFootprint: { width: 330, height: 560 },
        protectedAnchors: ["bicycle-center"],
        allowBleed: false,
        minObjects: 2,
        maxObjects: 10,
      },
      {
        id: "bicycle",
        label: "Red bicycle",
        artistName: "Bicycle Artist",
        focus: "Wheels and readable frame",
        objective: "Paint a small red bicycle leaning toward the tower.",
        compositionRole: "DETAIL",
        paintMode: "linework",
        coordinatesWith: ["night-coast", "lighthouse"],
        region: { x: 160, y: 500, width: 470, height: 270 },
        maxFootprint: { width: 470, height: 270 },
        protectedAnchors: ["lighthouse-center"],
        allowBleed: false,
        minObjects: 2,
        maxObjects: 12,
      },
    ],
  },
  3
);

const style = { fill: "#e54b4b", stroke: "#17233b", strokeWidth: 8, opacity: 1 } as const;

const objectsFor = (partId: string): ReadonlyArray<CanvasObjectDraft> => partId === "night-coast"
  ? [
      { name: "sky", semanticKey: "night-sky", type: "rect", geometry: { x: 0, y: 0, width: 1_000, height: 1_000 }, style: { ...style, fill: "#08152f", stroke: "none", strokeWidth: 0 }, layerOffset: 0, rank: 0 },
      { name: "moon", semanticKey: "moon", type: "circle", geometry: { cx: 210, cy: 210, r: 82 }, style: { ...style, fill: "#ffe39a", stroke: "none", strokeWidth: 0 }, layerOffset: 10, rank: 1 },
    ]
  : partId === "lighthouse"
    ? [
        { name: "tower", semanticKey: "tower", type: "polygon", geometry: { points: [650, 710, 690, 290, 770, 290, 820, 710] }, style: { ...style, fill: "#f5eee2" }, layerOffset: 10, rank: 0 },
        { name: "beacon", semanticKey: "beacon", type: "circle", geometry: { cx: 730, cy: 275, r: 54 }, style: { ...style, fill: "#ffcf56" }, layerOffset: 20, rank: 1 },
      ]
    : [
        { name: "wheel-left", semanticKey: "front-wheel", type: "circle", geometry: { cx: 300, cy: 690, r: 72 }, style: { ...style, fill: "none" }, layerOffset: 10, rank: 0 },
        { name: "wheel-right", semanticKey: "rear-wheel", type: "circle", geometry: { cx: 500, cy: 690, r: 72 }, style: { ...style, fill: "none" }, layerOffset: 10, rank: 1 },
        { name: "frame", semanticKey: "red-frame", type: "path", geometry: { d: "M300 690 L385 590 L500 690 L365 690 L430 560" }, style, layerOffset: 20, rank: 2 },
      ];

const painterParts = canvasPainterParts(plan);

const draftFromPlan = (maxObjects: Readonly<Record<string, number>> = {}, duplicateFeatures = false) => ({
  subject: plan.subject,
  artDirection: plan.artDirection,
  focalBounds: plan.focalBounds,
  anchors: plan.anchors,
  palette: plan.palette,
  parts: painterParts.map((part) => ({
    id: part.id,
    label: part.label,
    artistName: part.artistName,
    focus: part.focus,
    objective: part.objective,
    compositionRole: part.compositionRole,
    paintMode: part.paintMode,
    featureKind: part.featureKind,
    ownedFeatures: duplicateFeatures ? ["shared-feature"] : part.ownedFeatures,
    coordinatesWith: part.coordinatesWith,
    region: part.region,
    maxFootprint: part.maxFootprint,
    protectedAnchors: part.protectedAnchors,
    allowBleed: part.allowBleed,
    minObjects: part.minObjects,
    maxObjects: maxObjects[part.id] ?? part.maxObjects,
  })),
});

test("canvas plan gives feature owners one shared composition scaffold frontier", () => {
  assert.equal(plan.schemaVersion, 3);
  assert.equal(plan.focalBounds.description.includes("lighthouse"), true);
  assert.equal(plan.painterCount, 3);
  assert.ok(painterParts.every((part) =>
    part.needs.length === 2
    && part.needs[0] === "prompt"
    && part.needs[1] === "composition.scaffold"
  ));
  assert.equal(plan.compositionScaffold.marks.length, 4);
  assert.ok(painterParts.every((part) => part.ownedFeatures.length > 0));
  assert.deepEqual(
    painterParts.find((part) => part.id === "night-coast")?.coordinatesWith,
    ["lighthouse", "bicycle"]
  );
  assert.deepEqual(painterParts.map((part) => part.compositionRole), ["FOUNDATION", "PRIMARY", "DETAIL"]);
});

test("canvas expands detail capacity without unbounding structural roles or feature ownership", () => {
  const expanded = createCanvasScenePlan(prompt, draftFromPlan({ bicycle: 32 }), 3);
  assert.equal(canvasPainterParts(expanded).find((part) => part.id === "bicycle")?.maxObjects, 32);
  assert.throws(
    () => createCanvasScenePlan(prompt, draftFromPlan({ lighthouse: 25 }), 3),
    /invalid object limits/
  );
  assert.throws(
    () => createCanvasScenePlan(prompt, draftFromPlan({}, true), 3),
    /owned by exactly one painter/
  );
});

test("canvas renders bounded gradients, rounded rectangles, polylines, and advanced strokes", () => {
  const lighthouse = painterParts.find((part) => part.id === "lighthouse");
  assert.ok(lighthouse);
  const patch = createCanvasPatchForPart({
    runId: "canvas-capabilities",
    plan,
    part: lighthouse,
    agentId: "material-artist",
    taskId: "paint.lighthouse.material",
    baseSceneHash: "scaffold-frontier",
    objects: [
      {
        name: "rounded-tower",
        semanticKey: "rounded-gradient-tower",
        type: "rect",
        geometry: { x: 650, y: 330, width: 150, height: 320, rx: 24, ry: 24 },
        style: {
          fill: {
            kind: "linear-gradient",
            x1: 0,
            y1: 0,
            x2: 1,
            y2: 1,
            stops: [
              { offset: 0, color: "#f5eee2", opacity: 1 },
              { offset: 1, color: "#65c7d0", opacity: .82 },
            ],
          },
          stroke: "#17233b",
          strokeWidth: 8,
          opacity: 1,
          fillOpacity: .95,
          strokeLinejoin: "bevel",
        },
        layerOffset: 10,
        rank: 0,
      },
      {
        name: "railing",
        semanticKey: "dashed-railing",
        type: "polyline",
        geometry: { points: [660, 360, 700, 330, 750, 360, 790, 330] },
        style: {
          fill: "none",
          stroke: "#ffcf56",
          strokeWidth: 6,
          opacity: 1,
          strokeOpacity: .85,
          strokeLinecap: "square",
          strokeLinejoin: "round",
          strokeDasharray: [12, 6],
        },
        layerOffset: 20,
        rank: 1,
      },
    ],
  });
  const svg = renderCanvasSvg(plan, patch.objects);
  assert.match(svg, /<linearGradient id="canvas-gradient-/);
  assert.match(svg, /fill="url\(#canvas-gradient-/);
  assert.match(svg, /<rect[^>]+rx="24"[^>]+ry="24"/);
  assert.match(svg, /<polyline/);
  assert.match(svg, /stroke-dasharray="12 6"/);
  assert.throws(() => normalizeCanvasObject({
    ...patch.objects[0]!,
    style: {
      ...patch.objects[0]!.style,
      fill: {
        kind: "radial-gradient",
        cx: .5,
        cy: .5,
        r: .8,
        stops: [
          { offset: .8, color: "#ffffff", opacity: 1 },
          { offset: .2, color: "#000000", opacity: 1 },
        ],
      },
    },
  }), /gradient stops must be ordered/);
});

test("parsed path bounds cover curves and arcs and reject ownership escape", () => {
  const bounds = canvasSvgPathBounds("M200 600 C250 500 450 500 500 600 A60 40 0 0 1 560 640");
  assert.equal(bounds.minX, 200);
  assert.equal(bounds.minY, 500);
  assert.ok(bounds.maxX >= 560 && bounds.maxY >= 640);
  assert.throws(() => canvasSvgPathBounds("M200 600 A40 40 0 2 0 300 600"), /flags must be 0 or 1/);

  const bicycle = painterParts.find((part) => part.id === "bicycle");
  assert.ok(bicycle);
  assert.throws(() => createCanvasPatchForPart({
    runId: "canvas-path-bounds",
    plan,
    part: bicycle,
    agentId: "bicycle-artist",
    taskId: "paint.bicycle.escape",
    baseSceneHash: "scaffold-frontier",
    objects: [
      {
        name: "escaping-curve",
        semanticKey: "escaping-curve",
        type: "path",
        geometry: { d: "M120 620 C140 580 190 580 220 620" },
        style,
        layerOffset: 10,
        rank: 0,
      },
      {
        name: "valid-wheel",
        semanticKey: "valid-wheel",
        type: "circle",
        geometry: { cx: 300, cy: 690, r: 40 },
        style: { ...style, fill: "none" },
        layerOffset: 20,
        rank: 1,
      },
    ],
  }), /leaves the assigned region/);
});

const makePatch = (partId: string) => {
  const part = painterParts.find((candidate) => candidate.id === partId);
  assert.ok(part);
  return createCanvasPatchForPart({
    runId: "canvas-core",
    plan,
    part,
    agentId: `${partId}-artist`,
    taskId: `paint.${partId}`,
    baseSceneHash: `base-${partId}`,
    objects: objectsFor(partId),
  });
};

const updateFor = (partId: string): Uint8Array => {
  const ledger = new CanvasSceneLedger();
  try {
    return ledger.add(makePatch(partId));
  } finally {
    ledger.destroy();
  }
};

test("canvas Yjs scene converges for a prompt-derived non-cat plan", () => {
  const partIds = painterParts.map((part) => part.id);
  const updates = partIds.map(updateFor);
  const forward = new CanvasSceneLedger();
  const reverse = new CanvasSceneLedger();
  try {
    for (const update of updates) forward.applyEncodedUpdate(update);
    for (const update of [...updates].reverse()) reverse.applyEncodedUpdate(update);
    reverse.applyEncodedUpdate(updates[0]!);
    assert.deepEqual(reverse.project(), forward.project());
    const projection = forward.project();
    assert.equal(projection.conflicts.length, 0);
    assert.equal(projection.patches.length, 3);
    assert.equal(validateCanvasScene(plan, projection.objects, projection.conflicts).verdict, "pass");
    assert.ok(projection.objects.some((object) => object.semanticId.includes("bicycle")));
    assert.ok(projection.objects.every((object) => !object.semanticId.startsWith("cat.")));
  } finally {
    forward.destroy();
    reverse.destroy();
  }
});

test("model patches preserve server-stamped artist ownership", () => {
  const patch = makePatch("bicycle");
  assert.ok(patch.objects.every((object) => object.ownerAgentId === patch.agentId));
  assert.ok(patch.objects.every((object) => object.taskId === patch.taskId));
  assert.ok(patch.objects.every((object) => object.partId === patch.partId));
  assert.throws(() => {
    const ledger = new CanvasSceneLedger();
    try {
      ledger.add({
        ...patch,
        objects: patch.objects.map((object, index) => index === 0
          ? { ...object, ownerAgentId: "intruder" }
          : object),
      });
    } finally {
      ledger.destroy();
    }
  }, /ownership boundary|content identity/);
});

test("structured painter bounds reject broad opaque detail and transparent-shell fills", () => {
  const bicycle = painterParts.find((candidate) => candidate.id === "bicycle");
  assert.ok(bicycle);
  const broadFill: CanvasObjectDraft = {
    name: "broad-panel",
    semanticKey: "broad-panel",
    type: "rect",
    geometry: { x: 200, y: 540, width: 320, height: 120 },
    style,
    layerOffset: 10,
    rank: 0,
  };
  const smallDetail: CanvasObjectDraft = {
    name: "small-detail",
    semanticKey: "small-detail",
    type: "circle",
    geometry: { cx: 360, cy: 690, r: 24 },
    style,
    layerOffset: 20,
    rank: 1,
  };
  assert.throws(() => createCanvasPatchForPart({
    runId: "canvas-core",
    plan,
    part: bicycle,
    agentId: "finishing-artist",
    taskId: "paint.bicycle.invalid-linework",
    baseSceneHash: "base-bicycle",
    objects: [broadFill, smallDetail],
  }), /broad linework fill/);

  const transparentShell = { ...bicycle, paintMode: "transparent-shell" as const };
  assert.throws(() => createCanvasPatchForPart({
    runId: "canvas-core",
    plan,
    part: transparentShell,
    agentId: "finishing-artist",
    taskId: "paint.bicycle.invalid-shell",
    baseSceneHash: "base-bicycle",
    objects: [broadFill, smallDetail],
  }), /transparent-shell fill with opacity above 0\.22/);

  const faintShell: ReadonlyArray<CanvasObjectDraft> = [
    { name: "faint-shell", semanticKey: "faint-shell", type: "ellipse", geometry: { cx: 395, cy: 635, rx: 200, ry: 100 }, style: { ...style, fill: "none", stroke: "#f5eee2", strokeWidth: 5, opacity: .25 }, layerOffset: 0, rank: 0 },
    { name: "faint-rim", semanticKey: "faint-rim", type: "line", geometry: { x1: 240, y1: 690, x2: 550, y2: 690 }, style: { ...style, fill: "none", stroke: "#f5eee2", strokeWidth: 4, opacity: .25 }, layerOffset: 1, rank: 1 },
  ];
  assert.throws(() => createCanvasPatchForPart({
    runId: "canvas-core",
    plan,
    part: transparentShell,
    agentId: "finishing-artist",
    taskId: "paint.bicycle.faint-shell",
    baseSceneHash: "base-bicycle",
    objects: faintShell,
  }), /shell contour with opacity at least 0\.5 and effective contrast at least 1\.8/);

  assert.doesNotThrow(() => createCanvasPatchForPart({
    runId: "canvas-core",
    plan,
    part: transparentShell,
    agentId: "finishing-artist",
    taskId: "paint.bicycle.readable-shell",
    baseSceneHash: "base-bicycle",
    objects: faintShell.map((draft) => ({
      ...draft,
      style: { ...draft.style, stroke: "#ffe39a", opacity: .8 },
    })),
  }));
});

test("background paint safely clips overscan while focal modes keep hard bounds", () => {
  const background = painterParts.find((candidate) => candidate.id === "night-coast");
  assert.ok(background);
  const overscan: CanvasObjectDraft = {
    name: "edge-overscan",
    semanticKey: "edge-overscan",
    type: "rect",
    geometry: { x: -40, y: -40, width: 1_080, height: 1_080 },
    style: { ...style, fill: "#08152f", stroke: "none", strokeWidth: 0 },
    layerOffset: 0,
    rank: 0,
  };
  const smallStar: CanvasObjectDraft = {
    name: "small-star",
    semanticKey: "small-star",
    type: "circle",
    geometry: { cx: 220, cy: 180, r: 8 },
    style: { ...style, fill: "#ffe39a", stroke: "none", strokeWidth: 0 },
    layerOffset: 1,
    rank: 1,
  };
  assert.doesNotThrow(() => createCanvasPatchForPart({
    runId: "canvas-core",
    plan,
    part: background,
    agentId: "atmosphere-artist",
    taskId: "paint.background.overscan",
    baseSceneHash: "empty",
    objects: [overscan, smallStar],
  }));
  const focal = painterParts.find((candidate) => candidate.id === "lighthouse");
  assert.ok(focal);
  const edgeAligned: CanvasObjectDraft = {
    name: "edge-aligned-outline",
    semanticKey: "edge-aligned-outline",
    type: "line",
    geometry: { x1: focal.region.x, y1: focal.region.y + 20, x2: focal.region.x, y2: focal.region.y + 120 },
    style: { ...style, fill: "none", strokeWidth: 6 },
    layerOffset: 0,
    rank: 0,
  };
  const insideMark: CanvasObjectDraft = {
    name: "inside-mark",
    semanticKey: "inside-mark",
    type: "circle",
    geometry: { cx: focal.region.x + 30, cy: focal.region.y + 60, r: 8 },
    style: { ...style, stroke: "none", strokeWidth: 0 },
    layerOffset: 1,
    rank: 1,
  };
  assert.doesNotThrow(() => createCanvasPatchForPart({
    runId: "canvas-core",
    plan,
    part: focal,
    agentId: "beacon-artist",
    taskId: "paint.focal.edge-stroke",
    baseSceneHash: "empty",
    objects: [edgeAligned, insideMark],
  }), "a centered stroke may straddle the edge when its geometry remains inside");
  assert.throws(() => createCanvasPatchForPart({
    runId: "canvas-core",
    plan,
    part: focal,
    agentId: "beacon-artist",
    taskId: "paint.focal.overscan",
    baseSceneHash: "empty",
    objects: [overscan, smallStar],
  }), /leaves the assigned region/);
});

test("canvas Yjs projection keeps revision history but renders only the replacement head", () => {
  const original = makePatch("bicycle");
  const part = painterParts.find((candidate) => candidate.id === "bicycle");
  assert.ok(part);
  const replacement = createCanvasPatchForPart({
    runId: "canvas-core",
    plan,
    part,
    agentId: "finishing-artist",
    taskId: "finish.bicycle",
    baseSceneHash: "reviewed-scene",
    supersedesPatchId: original.patchId,
    objects: [
      { name: "small-wheel-left", semanticKey: "front-wheel", type: "circle", geometry: { cx: 330, cy: 700, r: 54 }, style: { ...style, fill: "none" }, layerOffset: 10, rank: 0 },
      { name: "small-wheel-right", semanticKey: "rear-wheel", type: "circle", geometry: { cx: 480, cy: 700, r: 54 }, style: { ...style, fill: "none" }, layerOffset: 10, rank: 1 },
      { name: "refined-frame", semanticKey: "red-frame", type: "path", geometry: { d: "M330 700 L390 620 L480 700 L370 700 L425 590" }, style, layerOffset: 20, rank: 2 },
    ],
  });
  const ledger = new CanvasSceneLedger();
  try {
    ledger.add(replacement);
    ledger.add(original);
    const projection = ledger.project();
    assert.equal(projection.conflicts.length, 0);
    assert.deepEqual(projection.patches.map((patch) => patch.patchId), [replacement.patchId]);
    assert.ok(projection.objects.every((object) => object.ownerAgentId === "finishing-artist"));
    assert.ok(projection.objects.some((object) => object.id.includes("refined.frame")));
  } finally {
    ledger.destroy();
  }
});

test("an orphan revision stays out of the projection until its parent arrives", () => {
  const original = makePatch("bicycle");
  const part = painterParts.find((candidate) => candidate.id === "bicycle");
  assert.ok(part);
  const replacement = createCanvasPatchForPart({
    runId: "canvas-core",
    plan,
    part,
    agentId: "finishing-artist",
    taskId: "finish.bicycle",
    baseSceneHash: "reviewed-scene",
    supersedesPatchId: original.patchId,
    objects: objectsFor("bicycle"),
  });
  const ledger = new CanvasSceneLedger();
  try {
    ledger.add(replacement);
    assert.equal(ledger.project().objects.length, 0);
    assert.equal(ledger.project().conflicts.length, 1);
    ledger.add(original);
    const converged = ledger.project();
    assert.equal(converged.conflicts.length, 0);
    assert.deepEqual(converged.patches.map((patch) => patch.patchId), [replacement.patchId]);
  } finally {
    ledger.destroy();
  }
});

test("a replacement patch invalidates review until the revised scene is reviewed", () => {
  const original = makePatch("bicycle");
  const part = painterParts.find((candidate) => candidate.id === "bicycle");
  assert.ok(part);
  const replacement = createCanvasPatchForPart({
    runId: "canvas-core",
    plan,
    part,
    agentId: "finishing-artist",
    taskId: "finish.bicycle",
    baseSceneHash: "reviewed-scene",
    supersedesPatchId: original.patchId,
    objects: objectsFor("bicycle"),
  });
  let state = reduceCanvas(initialCanvas, { type: "prompt.set", runId: "canvas-core", prompt: "bicycle", agentId: "orchestrator" }, 1);
  state = reduceCanvas(state, { type: "scene.patch.applied", runId: "canvas-core", agentId: original.agentId, patch: original, updateHash: "first" }, 2);
  state = reduceCanvas(state, {
    type: "scene.reviewed",
    runId: "canvas-core",
    agentId: "critic",
    sceneHash: "original-scene",
    review: { verdict: "pass", scope: "structural", checks: ["checked"], notes: [] },
  }, 3);
  assert.equal(state.review?.verdict, "pass");
  state = reduceCanvas(state, { type: "scene.patch.applied", runId: "canvas-core", agentId: replacement.agentId, patch: replacement, updateHash: "repair" }, 4);
  assert.equal(state.review, undefined);
  assert.equal(state.final, undefined);
});
