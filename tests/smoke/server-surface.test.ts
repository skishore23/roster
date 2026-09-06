import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveRosterServerSurface,
  selectServerSurfaceJobHandlers,
  serverSurfaceAgentModuleNames,
  serverSurfaceAllowsPath,
} from "../../src/runtime/server-surface.ts";

test("repository server surface admits only repository-agent HTTP paths", () => {
  for (const pathname of [
    "/",
    "/healthz",
    "/readyz",
    "/coding",
    "/coding/run",
    "/api/v2/coding/runs",
    "/assets/coding-client.js",
    "/assets/coding-enhancements.js",
    "/assets/coding-mermaid-renderer.js",
    "/assets/roster-shell.js",
  ]) {
    assert.equal(serverSurfaceAllowsPath("repository", pathname), true, pathname);
  }

  for (const pathname of [
    "/theorem",
    "/writer",
    "/canvas",
    "/agent",
    "/agents/coding-agent",
    "/agents/theorem/jobs",
    "/jobs",
    "/memory/scopes",
    "/improvement",
    "/api/v2/room-os/health",
    "/assets/canvas-client.js",
    "/assets/roster-client.js",
    "/coding-elsewhere",
    "/api/v2/coding-elsewhere",
  ]) {
    assert.equal(serverSurfaceAllowsPath("repository", pathname), false, pathname);
  }

  assert.equal(serverSurfaceAllowsPath("full", "/anything"), true);
});

test("repository server surface loads and claims only coding-agent work", () => {
  assert.deepEqual(serverSurfaceAgentModuleNames("repository"), ["coding"]);
  assert.equal(serverSurfaceAgentModuleNames("full"), undefined);
  const handlers = selectServerSurfaceJobHandlers("repository", {
    "coding-agent": "coding",
    theorem: "theorem",
    writer: "writer",
  });
  assert.deepEqual(handlers, { "coding-agent": "coding" });
  assert.throws(
    () => selectServerSurfaceJobHandlers("repository", { theorem: "theorem" }),
    /requires the coding-agent job handler/,
  );
});

test("server surface configuration defaults to full and rejects unknown values", () => {
  assert.equal(resolveRosterServerSurface({}), "full");
  assert.equal(resolveRosterServerSurface({ ROSTER_SERVER_SURFACE: "repository" }), "repository");
  assert.throws(
    () => resolveRosterServerSurface({ ROSTER_SERVER_SURFACE: "public" }),
    /Unsupported Roster server surface "public"/,
  );
});
