import assert from "node:assert/strict";
import test from "node:test";

import {
  generativeUiCardHtml,
  generativeUiCss,
  generativeUiReplyHtml,
} from "../../src/views/generative-ui.ts";

test("generative UI cards render bounded semantic flows and escaped evidence", () => {
  const html = generativeUiCardHtml({
    id: "proposal-contract",
    kind: "proposal",
    label: "Generated proposal",
    summary: "Choose a bounded renderer.",
    flow: {
      label: "Proposal decision map",
      visiblePathLimit: 2,
      paths: [
        { subject: "Rendering", outcome: "Use semantic HTML.", state: "proposed", meta: "90% confidence" },
        { subject: "Authority", outcome: "Keep receipts authoritative.", state: "supported" },
        { subject: "Unsafe <script>", outcome: "Escape model-authored text.", state: "resolved" },
      ],
    },
    disclosure: {
      label: "View Evidence",
      metrics: ["3 decisions", "1 evidence item"],
      items: [{
        title: "Rendering",
        body: "Use a deterministic projection.",
        facts: [{ label: "Evidence", values: ["<script>alert(1)</script>"] }],
      }],
    },
  });

  assert.match(html, /data-generative-ui-card="proposal-contract"/);
  assert.match(html, /data-generative-ui-kind="proposal"/);
  assert.match(html, /aria-label="Proposal decision map"/);
  assert.equal(html.match(/class="generative-ui-flow-subject"/g)?.length, 2);
  assert.match(html, /\+1 more path in the full record/);
  assert.match(html, /data-details-key="generative-ui-proposal-contract"/);
  assert.match(html, /3 decisions · 1 evidence item/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(generativeUiCss(), /prefers-reduced-motion:reduce/);
  assert.match(generativeUiCss(), /max-width:560px/);
});

test("generative UI inline replies are same-origin, native, and bounded", () => {
  const html = generativeUiReplyHtml({
    id: "reply-decision",
    action: "/coding/run",
    title: "Resolve the Decision",
    description: "Roster needs product intent.",
    prompts: ["Delivery: choose inline or attachment."],
    inputLabel: "Your reply",
    placeholder: "State the intended behavior…",
    hiddenFields: [
      { name: "workspaceId", value: "workspace-1" },
      { name: "conversationId", value: "conversation-1" },
    ],
  });

  assert.match(html, /action="\/coding\/run" method="post"/);
  assert.match(html, /data-generative-ui-reply-form/);
  assert.match(html, /name="conversationId" value="conversation-1"/);
  assert.match(html, /name="objective" maxlength="20000" required/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.throws(() => generativeUiReplyHtml({
    id: "bad-action",
    action: "https://example.com/collect",
    title: "Bad",
    description: "Bad action",
    inputLabel: "Reply",
    placeholder: "Reply",
  }), /same-origin path/);
});
