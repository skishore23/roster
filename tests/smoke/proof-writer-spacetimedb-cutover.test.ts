import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { theoremShell } from "../../src/views/theorem.js";
import { writerShell } from "../../src/views/writer.js";
import type { RosterRealtimeBootConfig } from "../../src/views/roster-realtime.js";

const realtimeBoot = (domain: RosterRealtimeBootConfig["domain"], stream: string): RosterRealtimeBootConfig => ({
  domain,
  stream,
  runId: "run-direct",
  runStream: `${stream}/runs/run-direct`,
  workspaceId: "roster/default",
  capabilitySecret: "test-only-secret",
  realtime: {
    enabled: true,
    uri: "http://127.0.0.1:3000",
    database: "roster-test",
    confirmedReads: true,
  },
});

test("adaptive, verified, and writer routes have no HTMX or SSE transport surface", async () => {
  const [theoremRoute, writerRoute, axiomRoute] = await Promise.all([
    readFile(new URL("../../src/agents/theorem.agent.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/agents/writer.agent.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/agents/axiom.agent.ts", import.meta.url), "utf8"),
  ]);

  for (const source of [theoremRoute, writerRoute, axiomRoute]) {
    assert.doesNotMatch(source, /\bhtmx\b|\bhx-[\w-]+\b|EventSource|sse-connect|SseHub|sse\.subscribe/i);
    assert.doesNotMatch(source, /(?:\$\{basePath\}|\/(?:theorem|writer|axiom))\/(?:island|stream|travel)\b/);
  }
  assert.match(theoremRoute, /header: "Location"/);
  assert.match(writerRoute, /header: "Location"/);
  assert.match(theoremRoute, /c\.redirect\([^]*303,/);
  assert.match(writerRoute, /c\.redirect\([^]*303,/);
  assert.match(axiomRoute, /basePath: "\/axiom"/);
});

test("adaptive, verified, and writer shells boot the direct SpacetimeDB client", () => {
  const theorem = theoremShell(
    "agents/theorem",
    [],
    "run-direct",
    null,
    undefined,
    { realtime: { boot: realtimeBoot("theorem", "agents/theorem"), nonce: "test-nonce" } },
  );
  const axiom = theoremShell(
    "agents/axiom-roster",
    [],
    "run-direct",
    null,
    undefined,
    {
      basePath: "/axiom",
      realtime: { boot: realtimeBoot("axiom", "agents/axiom-roster"), nonce: "test-nonce" },
    },
  );
  const writer = writerShell(
    "agents/writer",
    [],
    "run-direct",
    null,
    undefined,
    { boot: realtimeBoot("writer", "agents/writer"), nonce: "test-nonce" },
  );

  for (const html of [theorem, axiom, writer]) {
    assert.match(html, /id="roster-realtime-boot"/);
    assert.match(html, /src="\/assets\/roster-client\.js"/);
    assert.doesNotMatch(html, /\bhtmx\b|\shx-[\w-]+\s*=|EventSource|sse-connect/i);
  }
});

test("shared Roster browser scopes logical stream, branch, and job selectors to the active workspace", async () => {
  const browser = await readFile(new URL("../../src/browser/roster-client.ts", import.meta.url), "utf8");
  assert.match(browser, /row\.workspaceId\.eq\(boot\.workspaceId\)\.and\(row\.streamId\.eq\(streamId\)\)/);
  assert.match(browser, /row\.workspaceId\.eq\(boot\.workspaceId\)\.and\(row\.parentStreamId\.eq\(runStream\)\)/);
  assert.match(browser, /row\.workspaceId\.eq\(boot\.workspaceId\)\.and\(row\.id\.eq\(selectedJobId\)\)/);
  assert.match(browser, /tables\.myRosterParticipantProfiles\.where\(\(row\) => row\.workspaceId\.eq\(boot\.workspaceId\)\)/);
  assert.match(browser, /myRosterParticipantProfiles\.onUpdate/);
  assert.match(browser, /applyParticipantProfile/);
  assert.match(browser, /if \(row\.workspaceId !== boot\.workspaceId\) return;/);
  assert.match(browser, /row\.workspaceId === boot\.workspaceId && row\.parentStreamId === runStream/);
});

test("browser-shared orchestration uses runtime-neutral CRDT base64", async () => {
  const [orchestration, base64] = await Promise.all([
    readFile(new URL("../../src/modules/orchestration.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/core/base64.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(orchestration, /\bBuffer\b/);
  assert.match(orchestration, /base64ToBytes/);
  assert.match(orchestration, /bytesToBase64/);
  assert.match(base64, /\bbtoa\(/);
  assert.match(base64, /\batob\(/);
});
