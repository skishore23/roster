import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createDesktopDeviceIdentity,
  desktopRuntimeEnvironment,
  normalizeDesktopOnboardingState,
  normalizeManagedSpacetimeBootstrapConfig,
} from "../../src/desktop/index.ts";

test("desktop runtime maps accountless onboarding into one device-scoped Roster process", () => {
  const repository = join(tmpdir(), "roster-desktop-runtime-repository");
  const dataDirectory = join(tmpdir(), "roster-desktop-runtime-data");
  const device = createDesktopDeviceIdentity({
    now: () => new Date("2026-07-24T12:00:00.000Z"),
    randomSource: () => new Uint8Array(24).fill(4),
  });
  const onboarding = normalizeDesktopOnboardingState({
    selectedRepository: { path: repository, name: "Example repository" },
    runtimeProfiles: [{
      id: "codex.local",
      label: "Codex",
      runtimeKind: "codex-cli",
      command: ["/opt/roster/bin/codex"],
      access: "workspace-write",
      source: "discovered",
      enabled: true,
    }],
  });
  const spacetime = normalizeManagedSpacetimeBootstrapConfig({
    uri: "https://maincloud.spacetimedb.com",
    database: "roster-production",
  });

  const runtime = desktopRuntimeEnvironment({
    dataDirectory,
    device,
    onboarding,
    spacetime,
    port: 18_787,
    inheritedPath: "/usr/bin",
  });

  assert.equal(runtime.cwd, repository);
  assert.equal(runtime.env.PORT, "18787");
  assert.equal(runtime.env.SPACETIMEDB_URI, "https://maincloud.spacetimedb.com");
  assert.equal(runtime.env.SPACETIMEDB_DATABASE, "roster-production");
  assert.match(
    runtime.env.SPACETIMEDB_TOKEN_PATH!,
    /spacetimedb-identity-[a-f0-9]{16}\.token$/u,
  );
  assert.equal(runtime.env.ROSTER_WORKSPACE_ID, `roster/${device.deviceId}`);
  assert.equal(runtime.env.ROSTER_SERVER_SURFACE, "repository");
  assert.equal(runtime.env.ROSTER_CODING_CLI_PATH, "/opt/roster/bin");
  assert.equal(runtime.env.PATH, `/opt/roster/bin${process.platform === "win32" ? ";" : ":"}/usr/bin`);
  assert.equal(runtime.env.SPACETIMEDB_TOKEN, undefined);

  const localRuntime = desktopRuntimeEnvironment({
    dataDirectory,
    device,
    onboarding,
    spacetime: normalizeManagedSpacetimeBootstrapConfig({
      uri: "http://127.0.0.1:3000",
      database: "roster-local",
    }),
    port: 18_788,
  });
  assert.notEqual(
    localRuntime.env.SPACETIMEDB_TOKEN_PATH,
    runtime.env.SPACETIMEDB_TOKEN_PATH,
    "local and production control planes must never share an identity token",
  );
});

test("desktop runtime refuses incomplete onboarding and unsafe ports", () => {
  const device = createDesktopDeviceIdentity();
  const spacetime = normalizeManagedSpacetimeBootstrapConfig({
    uri: "http://127.0.0.1:3000",
    database: "roster-local",
  });
  assert.throws(() => desktopRuntimeEnvironment({
    dataDirectory: join(tmpdir(), "roster-desktop-runtime-data"),
    device,
    onboarding: normalizeDesktopOnboardingState({ runtimeProfiles: [] }),
    spacetime,
    port: 18_787,
  }), /requires completed repository and agent onboarding/);
  assert.throws(() => desktopRuntimeEnvironment({
    dataDirectory: join(tmpdir(), "roster-desktop-runtime-data"),
    device,
    onboarding: normalizeDesktopOnboardingState({
      selectedRepository: {
        path: join(tmpdir(), "roster-desktop-runtime-repository"),
        name: "Repository",
      },
      runtimeProfiles: [{
        id: "codex.local",
        label: "Codex",
        runtimeKind: "codex-cli",
        command: ["/opt/roster/bin/codex"],
        access: "workspace-write",
        source: "discovered",
        enabled: true,
      }],
    }),
    spacetime,
    port: 80,
  }), /between 1024 and 65535/);
});
