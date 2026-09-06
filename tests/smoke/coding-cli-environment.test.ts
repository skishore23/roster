import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { runCommand } from "../../src/engine/runtime/command-node-runtime.ts";
import {
  ROSTER_CODING_VALIDATION_ENV_FILE,
  ROSTER_CODING_VALIDATION_ENV_KEYS,
  resolveCodingCliEnvironment,
  resolveCodingValidationEnvironment,
} from "../../src/engine/runtime/coding-cli-environment.ts";
import { standardNodeRuntimeEnvironments } from "../../src/engine/runtime/standard-node-runtimes.ts";

test("coding CLI discovery and execution share a trusted executable path", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-coding-cli-environment-"));
  const bundle = join(root, "ChatGPT.app", "Contents", "Resources");
  const executable = join(bundle, "codex");
  await mkdir(bundle, { recursive: true });
  try {
    await writeFile(executable, "#!/bin/sh\nprintf 'codex-from-desktop-bundle\\n'\n");
    await chmod(executable, 0o755);
    const originalPath = ["/usr/bin", "/bin"].join(delimiter);
    const environment = resolveCodingCliEnvironment(
      { PATH: originalPath },
      process.platform,
      [bundle],
    );

    assert.equal(environment.PATH, ["/usr/bin", "/bin", bundle].join(delimiter));
    const result = await runCommand({
      command: "codex",
      args: [],
      stdin: "",
      env: environment,
      maxOutputBytes: 4_096,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "codex-from-desktop-bundle\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit Roster coding CLI path takes precedence without accepting missing directories", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-coding-cli-explicit-"));
  const executable = join(root, "codex");
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    const originalPath = ["/usr/bin", "/bin"].join(delimiter);
    const environment = resolveCodingCliEnvironment({
      PATH: originalPath,
      ROSTER_CODING_CLI_PATH: [join(root, "missing"), root].join(delimiter),
    }, process.platform, []);

    assert.equal(environment.PATH, [root, "/usr/bin", "/bin"].join(delimiter));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit Roster coding CLI path recognizes a Hermes-only installation", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-coding-cli-hermes-"));
  const executable = join(root, "hermes");
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    const environment = resolveCodingCliEnvironment({
      PATH: "/usr/bin",
      ROSTER_CODING_CLI_PATH: root,
    }, process.platform, []);

    assert.equal(environment.PATH, [root, "/usr/bin"].join(delimiter));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository validation selects bounded dotenv keys without exposing them to model runtimes", () => {
  const selector = {
    [ROSTER_CODING_VALIDATION_ENV_FILE]: "/secure/customer.env",
    [ROSTER_CODING_VALIDATION_ENV_KEYS]: "DATABASE_URL, FEATURE_FLAG, DATABASE_URL",
  };
  const validation = resolveCodingValidationEnvironment(
    selector,
    () => Buffer.from([
      "DATABASE_URL=postgresql://user:pass@example.test/database",
      "FEATURE_FLAG=enabled",
      "UNSELECTED_SECRET=do-not-forward",
    ].join("\n")),
  );
  assert.deepEqual(validation, {
    DATABASE_URL: "postgresql://user:pass@example.test/database",
    FEATURE_FLAG: "enabled",
  });

  const environments = standardNodeRuntimeEnvironments({
    codingEnvironment: { PATH: process.env.PATH ?? "/usr/bin" },
    commandEnvironment: validation,
  });
  assert.equal(environments.coding.DATABASE_URL, undefined);
  assert.equal(environments.coding.FEATURE_FLAG, undefined);
  assert.equal(environments.command.DATABASE_URL, validation.DATABASE_URL);
  assert.equal(environments.command.FEATURE_FLAG, "enabled");
  assert.equal(environments.command.UNSELECTED_SECRET, undefined);
});

test("SpacetimeDB credentials are available only to host validation commands", () => {
  const environments = standardNodeRuntimeEnvironments({
    codingEnvironment: {
      ROSTER_WORKSPACE_ID: "workspace-test",
    },
    commandEnvironment: {
      SPACETIMEDB_URI: "http://127.0.0.1:3000",
      SPACETIMEDB_DATABASE: "roster-test",
      SPACETIMEDB_TOKEN: "host-only-token",
    },
  });

  assert.equal(environments.coding.SPACETIMEDB_TOKEN, undefined);
  assert.equal(environments.coding.SPACETIMEDB_DATABASE, undefined);
  assert.equal(environments.command.SPACETIMEDB_TOKEN, "host-only-token");
  assert.equal(environments.command.ROSTER_WORKSPACE_ID, "workspace-test");
});

test("repository validation environment configuration fails closed", () => {
  assert.throws(() => resolveCodingValidationEnvironment({
    [ROSTER_CODING_VALIDATION_ENV_FILE]: "/secure/customer.env",
  }, () => Buffer.from("")), /must be configured together/);
  assert.throws(() => resolveCodingValidationEnvironment({
    [ROSTER_CODING_VALIDATION_ENV_FILE]: "relative.env",
    [ROSTER_CODING_VALIDATION_ENV_KEYS]: "DATABASE_URL",
  }, () => Buffer.from("")), /must be an absolute path/);
  assert.throws(() => resolveCodingValidationEnvironment({
    [ROSTER_CODING_VALIDATION_ENV_FILE]: "/secure/customer.env",
    [ROSTER_CODING_VALIDATION_ENV_KEYS]: "NODE_OPTIONS",
  }, () => Buffer.from("NODE_OPTIONS=--require=attack.js")), /unsafe key NODE_OPTIONS/);
  assert.throws(() => resolveCodingValidationEnvironment({
    [ROSTER_CODING_VALIDATION_ENV_FILE]: "/secure/customer.env",
    [ROSTER_CODING_VALIDATION_ENV_KEYS]: "PYTHONPATH",
  }, () => Buffer.from("PYTHONPATH=/tmp/attack")), /unsafe key PYTHONPATH/);
  assert.throws(() => resolveCodingValidationEnvironment({
    [ROSTER_CODING_VALIDATION_ENV_FILE]: "/secure/customer.env",
    [ROSTER_CODING_VALIDATION_ENV_KEYS]: "DATABASE_URL",
  }, () => Buffer.from("OTHER=value")), /does not define selected key DATABASE_URL/);
});
