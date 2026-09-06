import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { memoryBranchStore, memoryStore } from "../../src/adapters/memory-store.ts";
import type { CanvasModel } from "../../src/agents/canvas.model.ts";
import {
  CANVAS_REPAIR_PART_BUDGET,
  publicCanvasFailureMessage,
  runCanvasRoster as runCanvasRosterWithPlanes,
  selectCanvasRepairScope,
  shouldAcceptCanvasVisualCandidate,
  type CanvasExecutionPlane,
  type CanvasRunInput,
} from "../../src/agents/canvas.ts";
import { canvasRunStream } from "../../src/agents/canvas.streams.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { createCanvasPatchForPart, createCanvasScenePlan, type CanvasObjectDraft } from "../../src/domains/canvas.ts";
import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import {
  InMemoryTaskGraphControl,
  taskGraphTask,
} from "../../src/engine/orchestration/task-graph-control.ts";
import {
  SharedWorkspaceLedger,
  createRosterTaskContext,
} from "../../src/engine/workspace/shared-workspace.ts";
import {
  decideCanvas,
  initialCanvas,
  reduceCanvas,
  type CanvasCmd,
  type CanvasEvent,
  type CanvasState,
} from "../../src/modules/canvas.ts";

const prompt = "Draw a cheerful orange robot gardening on Mars";

const canvasExecutionPlane = (runId: string): CanvasExecutionPlane => {
  const taskGraph = new InMemoryTaskGraphControl();
  const ledger = new SharedWorkspaceLedger(`canvas-test-workspace:${runId}`);
  return {
    taskGraph,
    dataReferences: new InMemoryDataReferenceStore(),
    createTaskContext: ({ node, definition, lease }) => createRosterTaskContext({
      node,
      ledger,
      fence: {
        runId,
        taskId: definition.taskId,
        nodeId: node.id,
        fence: BigInt(lease.fence),
        frontierVersion: definition.inputs.frontierVersion,
        topologyVersion: definition.inputs.topologyVersion,
        catalogVersion: definition.inputs.catalogVersion,
        runtimeBindingEpoch: definition.runtimeBindingEpoch,
        inputVersions: definition.inputs.inputVersions,
      },
      authority: {
        assertActive: async () => {
          const record = taskGraphTask(await taskGraph.snapshot(), definition.taskId);
          if (
            !record
            || (record.status !== "leased" && record.status !== "running")
            || record.leaseOwner !== lease.owner
            || record.leaseFence !== lease.fence
          ) {
            throw new Error(`Canvas test task ${definition.taskId} lost its workspace fence`);
          }
        },
      },
    }),
  };
};

const runCanvasRoster = (
  input: Omit<CanvasRunInput, "executionPlane"> & { readonly executionPlane?: CanvasExecutionPlane },
) => runCanvasRosterWithPlanes({
  ...input,
  executionPlane: input.executionPlane ?? canvasExecutionPlane(input.runId),
});

const scenePlan = createCanvasScenePlan(prompt, {
  subject: "a cheerful orange gardening robot on Mars",
  artDirection: "Friendly retro-futurist vector poster with chunky geometric shapes and a dusty coral horizon.",
  focalBounds: { x: 260, y: 210, width: 480, height: 520, description: "The gardening robot remains the readable focal payload." },
  anchors: [
    { id: "horizon", x: 500, y: 690, description: "Martian horizon" },
    { id: "robot-center", x: 500, y: 500, description: "Robot body center" },
    { id: "garden-bed", x: 500, y: 760, description: "Garden bed center" },
  ],
  palette: {
    background: "#17152f",
    primary: "#ef7d42",
    secondary: "#d9e0e8",
    highlight: "#ffd166",
    ink: "#25243d",
    focal: "#80ed99",
    accent: "#5bc0eb",
    glow: "#f9c74f",
  },
  parts: [
    { id: "mars", label: "Mars", artistName: "Mars Atmosphere Artist", focus: "Sky and terrain", objective: "Paint the Martian environment.", compositionRole: "FOUNDATION", paintMode: "background", coordinatesWith: ["robot", "garden"], region: { x: 0, y: 0, width: 1_000, height: 1_000 }, maxFootprint: { width: 1_000, height: 1_000 }, protectedAnchors: ["robot-center"], allowBleed: false, minObjects: 2, maxObjects: 8 },
    { id: "robot", label: "Gardening robot", artistName: "Robot Form Artist", focus: "Readable robot silhouette", objective: "Paint the orange gardening robot.", compositionRole: "PRIMARY", paintMode: "solid", coordinatesWith: ["mars", "garden"], region: { x: 260, y: 210, width: 480, height: 520 }, maxFootprint: { width: 480, height: 520 }, protectedAnchors: ["garden-bed"], allowBleed: false, minObjects: 3, maxObjects: 12 },
    { id: "garden", label: "Alien garden", artistName: "Botanical Artist", focus: "Plants and garden bed", objective: "Paint a lively alien vegetable garden.", compositionRole: "DETAIL", paintMode: "solid", coordinatesWith: ["mars", "robot"], region: { x: 150, y: 560, width: 700, height: 320 }, maxFootprint: { width: 700, height: 320 }, protectedAnchors: ["robot-center"], allowBleed: false, minObjects: 3, maxObjects: 14 },
  ],
}, 3);

const markStyle = { fill: "#ef7d42", stroke: "#25243d", strokeWidth: 7, opacity: 1 } as const;

test("canvas exposes a bounded safe Art Director contract diagnostic", () => {
  const message = publicCanvasFailureMessage(new Error(
    "Model escalation policy canvas.canvas-scene-plan-v3 exhausted after primary: Canvas part rear-steps has an invalid maximum footprint"
  ));
  assert.match(message, /Last contract issue: Canvas part rear-steps has an invalid maximum footprint/);
  assert.ok(message.length < 500);
});

test("canvas distinguishes transient provider throttling from hard quota exhaustion", () => {
  assert.match(
    publicCanvasFailureMessage(Object.assign(
      new Error("Rate limit reached for requests"),
      { status: 429, code: "rate_limit_exceeded" },
    )),
    /rate-limiting.*retried safely/i,
  );
  assert.match(
    publicCanvasFailureMessage(Object.assign(
      new Error("429 You exceeded your current quota and billing limit"),
      { status: 429, code: "insufficient_quota" },
    )),
    /quota or billing limit is exhausted/i,
  );
});

test("visual candidate gate keeps the stronger rendered frontier", () => {
  const before = {
    verdict: "repair" as const,
    summary: "The subject is readable but the shell needs contrast.",
    scores: { promptMatch: 76, recognizability: 78, composition: 72, coherence: 77, polish: 66 },
    issues: [{ partId: "robot", severity: "major" as const, problem: "Faint shell", repairInstruction: "Strengthen it" }],
  };
  assert.equal(shouldAcceptCanvasVisualCandidate(before, {
    ...before,
    scores: { promptMatch: 72, recognizability: 70, composition: 64, coherence: 70, polish: 58 },
    issues: [{ partId: "robot", severity: "major", problem: "Still faint", repairInstruction: "Try again" }],
  }), false, "a lower-scoring repaint must never replace the current Yjs frontier");
  assert.equal(shouldAcceptCanvasVisualCandidate(before, {
    verdict: "pass",
    summary: "The shell is now clear and polished.",
    scores: { promptMatch: 82, recognizability: 84, composition: 78, coherence: 82, polish: 76 },
    issues: [],
  }), true);
});

test("canvas repair scope caps expensive fan-out and prioritizes major issues", () => {
  const critique = {
    verdict: "repair" as const,
    summary: "Several independent parts need work.",
    scores: { promptMatch: 68, recognizability: 70, composition: 62, coherence: 64, polish: 55 },
    issues: Array.from({ length: 7 }, (_value, index) => ({
      partId: `detail-${index + 1}`,
      severity: index < 4 ? "major" as const : "minor" as const,
      problem: `Problem ${index + 1}`,
      repairInstruction: `Repair ${index + 1}`,
    })),
  };
  const first = selectCanvasRepairScope(critique, "first");
  const final = selectCanvasRepairScope(critique, "final");
  const rescue = selectCanvasRepairScope(critique, "rescue");
  assert.equal(first.partIds.length, CANVAS_REPAIR_PART_BUDGET.first);
  assert.equal(first.deferredPartCount, 4);
  assert.ok(first.critique.issues.every((issue) => issue.severity === "major"));
  assert.equal(final.partIds.length, CANVAS_REPAIR_PART_BUDGET.final);
  assert.equal(final.deferredPartCount, 2, "minor issues are notes once major final repairs exist");
  assert.equal(rescue.partIds.length, CANVAS_REPAIR_PART_BUDGET.rescue);
  assert.equal(rescue.deferredPartCount, 3);
});

const marksFor = (partId: string): ReadonlyArray<CanvasObjectDraft> => partId === "mars"
  ? [
      { name: "sky", semanticKey: "martian-sky", type: "rect", geometry: { x: 0, y: 0, width: 1_000, height: 1_000 }, style: { ...markStyle, fill: "#17152f", stroke: "none", strokeWidth: 0 }, layerOffset: 0, rank: 0 },
      { name: "ground", semanticKey: "mars-ground", type: "path", geometry: { d: "M0 690 Q240 620 500 690 T1000 690 L1000 1000 L0 1000 Z" }, style: { ...markStyle, fill: "#b95d3b" }, layerOffset: 10, rank: 1 },
    ]
  : partId === "robot"
    ? [
        { name: "body", semanticKey: "orange-body", type: "rect", geometry: { x: 390, y: 390, width: 220, height: 250 }, style: markStyle, layerOffset: 10, rank: 0 },
        { name: "head", semanticKey: "robot-head", type: "rect", geometry: { x: 410, y: 260, width: 180, height: 150 }, style: { ...markStyle, fill: "#d9e0e8" }, layerOffset: 20, rank: 1 },
        { name: "eye", semanticKey: "friendly-eye", type: "circle", geometry: { cx: 500, cy: 330, r: 32 }, style: { ...markStyle, fill: "#5bc0eb" }, layerOffset: 30, rank: 2 },
      ]
    : [
        { name: "bed", semanticKey: "garden-bed", type: "rect", geometry: { x: 210, y: 730, width: 580, height: 120 }, style: { ...markStyle, fill: "#774936" }, layerOffset: 10, rank: 0 },
        { name: "plant-left", semanticKey: "alien-plant-left", type: "path", geometry: { d: "M350 750 Q300 650 355 600 Q410 665 350 750" }, style: { ...markStyle, fill: "#80ed99" }, layerOffset: 20, rank: 1 },
        { name: "plant-right", semanticKey: "alien-plant-right", type: "path", geometry: { d: "M650 750 Q590 655 650 590 Q715 660 650 750" }, style: { ...markStyle, fill: "#80ed99" }, layerOffset: 20, rank: 2 },
      ];

test("canvas does not project a painter patch that fails its accepted-output boundary", async () => {
  const runtime = createRuntime<CanvasCmd, CanvasEvent, CanvasState>(
    memoryStore<CanvasEvent>(),
    memoryBranchStore(),
    decideCanvas,
    reduceCanvas,
    initialCanvas,
  );
  const runId = "canvas_rejected_acceptance";
  const stream = "agents/canvas";
  const result = await runCanvasRoster({
    stream,
    runId,
    prompt,
    config: { maxParallel: 3, staggerMs: 0 },
    runtime,
    apiReady: true,
    canvasModel: {
      plan: async () => scenePlan,
      paint: async (input) => {
        const patch = createCanvasPatchForPart({
          runId: input.runId,
          plan: input.plan,
          part: input.part,
          agentId: input.agentId,
          taskId: input.taskId,
          baseSceneHash: input.baseSceneHash,
          objects: marksFor(input.part.id),
        });
        return {
          summary: `Painted ${input.part.id}.`,
          patch: { ...patch, agentId: `unassigned-${input.agentId}` },
        };
      },
      critique: async () => {
        throw new Error("rejected painter outputs must not reach critique");
      },
      repair: async () => {
        throw new Error("rejected painter outputs must not reach repair");
      },
    },
  });

  assert.equal(result.status, "failed");
  const runStream = canvasRunStream(stream, runId);
  const [state, chain] = await Promise.all([
    runtime.state(runStream),
    runtime.chain(runStream),
  ]);
  assert.deepEqual(state.patches, {});
  assert.deepEqual(state.objects, {});
  assert.equal(
    chain.filter((receipt) => receipt.body.type === "scene.patch.applied").length,
    0,
  );
});

test("canvas roster launches and merges eight painter calls concurrently", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roster-canvas-eight-"));
  const ids = [
    "sky-foundation", "focal-tower", "distant-ridge", "harbor-water",
    "sailing-ships", "cliff-village", "foreground-flowers", "light-accents",
  ] as const;
  const roles = ["FOUNDATION", "PRIMARY", "SECONDARY", "SECONDARY", "SECONDARY", "DETAIL", "DETAIL", "ACCENT"] as const;
  const modes = ["background", "solid", "solid", "solid", "solid", "solid", "solid", "accent"] as const;
  const plan8 = createCanvasScenePlan("Draw a richly detailed moonlit harbor", {
    subject: "a richly detailed moonlit harbor",
    artDirection: "Layered flat-vector harbor with one lighthouse focal point and seven visible supporting responsibilities.",
    focalBounds: { x: 300, y: 120, width: 400, height: 620, description: "The lighthouse remains the focal payload." },
    anchors: [
      { id: "focal-center", x: 500, y: 420, description: "Lighthouse center" },
      { id: "harbor-line", x: 500, y: 700, description: "Shared harbor baseline" },
    ],
    palette: {
      background: "#10183f", primary: "#f2e7cf", secondary: "#466b8f", highlight: "#ffe7a3",
      ink: "#18243d", focal: "#ffb84d", accent: "#e36f6f", glow: "#b9f5ff",
    },
    parts: ids.map((id, index) => {
      const column = (index + 3) % 4;
      const row = index <= 4 ? 0 : 1;
      const region = index === 0
        ? { x: 0, y: 0, width: 1_000, height: 1_000 }
        : { x: 40 + column * 240, y: 80 + row * 440, width: 200, height: 300 };
      return {
        id,
        label: id.replaceAll("-", " "),
        artistName: `Painter ${index + 1}`,
        focus: `Harbor responsibility ${index + 1}`,
        objective: `Paint ${id} without duplicating peers.`,
        compositionRole: roles[index],
        paintMode: modes[index],
        coordinatesWith: ids.filter((peer) => peer !== id),
        region,
        maxFootprint: { width: region.width, height: region.height },
        protectedAnchors: [index === 0 ? "focal-center" : "harbor-line"],
        allowBleed: false,
        minObjects: 2,
        maxObjects: 6,
      };
    }),
  }, 8);
  let active = 0;
  let peak = 0;
  let entered = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const barrierTimer = setTimeout(() => release?.(), 1_000);
  const canvasModel: CanvasModel = {
    plan: async () => plan8,
    paint: async (input) => {
      entered += 1;
      active += 1;
      peak = Math.max(peak, active);
      if (entered === 8) release?.();
      await barrier;
      active -= 1;
      const { x, y, width } = input.part.region;
      const objects: ReadonlyArray<CanvasObjectDraft> = input.part.paintMode === "background"
        ? [
            { name: "upper-sky", semanticKey: "upper-sky", type: "rect", geometry: { x: 0, y: 0, width: 1_000, height: 500 }, style: { ...markStyle, fill: "#10183f", stroke: "none", strokeWidth: 0 }, layerOffset: 0, rank: 0 },
            { name: "lower-sky", semanticKey: "lower-sky", type: "rect", geometry: { x: 0, y: 500, width: 1_000, height: 500 }, style: { ...markStyle, fill: "#182652", stroke: "none", strokeWidth: 0 }, layerOffset: 10, rank: 1 },
          ]
        : input.part.paintMode === "accent"
          ? [
              { name: "glint-one", semanticKey: "glint-one", type: "line", geometry: { x1: x + 20, y1: y + 40, x2: x + width - 20, y2: y + 40 }, style: { ...markStyle, fill: "none", stroke: "#ffe7a3", strokeWidth: 6 }, layerOffset: 10, rank: 0 },
              { name: "glint-two", semanticKey: "glint-two", type: "line", geometry: { x1: x + 40, y1: y + 80, x2: x + width - 40, y2: y + 80 }, style: { ...markStyle, fill: "none", stroke: "#b9f5ff", strokeWidth: 6 }, layerOffset: 20, rank: 1 },
            ]
          : [
              { name: "form-one", semanticKey: "form-one", type: "rect", geometry: { x: x + 20, y: y + 20, width: 70, height: 80 }, style: markStyle, layerOffset: 10, rank: 0 },
              { name: "form-two", semanticKey: "form-two", type: "ellipse", geometry: { cx: x + 140, cy: y + 140, rx: 35, ry: 45 }, style: { ...markStyle, fill: "#466b8f" }, layerOffset: 20, rank: 1 },
            ];
      return {
        summary: `Painted ${input.part.id}.`,
        patch: createCanvasPatchForPart({
          runId: input.runId, plan: input.plan, part: input.part, agentId: input.agentId,
          taskId: input.taskId, baseSceneHash: input.baseSceneHash, objects,
        }),
      };
    },
    critique: async () => ({
      verdict: "pass",
      summary: "The eight-part scene is coherent and complete.",
      scores: { promptMatch: 92, recognizability: 90, composition: 86, coherence: 84, polish: 82 },
      issues: [],
    }),
    repair: async () => { throw new Error("passing eight-painter scene should not request repair"); },
  };
  try {
    const runtime = createRuntime<CanvasCmd, CanvasEvent, CanvasState>(
      memoryStore<CanvasEvent>(), memoryBranchStore(), decideCanvas, reduceCanvas, initialCanvas
    );
    const result = await runCanvasRoster({
      stream: "agents/canvas", runId: "canvas_eight", prompt: "Draw a richly detailed moonlit harbor",
      config: { maxParallel: 8, staggerMs: 0 }, runtime, canvasModel, apiReady: true,
    });
    assert.equal(result.status, "completed");
    assert.equal(peak, 8);
    const runStream = canvasRunStream("agents/canvas", "canvas_eight");
    const [state, chain] = await Promise.all([runtime.state(runStream), runtime.chain(runStream)]);
    assert.equal(state.config?.maxParallel, 8);
    assert.equal(state.plan?.painterCount, 8);
    assert.equal(Object.keys(state.patches).length, 8);
    assert.equal(Object.keys(state.orchestration.nodes).length, 13);
    assert.equal(chain.filter((receipt) => receipt.body.type === "scene.patch.applied").length, 8);
    assert.equal(
      chain.filter((receipt) =>
        ["task.delegated", "task.started", "task.completed", "task.failed"].includes(receipt.body.type)
        || receipt.body.type.startsWith("plan.")
      ).length,
      0,
    );
    assert.ok(chain.some((receipt) => receipt.body.type === "task.graph.projected"));
  } finally {
    clearTimeout(barrierTimer);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("canvas roster resumes a failed graph without repeating accepted painter work", async () => {
  const runtime = createRuntime<CanvasCmd, CanvasEvent, CanvasState>(
    memoryStore<CanvasEvent>(),
    memoryBranchStore(),
    decideCanvas,
    reduceCanvas,
    initialCanvas
  );
  let planCalls = 0;
  let critiqueCalls = 0;
  const paintCalls = new Map<string, number>();
  const canvasModel: CanvasModel = {
    plan: async () => {
      planCalls += 1;
      return scenePlan;
    },
    paint: async (input) => {
      const call = (paintCalls.get(input.part.id) ?? 0) + 1;
      paintCalls.set(input.part.id, call);
      if (input.part.id === "robot" && call === 1) {
        throw new Error("simulated painter interruption");
      }
      return {
        summary: `Painted ${input.part.id}.`,
        patch: createCanvasPatchForPart({
          runId: input.runId,
          plan: input.plan,
          part: input.part,
          agentId: input.agentId,
          taskId: input.taskId,
          baseSceneHash: input.baseSceneHash,
          objects: marksFor(input.part.id),
        }),
      };
    },
    critique: async () => {
      critiqueCalls += 1;
      return {
        verdict: "pass",
        summary: "The restored scene contains all three coherent painter contributions.",
        scores: { promptMatch: 92, recognizability: 90, composition: 88, coherence: 86, polish: 84 },
        issues: [],
      };
    },
    repair: async () => { throw new Error("a passing restored scene should not request repair"); },
  };
  const runId = "canvas_interrupted_resume";
  const stream = "agents/canvas";
  const runStream = canvasRunStream(stream, runId);

  const interrupted = await runCanvasRoster({
    stream,
    runId,
    prompt,
    config: { maxParallel: 3, staggerMs: 0 },
    runtime,
    canvasModel,
    apiReady: true,
  });
  assert.equal(interrupted.status, "failed");
  const interruptedState = await runtime.state(runStream);
  assert.equal(Object.keys(interruptedState.patches).length, 2);
  assert.deepEqual(
    [...paintCalls.entries()].sort(([left], [right]) => left.localeCompare(right)),
    [["garden", 1], ["mars", 1], ["robot", 1]],
  );

  const resumed = await runCanvasRoster({
    stream,
    runId,
    prompt,
    config: { maxParallel: 8, staggerMs: 0 },
    runtime,
    canvasModel,
    apiReady: true,
  });
  assert.equal(resumed.status, "completed");
  assert.equal(planCalls, 1, "the persisted scene plan must replace another director call");
  assert.equal(critiqueCalls, 1);
  assert.deepEqual(
    [...paintCalls.entries()].sort(([left], [right]) => left.localeCompare(right)),
    [["garden", 1], ["mars", 1], ["robot", 2]],
    "accepted painters must not run again while the failed painter retries"
  );

  const [completedState, chain] = await Promise.all([runtime.state(runStream), runtime.chain(runStream)]);
  assert.equal(completedState.config?.maxParallel, 3, "resume must retain the original run configuration");
  assert.equal(Object.keys(completedState.patches).length, 3);
  assert.equal(completedState.final?.objectCount, Object.keys(completedState.objects).length);
  assert.equal(chain.filter((receipt) => receipt.body.type === "scene.patch.applied").length, 3);
  assert.equal(
    chain.filter((receipt) =>
      ["task.delegated", "task.started", "task.completed", "task.failed"].includes(receipt.body.type)
      || receipt.body.type.startsWith("plan.")
    ).length,
    0,
  );
  assert.ok(chain.some((receipt) => receipt.body.type === "task.graph.projected"));

  const receiptCount = chain.length;
  const completedAgain = await runCanvasRoster({
    stream,
    runId,
    prompt: "This completed run must return before doing any new work",
    runtime,
    canvasModel: {
      plan: async () => { throw new Error("completed run replanned"); },
      paint: async () => { throw new Error("completed run repainted"); },
      critique: async () => { throw new Error("completed run re-reviewed"); },
      repair: async () => { throw new Error("completed run repaired"); },
    },
    apiReady: false,
  });
  assert.equal(completedAgain.status, "completed");
  assert.equal((await runtime.chain(runStream)).length, receiptCount);
});

test("canvas roster uses a model-planned artist team to paint an arbitrary brief", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roster-canvas-"));
  let planCalls = 0;
  const paintedParts: string[] = [];
  let activePaintCalls = 0;
  let peakPaintCalls = 0;
  let critiqueCalls = 0;
  const critiqueTaskIds: string[] = [];
  let repairCalls = 0;
  const repairStages: string[] = [];
  const repairTaskIds: string[] = [];
  let paintersEntered = 0;
  let releasePainters: (() => void) | undefined;
  let barrierTimer: ReturnType<typeof setTimeout> | undefined;
  const painterBarrier = new Promise<void>((resolve) => { releasePainters = resolve; });
  const canvasModel: CanvasModel = {
    routing: {
      director: "director-model",
      painter: "painter-model",
      critic: "critic-model",
      finisher: "finisher-model",
      finisherEscalation: "escalation-model",
    },
    plan: async (input) => {
      planCalls += 1;
      assert.equal(input.prompt, prompt);
      return scenePlan;
    },
    paint: async (input) => {
      paintedParts.push(input.part.id);
      activePaintCalls += 1;
      paintersEntered += 1;
      peakPaintCalls = Math.max(peakPaintCalls, activePaintCalls);
      if (!barrierTimer) barrierTimer = setTimeout(() => releasePainters?.(), 500);
      if (paintersEntered === 3) releasePainters?.();
      await painterBarrier;
      await new Promise((resolve) => setTimeout(resolve, 5));
      activePaintCalls -= 1;
      return {
        summary: `Painted ${input.part.label}`,
        patch: createCanvasPatchForPart({
          runId: input.runId,
          plan: input.plan,
          part: input.part,
          agentId: input.agentId,
          taskId: input.taskId,
          baseSceneHash: input.baseSceneHash,
          objects: marksFor(input.part.id),
        }),
      };
    },
    critique: async (input) => {
      critiqueCalls += 1;
      critiqueTaskIds.push(input.taskId);
      return critiqueCalls < 3
        ? {
            verdict: "repair",
            summary: critiqueCalls === 1
              ? "The robot reads clearly, but its focal eye is too small at thumbnail scale."
              : "The first repair helped, but the expression still needs one final targeted revision.",
            scores: critiqueCalls === 1
              ? { promptMatch: 84, recognizability: 72, composition: 76, coherence: 74, polish: 58 }
              : { promptMatch: 88, recognizability: 76, composition: 78, coherence: 78, polish: 64 },
            issues: [{
              partId: "robot",
              severity: "major",
              problem: "The robot's face lacks a strong focal expression.",
              repairInstruction: "Enlarge the eye and strengthen the head/body hierarchy.",
            }, ...(critiqueCalls === 2 ? [{
              partId: "garden",
              severity: "minor" as const,
              problem: "One leaf could use a tiny highlight.",
              repairInstruction: "Keep the garden stable; this minor issue does not justify a final destructive rewrite.",
            }] : [])],
          }
        : {
            verdict: "pass",
            summary: "The repaired robot is readable and the scene is compositionally coherent.",
            scores: { promptMatch: 90, recognizability: 88, composition: 82, coherence: 86, polish: 84 },
            issues: [],
          };
    },
    repair: async (input) => {
      repairCalls += 1;
      repairStages.push(input.repairStage);
      repairTaskIds.push(input.taskId);
      assert.equal(input.part.id, "robot");
      return {
        summary: "Repaired the robot focal expression.",
        patch: createCanvasPatchForPart({
          runId: input.runId,
          plan: input.plan,
          part: input.part,
          agentId: input.agentId,
          taskId: input.taskId,
          baseSceneHash: input.baseSceneHash,
          supersedesPatchId: input.originalPatch.patchId,
          objects: marksFor("robot").map((mark, index) => index === 2
            ? { ...mark, geometry: { cx: 500, cy: 330, r: 46 } }
            : mark),
        }),
      };
    },
  };
  try {
    const runtime = createRuntime<CanvasCmd, CanvasEvent, CanvasState>(
      memoryStore<CanvasEvent>(),
      memoryBranchStore(),
      decideCanvas,
      reduceCanvas,
      initialCanvas
    );
    const executionPlane = canvasExecutionPlane("canvas_workflow");
    const result = await runCanvasRoster({
      stream: "agents/canvas",
      runId: "canvas_workflow",
      prompt,
      config: { maxParallel: 3, staggerMs: 0 },
      runtime,
      canvasModel,
      apiReady: true,
      executionPlane,
    });
    assert.equal(result.status, "completed");
    assert.equal(planCalls, 1);
    assert.equal(critiqueCalls, 3, "critic should inspect the initial, repaired, and final PNG frontiers");
    assert.deepEqual(critiqueTaskIds, ["deliberate.scene", ...repairTaskIds]);
    assert.equal(repairCalls, 2, "the targeted robot part should receive the bounded final repair round");
    assert.deepEqual(repairStages, ["first", "final"]);
    assert.match(repairTaskIds[0] ?? "", /^repair\.first\.robot\.[0-9a-f]{12}$/);
    assert.match(repairTaskIds[1] ?? "", /^repair\.final\.robot\.[0-9a-f]{12}$/);
    const graph = await executionPlane.taskGraph.snapshot();
    assert.deepEqual(
      graph.tasks
        .filter((task) => task.definition.semanticKey.startsWith("canvas:repair:"))
        .map((task) => ({ taskId: task.definition.taskId, status: task.status }))
        .sort((left, right) => left.taskId.localeCompare(right.taskId)),
      repairTaskIds
        .map((taskId) => ({ taskId, status: "accepted" }))
        .sort((left, right) => left.taskId.localeCompare(right.taskId)),
    );
    assert.equal(graph.expansions.length, 2);
    assert.equal(peakPaintCalls, 3, "all three painter model calls should overlap");
    assert.deepEqual(paintedParts.sort(), ["garden", "mars", "robot"]);

    const runStream = canvasRunStream("agents/canvas", "canvas_workflow");
    const [state, chain] = await Promise.all([runtime.state(runStream), runtime.chain(runStream)]);
    assert.equal(state.status, "completed");
    assert.equal(state.plan?.subject, "a cheerful orange gardening robot on Mars");
    assert.equal(state.review?.verdict, "pass");
    assert.equal(state.review?.scope, "rendered-visual");
    assert.equal(Object.keys(state.patches).length, 5);
    assert.equal(Object.keys(state.orchestration.nodes).length, 8);
    assert.deepEqual(state.config?.models, canvasModel.routing);
    assert.equal(state.config?.workflowVersion, "4.4");
    const scaffoldOutput = state.orchestration.outputs["composition.scaffold"];
    assert.ok(scaffoldOutput);
    assert.equal(state.orchestration.artifacts[scaffoldOutput.artifactId]?.kind, "canvas.composition-scaffold");
    assert.equal(state.plan?.compositionScaffold.scaffoldVersion.startsWith("canvas-scaffold-"), true);
    assert.ok(state.orchestration.compositions["canvas.final"]);
    assert.ok(Object.values(state.objects).some((object) => object.semanticId.includes("robot")));
    assert.ok(Object.values(state.objects).every((object) => !object.semanticId.startsWith("cat.")));
    assert.equal(chain.filter((receipt) => receipt.body.type === "scene.patch.applied").length, 5);
    assert.equal(chain.filter((receipt) => receipt.body.type === "scene.reviewed").length, 4);
    assert.ok(chain.some((receipt) => receipt.body.type === "control.update.published" && receipt.body.payload.kind === "proposal"));
    assert.ok(chain.some((receipt) => receipt.body.type === "control.update.published" && receipt.body.payload.kind === "endorsement"));
    assert.ok(chain.some((receipt) => receipt.body.type === "control.frontier.certified"));
    const configured = chain.find((receipt) => receipt.body.type === "run.configured");
    assert.ok(configured && configured.body.type === "run.configured");
    assert.deepEqual(configured.body.models, canvasModel.routing);
    assert.ok(chain.some((receipt) => receipt.body.type === "scene.patch.applied" && Boolean(receipt.body.patch.supersedesPatchId)));
    const compositionProposal = chain.find((receipt) => receipt.body.type === "composition.proposed");
    assert.ok(compositionProposal && compositionProposal.body.type === "composition.proposed");
    assert.deepEqual(compositionProposal.body.evidence.map((item) => item.kind), ["structural-validation", "visual-critique"]);
    assert.equal(
      chain.filter((receipt) =>
        ["task.delegated", "task.started", "task.completed", "task.failed"].includes(receipt.body.type)
        || receipt.body.type.startsWith("plan.")
      ).length,
      0,
    );
    assert.ok(chain.some((receipt) =>
      receipt.body.type === "task.graph.projected"
      && receipt.body.graph.tasks.some((task) => task.taskId.startsWith("repair."))
    ));
    assert.ok(chain.some((receipt) => receipt.body.type === "reflection.recorded" && receipt.body.actions.some((action) => action.type === "stop")));
  } finally {
    if (barrierTimer) clearTimeout(barrierTimer);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("canvas completes a recognizable scene with notes after bounded repairs cannot improve it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roster-canvas-notes-"));
  let critiqueCalls = 0;
  let repairCalls = 0;
  const canvasModel: CanvasModel = {
    plan: async () => scenePlan,
    paint: async (input) => ({
      summary: `Painted ${input.part.id}.`,
      patch: createCanvasPatchForPart({
        runId: input.runId,
        plan: input.plan,
        part: input.part,
        agentId: input.agentId,
        taskId: input.taskId,
        baseSceneHash: input.baseSceneHash,
        objects: marksFor(input.part.id),
      }),
    }),
    critique: async () => {
      critiqueCalls += 1;
      return {
        verdict: "repair",
        summary: "The scene is recognizable and usable, but one stylistic relationship remains imperfect.",
        scores: { promptMatch: 80, recognizability: 80, composition: 70, coherence: 65, polish: 60 },
        issues: [{
          partId: "robot",
          severity: "major",
          problem: "The robot could feel more grounded.",
          repairInstruction: "Adjust the contact edge without changing the recognizable scene.",
        }],
      };
    },
    repair: async (input) => {
      repairCalls += 1;
      return {
        summary: "Proposed a non-improving contact edit.",
        patch: createCanvasPatchForPart({
          runId: input.runId,
          plan: input.plan,
          part: input.part,
          agentId: input.agentId,
          taskId: input.taskId,
          baseSceneHash: input.baseSceneHash,
          supersedesPatchId: input.originalPatch.patchId,
          objects: marksFor(input.part.id),
        }),
      };
    },
  };
  try {
    const runtime = createRuntime<CanvasCmd, CanvasEvent, CanvasState>(
      memoryStore<CanvasEvent>(),
      memoryBranchStore(),
      decideCanvas,
      reduceCanvas,
      initialCanvas
    );
    const result = await runCanvasRoster({
      stream: "agents/canvas",
      runId: "canvas_notes",
      prompt,
      config: { maxParallel: 3, staggerMs: 0 },
      runtime,
      canvasModel,
      apiReady: true,
    });
    assert.equal(result.status, "completed");
    assert.equal(critiqueCalls, 2, "agents should stop after the first repair candidate cannot improve the frontier");
    assert.equal(repairCalls, 1);
    const runStream = canvasRunStream("agents/canvas", "canvas_notes");
    const [state, chain] = await Promise.all([runtime.state(runStream), runtime.chain(runStream)]);
    assert.equal(state.review?.verdict, "pass");
    assert.equal(state.review?.qualityStatus, "accepted-with-notes");
    assert.match(state.statusNote ?? "", /completed with visual notes/i);
    assert.ok(chain.some((receipt) =>
      receipt.body.type === "scene.reviewed" && receipt.body.review.qualityStatus === "accepted-with-notes"
    ));
    assert.ok(chain.some((receipt) => receipt.body.type === "control.frontier.certified"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("canvas roster fails honestly when model access is unavailable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roster-canvas-offline-"));
  try {
    const runtime = createRuntime<CanvasCmd, CanvasEvent, CanvasState>(
      memoryStore<CanvasEvent>(),
      memoryBranchStore(),
      decideCanvas,
      reduceCanvas,
      initialCanvas
    );
    const result = await runCanvasRoster({
      stream: "agents/canvas",
      runId: "canvas_offline",
      prompt: "Draw a blue whale flying over a city",
      config: { maxParallel: 4, staggerMs: 0 },
      runtime,
      canvasModel: {
        plan: async () => { throw new Error("should not be called"); },
        paint: async () => { throw new Error("should not be called"); },
        critique: async () => { throw new Error("should not be called"); },
        repair: async () => { throw new Error("should not be called"); },
      },
      apiReady: false,
      apiNote: "OPENAI_API_KEY not set",
    });
    assert.equal(result.status, "failed");
    const state = await runtime.state(canvasRunStream("agents/canvas", "canvas_offline"));
    assert.equal(state.status, "failed");
    assert.match(state.statusNote ?? "", /OPENAI_API_KEY/);
    assert.deepEqual(state.failure, {
      class: "authentication",
      retryable: false,
    });
    assert.equal(Object.keys(state.objects).length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("canvas refuses to report routing that differs from its bound model adapter", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roster-canvas-routing-mismatch-"));
  let planCalls = 0;
  try {
    const runtime = createRuntime<CanvasCmd, CanvasEvent, CanvasState>(
      memoryStore<CanvasEvent>(),
      memoryBranchStore(),
      decideCanvas,
      reduceCanvas,
      initialCanvas
    );
    const canvasModel: CanvasModel = {
      routing: {
        director: "bound-director",
        painter: "bound-painter",
        critic: "bound-critic",
        finisher: "bound-finisher",
        finisherEscalation: "bound-escalation",
      },
      plan: async () => { planCalls += 1; throw new Error("should not be called"); },
      paint: async () => { throw new Error("should not be called"); },
      critique: async () => { throw new Error("should not be called"); },
      repair: async () => { throw new Error("should not be called"); },
    };
    const result = await runCanvasRoster({
      stream: "agents/canvas",
      runId: "canvas_routing_mismatch",
      prompt: "Draw a lighthouse",
      runtime,
      canvasModel,
      models: {
        director: "reported-director",
        painter: "reported-painter",
        critic: "reported-critic",
        finisher: "reported-finisher",
        finisherEscalation: "reported-escalation",
      },
      apiReady: true,
    });
    assert.equal(result.status, "failed");
    assert.equal(planCalls, 0);
    const state = await runtime.state(canvasRunStream("agents/canvas", "canvas_routing_mismatch"));
    assert.match(state.statusNote ?? "", /routing does not match/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
