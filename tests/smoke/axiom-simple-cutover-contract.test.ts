import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { axiomSimpleShell } from "../../src/views/axiom-simple.js";

test("Axiom Simple pages use direct SpacetimeDB subscriptions without HTMX or SSE", async () => {
  const routeSource = await readFile(
    new URL("../../src/agents/axiom-simple.agent.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(routeSource, /\bhtmx\b|\bhx-[\w-]+\b|EventSource|sse-connect|sse\.subscribe/i);
  assert.doesNotMatch(routeSource, /axiom-simple\/(?:island|stream|travel)/);
  assert.match(routeSource, /domain: "axiom-simple"/);
  assert.match(routeSource, /surface: "axiom-worker"/);
  assert.match(routeSource, /c\.redirect\([^]*303\)/);

  const html = axiomSimpleShell(
    "agents/axiom-simple",
    [],
    "run-direct",
    null,
    {
      realtime: {
        boot: {
          domain: "axiom-simple",
          stream: "agents/axiom-simple",
          runId: "run-direct",
          runStream: "agents/axiom-simple/runs/run-direct",
          workspaceId: "roster/default",
          capabilitySecret: "test-only-secret",
          realtime: {
            enabled: true,
            uri: "http://127.0.0.1:3000",
            database: "roster-test",
            confirmedReads: true,
          },
        },
        nonce: "test-nonce",
      },
    },
  );
  assert.match(html, /id="roster-realtime-boot"/);
  assert.match(html, /src="\/assets\/roster-client\.js"/);
  assert.match(html, /id="as-travel"[^>]*data-replay-controls/);
  assert.doesNotMatch(html, /\bhtmx\b|\shx-[\w-]+\s*=|EventSource|sse-connect/i);
});
