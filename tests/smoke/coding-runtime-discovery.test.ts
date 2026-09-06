import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUILTIN_CODING_RUNTIME_DESCRIPTORS,
  createCodingRuntimeDiscoveryRegistry,
  parseCodingRuntimeDiscoveryManifest,
} from "../../src/engine/runtime/coding-runtime-discovery.ts";

const writeExecutable = async (path: string, source: string): Promise<void> => {
  await writeFile(path, source);
  await chmod(path, 0o755);
};

test("coding runtime discovery reports path, version, readiness, and access without forwarding secrets", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-runtime-discovery-"));
  try {
    await writeExecutable(join(root, "custom-runtime"), [
      "#!/bin/sh",
      "if [ -n \"$ROSTER_TEST_SECRET\" ]; then exit 91; fi",
      "printf 'custom-runtime 1.2.3\\n'",
    ].join("\n"));
    await writeExecutable(join(root, "probe-failure"), "#!/bin/sh\nexit 7\n");
    const descriptors = parseCodingRuntimeDiscoveryManifest({
      schema: "roster.coding-runtime-discovery.v1",
      runtimes: [
        {
          id: "acme-custom",
          label: "Acme Custom",
          command: ["custom-runtime"],
          access: ["read-only"],
        },
        {
          id: "probe-failure",
          label: "Probe failure",
          command: ["probe-failure"],
          versionArguments: ["version"],
          access: ["workspace-write"],
        },
        {
          id: "not-installed",
          label: "Not installed",
          command: ["definitely-not-installed"],
          access: ["read-only", "workspace-write"],
        },
      ],
    });
    const discovered = await createCodingRuntimeDiscoveryRegistry(descriptors).discover({
      PATH: root,
      ROSTER_TEST_SECRET: "must-not-reach-the-probe",
    }, process.platform);

    assert.deepEqual(discovered.map((runtime) => ({
      id: runtime.descriptor.id,
      available: runtime.available,
      ready: runtime.ready,
      readiness: runtime.readiness,
      version: runtime.version,
      access: runtime.descriptor.access,
    })), [
      {
        id: "acme-custom",
        available: true,
        ready: true,
        readiness: "ready",
        version: "custom-runtime 1.2.3",
        access: ["read-only"],
      },
      {
        id: "probe-failure",
        available: true,
        ready: false,
        readiness: "probe-failed",
        version: undefined,
        access: ["workspace-write"],
      },
      {
        id: "not-installed",
        available: false,
        ready: false,
        readiness: "not-installed",
        version: undefined,
        access: ["read-only", "workspace-write"],
      },
    ]);
    assert.equal(discovered[0]?.executablePath, join(root, "custom-runtime"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding runtime discovery manifests reject duplicate and unsafe descriptors", () => {
  assert.throws(() => parseCodingRuntimeDiscoveryManifest({
    schema: "roster.coding-runtime-discovery.v1",
    runtimes: [
      { id: "same", label: "One", command: ["one"], access: ["read-only"] },
      { id: "same", label: "Two", command: ["two"], access: ["workspace-write"] },
    ],
  }), /duplicated/);
  assert.throws(() => parseCodingRuntimeDiscoveryManifest({
    schema: "roster.coding-runtime-discovery.v1",
    runtimes: [
      { id: "unsafe command", label: "Unsafe", command: ["tool"], access: ["read-only"] },
    ],
  }), /id .* is invalid/);
  assert.throws(() => parseCodingRuntimeDiscoveryManifest({
    schema: "roster.coding-runtime-discovery.v1",
    runtimes: [
      { id: "unsafe-access", label: "Unsafe", command: ["tool"], access: ["admin"] },
    ],
  }), /unsupported mode/);
});

test("the built-in discovery registry covers every supported coding CLI", () => {
  assert.deepEqual(
    BUILTIN_CODING_RUNTIME_DESCRIPTORS.map((descriptor) => descriptor.id),
    ["pi-agent", "hermes-agent", "claude-code", "codex-cli"],
  );
  assert.deepEqual(
    BUILTIN_CODING_RUNTIME_DESCRIPTORS.map((descriptor) => descriptor.command[0]),
    ["pi", "hermes", "claude", "codex"],
  );
});
