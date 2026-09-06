import assert from "node:assert/strict";
import test from "node:test";

import { codingSlackWorkspaceCss } from "../../src/views/coding-workspace-style.ts";

test("Coding uses one full-window Slack workspace contract", () => {
  assert.match(codingSlackWorkspaceCss, /--coding-rail-width:240px/);
  assert.match(codingSlackWorkspaceCss, /--coding-workbench-width:336px/);
  assert.match(codingSlackWorkspaceCss, /\.coding-page \.coding-workbench\{[^}]*height:100dvh[^}]*padding:0/);
  assert.match(codingSlackWorkspaceCss, /grid-template-columns:var\(--coding-rail-width\) minmax\(0,1fr\)/);
  assert.match(codingSlackWorkspaceCss, /\.coding-page \.coding-conversation\{[^}]*border-radius:0/);
  assert.match(codingSlackWorkspaceCss, /\.coding-page \.coding-rail-toggle,\.coding-page \.coding-rail-close\{display:none/);
  assert.match(codingSlackWorkspaceCss, /@media\(max-width:899px\)\{[\s\S]*?\.coding-page \.coding-project-rail\{[^}]*display:none/);
  assert.match(codingSlackWorkspaceCss, /:root\[data-overlay-open="rail"\] \.coding-page \.coding-project-rail:not\(\[hidden\]\)\{display:block/);
  assert.match(codingSlackWorkspaceCss, /\.coding-page :is\(\.coding-rail-toggle,\.coding-rail-close\)\{[^}]*min-height:44px/);
  assert.doesNotMatch(codingSlackWorkspaceCss, /@media\(max-width:899px\)\{[\s\S]*?\.coding-page \.coding-project-rail\{[^}]*display:block/);
  assert.match(codingSlackWorkspaceCss, /@media\(max-width:700px\)\{\.coding-page \.coding-room\{[^}]*min-height:var\(--coding-room-header-height\)[^}]*\}\.coding-page \.coding-room-social\{display:flex\}/);
  assert.match(codingSlackWorkspaceCss, /\.coding-page \.coding-room-social>:is\(\.room-roster,\.coding-command-trigger\)\{display:none\}/);
  assert.match(codingSlackWorkspaceCss, /\.coding-page \.coding-context-cast>\.coding-room-context-head\{position:sticky;top:0;margin:0;padding:0 12px\}/);
  assert.match(codingSlackWorkspaceCss, /\.coding-page \.coding-new-messages\{position:relative;z-index:25;grid-column:1;grid-row:1;align-self:end;justify-self:end;margin:0 20px 12px\}/);
  assert.doesNotMatch(codingSlackWorkspaceCss, /\.coding-page \.coding-new-messages\{[^}]*\bbottom:/u);
  assert.doesNotMatch(codingSlackWorkspaceCss, /padding:8px 8px 8px 0/);
  assert.doesNotMatch(codingSlackWorkspaceCss, /--workspace-rail-width:274px/);
});
