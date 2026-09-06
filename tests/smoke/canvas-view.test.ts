import assert from "node:assert/strict";
import test from "node:test";

import { canvasShell } from "../../src/views/canvas.ts";

const renderCanvas = (options: {
  readonly runId?: string;
  readonly apiReady?: boolean;
} = {}): string => canvasShell({
  stream: "agents/canvas",
  ...(options.runId ? { runId: options.runId } : {}),
  csrfToken: "canvas-view-test-token",
  apiReady: options.apiReady ?? true,
  apiNote: "Model access is unavailable for this test.",
});

const count = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0;

test("Canvas keeps the human-agent conversation beside the contextual scene artifact", () => {
  const html = renderCanvas();
  const messagesStart = html.indexOf('data-slot="workspace-conversation"');
  const contextStart = html.indexOf('data-slot="workspace-context"');
  const workStart = html.indexOf('id="canvas-studio-tabs-context-tabs-panel-workspace"');
  const runsStart = html.indexOf('id="canvas-studio-tabs-context-tabs-panel-runs"');
  const replayStart = html.indexOf('id="canvas-replay"');

  assert.ok(messagesStart > 0, "missing conversation region");
  assert.ok(contextStart > messagesStart, "context must follow conversation");
  assert.ok(workStart > contextStart, "Work must live in context");
  assert.ok(runsStart > workStart, "Runs must follow Work");
  assert.ok(replayStart > runsStart, "replay must live in room context");
  assert.match(html, /data-agent-tab="workspace"><span>Scene<\/span>/);

  const messages = html.slice(messagesStart, contextStart);
  const work = html.slice(workStart, runsStart);

  assert.match(messages, /data-slot="canvas-conversation"/);
  assert.match(messages, /id="studio-floor"[^>]*aria-busy="false"/);
  assert.match(messages, /<h2 class="sr-only" id="studio-floor-title">Team conversation<\/h2>/);
  assert.match(messages, /<h3 class="sr-only" id="studio-events-title">Messages<\/h3>/);
  assert.match(messages, /class="agent-message studio-status-message"/);
  assert.match(messages, /<ol class="agent-message-thread studio-event-strip" id="studio-event-strip"><\/ol>/);
  assert.match(messages, /<ul class="studio-agent-strip" id="studio-agent-strip"/);
  assert.doesNotMatch(messages, /studio-floor-grid|studio-floor-section/);
  assert.match(messages, /id="canvas-run-form"/);
  assert.ok(
    messages.indexOf('id="studio-event-strip"') < messages.indexOf('id="canvas-run-form"'),
    "the collaboration feed should read before the composer",
  );
  assert.doesNotMatch(messages, /id="canvas-stage"|class="metric-grid"|id="activity-list"/);

  assert.match(work, /class="metric-grid"/);
  assert.match(work, /id="canvas-stage"/);
  assert.match(work, /id="canvas-scene"/);
  assert.doesNotMatch(work, /id="activity-list"/);
});

test("Canvas roster uses durable identities and conservative presence claims", () => {
  const idle = renderCanvas();
  const selected = renderCanvas({ runId: "canvas_selected_run" });

  assert.match(idle, /data-node-id="human\.operator" data-kind="human" data-presence="present"/);
  assert.match(idle, /data-node-id="orchestrator" data-kind="system" data-presence="waiting"/);
  assert.match(idle, /<strong>Art Director<\/strong>/);
  assert.match(idle, /Specialists appear by name only after the run publishes their assignments/);
  assert.doesNotMatch(idle, /data-node-id="(?:agent-artists|agent-council|system-director)"/);

  assert.match(selected, /data-room-state="active"/);
  assert.match(selected, /Run selected/);
  assert.match(selected, /data-node-id="orchestrator" data-kind="system" data-presence="joined"/);
});

test("Canvas room markup keeps IDs, live regions, and mobile motion behavior accessible", () => {
  const html = renderCanvas({ apiReady: false });
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];

  assert.deepEqual(duplicateIds, []);
  assert.equal(count(html, /id="activity-list"/g), 1);
  assert.equal(count(html, /id="studio-event-strip"/g), 1);
  assert.equal(count(html, /id="studio-agent-strip"/g), 1);
  assert.match(html, /id="studio-live-copy" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /id="activity-count" role="status" aria-live="polite" aria-atomic="true"/);
  assert.doesNotMatch(html, /id="(?:activity-list|canvas-run-list)"[^>]*aria-live/);
  assert.match(html, /id="canvas-prompt"[^>]*enterkeyhint="send"[^>]*placeholder="[^"]+…"/);
  assert.match(html, /id="canvas-parallel"[^>]*aria-describedby="canvas-artist-range"/);
  assert.match(html, /id="canvas-artist-range"/);
  assert.match(html, /class="api-note" role="alert"/);
  assert.match(html, /class="coding-composer agent-composer"/);
  assert.match(html, /data-slot="composer-input"/);
  assert.match(html, /data-slot="composer-submit"/);
  assert.match(html, /\.canvas-app\.agent-unified-page \.agent-main\{align-content:stretch\}/);
  assert.match(html, /@media\(max-width:560px\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)[\s\S]*animation:none!important/);
  assert.doesNotMatch(html, /transition:\s*all\b/);
});
