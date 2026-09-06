import assert from "node:assert/strict";
import test from "node:test";

import { axiomSimpleShell } from "../../src/views/axiom-simple.js";
import { theoremShell } from "../../src/views/theorem.js";
import { writerShell } from "../../src/views/writer.js";

const count = (html: string, token: string): number => html.split(token).length - 1;

const workspaceRegionBounds = (html: string, rootId: string): {
  readonly conversationStart: number;
  readonly contextStart: number;
} => {
  const shellStart = html.indexOf(`id="${rootId}-context"`);
  const conversationStart = html.indexOf('data-slot="workspace-conversation"');
  const contextStart = html.indexOf('data-slot="workspace-context"');
  assert.ok(shellStart >= 0, `expected ${rootId} unified workspace context`);
  assert.ok(conversationStart >= 0, `expected ${rootId} conversation region`);
  assert.ok(contextStart > conversationStart, `expected ${rootId} context after conversation`);
  return { conversationStart, contextStart };
};

const assertRoomFirstComposer = (
  html: string,
  options: {
    readonly rootId: string;
    readonly prefix: string;
    readonly problemId: string;
  },
): { readonly conversationStart: number; readonly contextStart: number } => {
  const bounds = workspaceRegionBounds(html, options.rootId);
  const conversation = html.indexOf(`id="${options.prefix}-conversation"`);
  const composer = html.indexOf('data-slot="workspace-composer"');
  const problem = html.indexOf(`id="${options.problemId}"`);
  const work = html.indexOf(`id="${options.prefix}-chat"`);

  assert.ok(conversation > bounds.conversationStart && conversation < bounds.contextStart);
  assert.ok(composer > conversation && composer < bounds.contextStart);
  assert.ok(problem > composer && problem < bounds.contextStart);
  assert.ok(work > bounds.contextStart);
  assert.equal(count(html, `id="${options.prefix}-conversation"`), 1);
  assert.equal(count(html, `id="${options.prefix}-chat"`), 1);
  assert.equal(count(html, `id="${options.problemId}"`), 1);
  return bounds;
};

const assertOptionsDisclosure = (
  html: string,
  bounds: { readonly conversationStart: number; readonly contextStart: number },
  fields: ReadonlyArray<string>,
): void => {
  const detailsStart = html.indexOf('<details class="agent-composer-options">', bounds.conversationStart);
  const detailsEnd = html.indexOf("</details>", detailsStart);
  assert.ok(detailsStart > bounds.conversationStart && detailsStart < bounds.contextStart);
  assert.ok(detailsEnd > detailsStart && detailsEnd < bounds.contextStart);
  assert.ok(html.indexOf("<summary>", detailsStart) < detailsEnd);
  for (const field of fields) {
    const fieldIndex = html.indexOf(`name="${field}"`, detailsStart);
    assert.ok(fieldIndex > detailsStart && fieldIndex < detailsEnd, `expected ${field} inside native details`);
  }
  const submit = html.indexOf('type="submit"', detailsEnd);
  assert.ok(submit > detailsEnd && submit < bounds.contextStart, "expected primary action outside disclosure");
};

test("adaptive proof starts in the conversation region and keeps search tuning disclosed", () => {
  const html = theoremShell(
    "agents/theorem",
    [{ id: "demo", label: "Demo", problem: "Prove the demo theorem." }],
  );
  const bounds = assertRoomFirstComposer(html, {
    rootId: "adaptive-workspace",
    prefix: "tg",
    problemId: "tg-problem",
  });

  assertOptionsDisclosure(html, bounds, ["rounds", "depth", "memory", "branch", "concurrency"]);
  assert.ok(
    html.indexOf('action="/theorem/run?stream=agents%2Ftheorem" method="post"', bounds.conversationStart)
      < bounds.contextStart,
  );
});

test("adaptive proof continuation stays in conversation with its replay query intact", () => {
  const html = theoremShell("agents/theorem", [], "run demo", 4, "branch a");
  const bounds = assertRoomFirstComposer(html, {
    rootId: "adaptive-workspace",
    prefix: "tg",
    problemId: "tg-problem",
  });

  assert.ok(
    html.indexOf('action="/theorem/run?stream=agents%2Ftheorem&amp;run=run%20demo&amp;branch=branch%20a&amp;at=4" method="post"', bounds.conversationStart)
      < bounds.contextStart,
  );
  assert.ok(html.indexOf('name="append"', bounds.conversationStart) < bounds.contextStart);
  assert.equal(count(html, '<details class="agent-composer-options">'), 0);
});

test("writer start and continuation controls live in conversation with runtime tuning disclosed", () => {
  const freshHtml = writerShell(
    "agents/writer",
    [{ id: "demo", label: "Demo", problem: "Write a sourced memo." }],
  );
  const freshBounds = assertRoomFirstComposer(freshHtml, {
    rootId: "writer-workspace",
    prefix: "wg",
    problemId: "wg-problem",
  });
  assertOptionsDisclosure(freshHtml, freshBounds, ["parallel"]);
  assert.ok(
    freshHtml.indexOf('action="/writer/run?stream=agents%2Fwriter" method="post"', freshBounds.conversationStart)
      < freshBounds.contextStart,
  );

  const html = writerShell(
    "agents/writer",
    [{ id: "demo", label: "Demo", problem: "Write a sourced memo." }],
    "run writer",
    7,
    "editorial",
  );
  const bounds = assertRoomFirstComposer(html, {
    rootId: "writer-workspace",
    prefix: "wg",
    problemId: "wg-problem",
  });

  assert.ok(
    html.indexOf('action="/writer/run?stream=agents%2Fwriter&amp;run=run%20writer&amp;branch=editorial&amp;at=7" method="post"', bounds.conversationStart)
      < bounds.contextStart,
  );
  assert.ok(html.indexOf('name="append"', bounds.conversationStart) < bounds.contextStart);
  assert.equal(count(html, '<details class="agent-composer-options">'), 0);
});

test("proof swarm starts in conversation and keeps worker runtime controls disclosed", () => {
  const html = axiomSimpleShell(
    "agents/axiom-simple",
    [{ id: "demo", label: "Demo", problem: "theorem demo : True := by trivial" }],
    undefined,
    undefined,
    { basePath: "/proof-swarm" },
  );
  const bounds = assertRoomFirstComposer(html, {
    rootId: "proof-swarm-views",
    prefix: "as",
    problemId: "as-problem",
  });

  assertOptionsDisclosure(html, bounds, ["workerCount", "repairMode"]);
  assert.ok(
    html.indexOf('action="/proof-swarm/run?stream=agents%2Faxiom-simple" method="post"', bounds.conversationStart)
      < bounds.contextStart,
  );
});
