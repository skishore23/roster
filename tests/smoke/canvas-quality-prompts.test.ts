import assert from "node:assert/strict";
import test from "node:test";

import { loadCanvasPrompts, renderCanvasPrompt } from "../../src/prompts/canvas.ts";

test("canvas Art Director reserves hierarchy, negative space, and one silhouette owner", () => {
  const prompts = loadCanvasPrompts();
  const rendered = renderCanvasPrompt(prompts.user.artDirector, {
    prompt: "A floating glass city carried through the sky by three enormous jellyfish",
    painterCount: "5",
  });

  assert.match(prompts.system.artDirector, /compositionRole, paintMode, region, maxFootprint, protectedAnchors, and allowBleed/i);
  assert.match(rendered, /order painter parts strictly back-to-front/i);
  assert.match(rendered, /exactly one painter is PRIMARY/i);
  assert.match(rendered, /preserve at least 20% calm negative space/i);
  assert.match(rendered, /PRIMARY payload should normally occupy 30–55%/i);
  assert.match(rendered, /Never make the transparent container a giant opaque primary blob/i);
  assert.match(rendered, /last painter is DETAIL or ACCENT/i);
  assert.match(rendered, /support any safe subject/i);
});

test("canvas artist treats its planned region as a hard visible boundary", () => {
  const prompts = loadCanvasPrompts();
  const rendered = renderCanvasPrompt(prompts.user.artist, {
    prompt: "A curious fox reading beneath a clockwork tree",
    scenePlan: JSON.stringify({ subject: "fox and clockwork tree", parts: [] }),
    part: JSON.stringify({
      id: "fox-detail",
      objective: "[DETAIL] Add the fox's expression without redrawing its body.",
      region: { x: 260, y: 390, width: 300, height: 260 },
    }),
    minObjects: "3",
    maxObjects: "8",
  });

  assert.match(prompts.system.artist, /Treat region as a hard visible bounding box/i);
  assert.match(prompts.system.artist, /main enclosing contour must remain unmistakable at thumbnail scale/i);
  assert.match(prompts.system.artist, /PRIMARY part needs a strong distinctive silhouette/i);
  assert.match(rendered, /Every mark stays inside YOUR ASSIGNMENT\.region/i);
  assert.match(rendered, /union of your visible marks must fit maxFootprint/i);
  assert.match(rendered, /mark spanning more than 250 pixels uses fill 'none' or opacity at most 0\.35/i);
  assert.match(rendered, /Keep every protectedAnchors id visibly readable/i);
  assert.match(rendered, /parser limit only, not permission to leave region/i);
});

test("canvas critic blocks semantic failures, not harmless style preferences", () => {
  const prompts = loadCanvasPrompts();
  assert.match(prompts.system.critic, /Severity is semantic, not a synonym for imperfection/i);
  assert.match(prompts.system.critic, /Line weight, outline style.*are minor/i);
  assert.match(prompts.system.critic, /wrong literal count, broken required relationship/i);
  assert.match(prompts.system.critic, /server owns the quality target/i);
  assert.match(prompts.system.critic, /never ask an earlier background\/carrier\/hill part to occlude/i);
});

test("canvas finishing artist changes strategy when a major issue survives", () => {
  const prompts = loadCanvasPrompts();
  const rendered = renderCanvasPrompt(prompts.user.repair, {
    prompt: "A glass observatory containing a miniature forest",
    repairStage: "final",
    scenePlan: JSON.stringify({ subject: "glass observatory", parts: [] }),
    part: JSON.stringify({ id: "glass-shell", paintMode: "transparent-shell" }),
    originalPatch: JSON.stringify({ objects: [] }),
    originalObjectCount: "4",
    issues: JSON.stringify([{ problem: "The outline is faint and ambiguous" }]),
    minObjects: "3",
    maxObjects: "10",
  });

  assert.match(prompts.system.repair, /repeated issue proves the previous visual strategy failed/i);
  assert.match(prompts.system.repair, /transparent means a transparent fill, not an invisible outline/i);
  assert.match(rendered, /REPAIR STAGE\s+final/i);
  assert.match(rendered, /make the assigned fix clearly visible at thumbnail scale/i);
  assert.match(rendered, /simplify, combine, or replace low-value marks/i);
  assert.doesNotMatch(rendered, /at least 4 objects/i);
});
