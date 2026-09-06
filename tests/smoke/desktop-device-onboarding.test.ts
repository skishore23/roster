import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertDesktopStateContainsNoCredentials,
  createDesktopDeviceIdentity,
  createDesktopSidecarStateApi,
  DESKTOP_DEVICE_IDENTITY_SCHEMA_VERSION,
  DESKTOP_ONBOARDING_SCHEMA_VERSION,
  normalizeDesktopDeviceIdentity,
  normalizeDesktopOnboardingState,
  normalizeManagedSpacetimeBootstrapConfig,
  serializeDesktopOnboardingState,
} from "../../src/desktop/index.ts";

const onboardingInput = (repositoryPath: string) => ({
  schemaVersion: DESKTOP_ONBOARDING_SCHEMA_VERSION,
  selectedRepository: {
    path: repositoryPath,
    name: "  Roster   Workspace ",
  },
  runtimeProfiles: [
    {
      id: "codex.local",
      label: " Codex ",
      runtimeKind: "codex-cli",
      command: ["/opt/roster/bin/codex", "exec"],
      access: "workspace-write",
      source: "discovered",
      enabled: true,
    },
    {
      id: "review.local",
      label: "Review command",
      runtimeKind: "custom-review",
      command: ["/opt/roster/bin/review", "--stdio"],
      access: "read-only",
      source: "manual",
      enabled: false,
    },
  ],
  defaultRuntimeId: "codex.local",
});

test("desktop installation identity is random, bounded, and normalized without hardware input", () => {
  const first = createDesktopDeviceIdentity({
    now: () => new Date("2026-07-24T12:00:00.000Z"),
    randomSource: () => Uint8Array.from({ length: 24 }, (_, index) => index),
  });
  const second = createDesktopDeviceIdentity({
    now: () => new Date("2026-07-24T12:00:00.000Z"),
    randomSource: () => Uint8Array.from({ length: 24 }, (_, index) => index + 1),
  });

  assert.deepEqual(first, {
    schemaVersion: DESKTOP_DEVICE_IDENTITY_SCHEMA_VERSION,
    deviceId: "device_AAECAwQFBgcICQoLDA0ODxAREhMUFRYX",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  assert.notEqual(first.deviceId, second.deviceId);
  assert.equal(first.deviceId.length, 39);
  assert.deepEqual(normalizeDesktopDeviceIdentity({
    ...first,
    serialNumber: "must-not-be-read",
  }), first);
  assert.throws(
    () => createDesktopDeviceIdentity({ randomSource: () => new Uint8Array(8) }),
    /must return 24 bytes/,
  );
});

test("desktop sidecar persists one private device identity and refuses corrupt rotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-desktop-identity-"));
  const api = createDesktopSidecarStateApi(join(root, "state"));
  try {
    const first = await api.loadDeviceIdentity();
    const second = await api.loadDeviceIdentity();
    assert.deepEqual(second, first);
    assert.match(first.deviceId, /^device_[A-Za-z0-9_-]{32}$/);

    if (process.platform !== "win32") {
      const mode = (await stat(api.deviceIdentityPath)).mode & 0o777;
      assert.equal(mode, 0o600);
    }

    await writeFile(api.deviceIdentityPath, "{not-json", "utf8");
    await assert.rejects(api.loadDeviceIdentity(), /is not valid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop onboarding derives readiness from repository and enabled runtime profiles", () => {
  const root = join(tmpdir(), "roster-onboarding-repository");
  const state = normalizeDesktopOnboardingState(onboardingInput(root));

  assert.equal(state.stage, "ready");
  assert.equal(state.defaultRuntimeId, "codex.local");
  assert.deepEqual(state.selectedRepository, {
    path: root,
    name: "Roster Workspace",
  });
  assert.deepEqual(state.runtimeProfiles[0], {
    id: "codex.local",
    label: "Codex",
    runtimeKind: "codex-cli",
    command: ["/opt/roster/bin/codex", "exec"],
    access: "workspace-write",
    source: "discovered",
    enabled: true,
  });

  assert.equal(normalizeDesktopOnboardingState({
    runtimeProfiles: [],
  }).stage, "repository");
  assert.equal(normalizeDesktopOnboardingState({
    selectedRepository: { path: root, name: "Repository" },
    runtimeProfiles: state.runtimeProfiles.map((profile) => ({
      ...profile,
      enabled: false,
    })),
  }).stage, "runtimes");
  assert.throws(() => normalizeDesktopOnboardingState({
    ...onboardingInput(root),
    defaultRuntimeId: "review.local",
  }), /default runtime must name an enabled runtime profile/);
});

test("desktop onboarding validates bounded repositories and provider-neutral commands", () => {
  const root = join(tmpdir(), "roster-onboarding-validation");
  assert.throws(
    () => normalizeDesktopOnboardingState({
      selectedRepository: { path: "relative/repository", name: "Repository" },
      runtimeProfiles: [],
    }),
    /bounded absolute path/,
  );
  assert.throws(
    () => normalizeDesktopOnboardingState({
      selectedRepository: { path: root, name: "Repository" },
      runtimeProfiles: [
        onboardingInput(root).runtimeProfiles[0],
        onboardingInput(root).runtimeProfiles[0],
      ],
    }),
    /duplicate runtime profile codex.local/,
  );
  assert.throws(
    () => normalizeDesktopOnboardingState({
      selectedRepository: { path: root, name: "Repository" },
      runtimeProfiles: [{
        id: "custom.local",
        label: "Custom",
        runtimeKind: "custom-runtime",
        command: [],
        access: "read-only",
        source: "manual",
        enabled: true,
      }],
    }),
    /requires a command/,
  );
});

test("managed SpacetimeDB bootstrap is anonymous, bounded, and credential-free", () => {
  assert.deepEqual(normalizeManagedSpacetimeBootstrapConfig({
    uri: " https://maincloud.spacetimedb.com/ ",
    database: " roster-production ",
  }), {
    schemaVersion: "roster.desktop-spacetime.v1",
    uri: "https://maincloud.spacetimedb.com",
    database: "roster-production",
    sessionMode: "anonymous-device",
    connectTimeoutMs: 10_000,
    confirmedReads: true,
  });

  assert.throws(
    () => normalizeManagedSpacetimeBootstrapConfig({
      uri: "https://user:password@maincloud.spacetimedb.com",
      database: "roster",
    }),
    /must not contain credentials/,
  );
  assert.throws(
    () => normalizeManagedSpacetimeBootstrapConfig({
      uri: "http://maincloud.spacetimedb.com",
      database: "roster",
    }),
    /must use HTTPS/,
  );
  assert.equal(normalizeManagedSpacetimeBootstrapConfig({
    uri: "http://127.0.0.1:3000",
    database: "roster-local",
    confirmedReads: false,
  }).confirmedReads, false);
});

test("desktop onboarding serialization allowlists state and excludes credentials", () => {
  const root = join(tmpdir(), "roster-onboarding-serialization");
  const tainted = {
    ...onboardingInput(root),
    password: "root-password",
    authToken: "spacetime-token",
    selectedRepository: {
      ...onboardingInput(root).selectedRepository,
      apiKey: "repository-secret",
    },
    runtimeProfiles: onboardingInput(root).runtimeProfiles.map((profile) => ({
      ...profile,
      credential: "agent-secret",
    })),
  };
  const serialized = serializeDesktopOnboardingState(tainted);
  assert.doesNotMatch(serialized, /root-password|spacetime-token|repository-secret|agent-secret/);
  assert.doesNotMatch(serialized, /password|authToken|apiKey|credential/);
  assert.equal(JSON.parse(serialized).stage, "ready");
  assert.throws(
    () => assertDesktopStateContainsNoCredentials(tainted),
    /must not contain credentials/,
  );
  assert.doesNotThrow(() => assertDesktopStateContainsNoCredentials(JSON.parse(serialized)));
});

test("Tauri sidecar state API saves onboarding and returns a complete bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-desktop-sidecar-"));
  const repositoryPath = join(root, "repository");
  const dataDirectory = join(root, "state");
  await mkdir(repositoryPath);
  const api = createDesktopSidecarStateApi(dataDirectory);
  try {
    assert.equal((await api.loadOnboarding()).stage, "repository");
    const saved = await api.saveOnboarding(onboardingInput(repositoryPath));
    assert.equal(saved.stage, "ready");

    const persisted = await readFile(api.onboardingPath, "utf8");
    assert.doesNotMatch(persisted, /token|password|secret/i);
    if (process.platform !== "win32") {
      const mode = (await stat(api.onboardingPath)).mode & 0o777;
      assert.equal(mode, 0o600);
    }

    const bootstrap = await api.bootstrap({
      uri: "https://maincloud.spacetimedb.com",
      database: "roster-production",
      token: "must-not-be-projected",
    });
    assert.equal(bootstrap.schemaVersion, "roster.desktop-bootstrap.v1");
    assert.match(bootstrap.device.deviceId, /^device_/);
    assert.equal(bootstrap.spacetime.sessionMode, "anonymous-device");
    assert.equal(bootstrap.onboarding.stage, "ready");
    assert.equal("token" in bootstrap.spacetime, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
