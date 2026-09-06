import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveSpacetimeControlConfig,
  spacetimeEnabled,
  spacetimeStartupFailure,
} from "../../src/adapters/spacetimedb-control.js";

test("SpacetimeDB is authoritative by default and only an explicit zero disables it", () => {
  assert.equal(spacetimeEnabled({}), true);
  assert.equal(spacetimeEnabled({ SPACETIMEDB_ENABLED: "true" }), true);
  assert.equal(spacetimeEnabled({ SPACETIMEDB_ENABLED: "1" }), true);
  assert.equal(spacetimeEnabled({ SPACETIMEDB_ENABLED: "0" }), false);

  const tokenPath = path.join(os.tmpdir(), `roster-spacetimedb-missing-${process.pid}.token`);
  assert.deepEqual(resolveSpacetimeControlConfig({ SPACETIMEDB_TOKEN_PATH: tokenPath }), {
    uri: "http://127.0.0.1:3000",
    database: "roster-local",
    token: undefined,
    tokenPath,
    connectTimeoutMs: 10_000,
    confirmedReads: false,
  });
});

test("SpacetimeDB configuration clamps timeouts and does not retain blank tokens", () => {
  const tokenPath = path.join(os.tmpdir(), `roster-spacetimedb-blank-${process.pid}.token`);
  assert.deepEqual(resolveSpacetimeControlConfig({
    SPACETIMEDB_URI: " https://maincloud.spacetimedb.com ",
    SPACETIMEDB_DATABASE: " canvas-production ",
    SPACETIMEDB_TOKEN: " ",
    SPACETIMEDB_TOKEN_PATH: tokenPath,
    SPACETIMEDB_CONNECT_TIMEOUT_MS: "900000",
    SPACETIMEDB_CONFIRMED_READS: "1",
  }), {
    uri: "https://maincloud.spacetimedb.com",
    database: "canvas-production",
    token: undefined,
    tokenPath,
    connectTimeoutMs: 60_000,
    confirmedReads: true,
  });
});

test("an explicit service token wins over the local token file", () => {
  assert.deepEqual(resolveSpacetimeControlConfig({
    SPACETIMEDB_TOKEN: " service-token ",
    SPACETIMEDB_TOKEN_PATH: "/must/not/be/read",
  }), {
    uri: "http://127.0.0.1:3000",
    database: "roster-local",
    token: "service-token",
    tokenPath: undefined,
    connectTimeoutMs: 10_000,
    confirmedReads: false,
  });
});

test("SpacetimeDB startup failures identify the selected database without exposing credentials", () => {
  const cause = new Error("Table my_workspace_usage not found");
  const failure = spacetimeStartupFailure({
    uri: "http://service:secret@127.0.0.1:3000/?token=private",
    database: "roster-stale",
  }, cause);

  assert.match(failure.message, /database 'roster-stale'/);
  assert.match(failure.message, /SPACETIMEDB_DATABASE/);
  assert.match(failure.message, /publish the current Roster module/);
  assert.match(failure.message, /my_workspace_usage/);
  assert.doesNotMatch(failure.message, /service|secret|private/);
  assert.equal(failure.cause, cause);
});

test("SpacetimeDB ownership failures preserve the security boundary and explain recovery", () => {
  const failure = spacetimeStartupFailure({
    uri: "http://127.0.0.1:3000",
    database: "roster-customer",
  }, new Error("workspace roster/customer belongs to another identity"));

  assert.match(failure.message, /Restore the service identity token/);
  assert.match(failure.message, /new ROSTER_WORKSPACE_ID/);
  assert.match(failure.message, /will not take over or delete/);
});
