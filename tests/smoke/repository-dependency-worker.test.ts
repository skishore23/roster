import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID,
  bindCodingWorkerFunctionProviders,
  createCodingWorkerFunctionDescriptors,
} from "../../src/domains/coding-workers.ts";
import type {
  CommandExecution,
  CommandExecutionResult,
  CommandRunner,
} from "../../src/engine/runtime/command-node-runtime.ts";
import {
  CODING_DEPENDENCY_RESOLUTION_OPERATION,
} from "../../src/engine/runtime/repository-dependency-worker.ts";
import {
  compileRepositoryExecutionProfile,
  repositoryExecutionProfileEvidenceHash,
  type RepositoryExecutionProfile,
} from "../../src/engine/runtime/repository-toolchain.ts";
import { RosterFunctionDirectory } from "../../src/engine/functions/function-directory.ts";
import {
  ROSTER_CATALOG_INVOKE_FUNCTION_ID,
  ROSTER_CATALOG_SEARCH_FUNCTION_ID,
  createRosterFunctionExecutionPlane,
  type RosterFunctionActivity,
} from "../../src/engine/runtime/node-function-plane.ts";

const execFileAsync = promisify(execFile);
const NODE = {
  id: "dependency-worker",
  name: "Dependency Worker",
  capabilities: ["workspace"],
  runtime: { kind: "codex-cli" as const },
};
const TASK = {
  taskId: "resolve-dependencies",
  nodeId: NODE.id,
  capability: "workspace",
};
const AUDIT = JSON.stringify({
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 1,
      moderate: 2,
      high: 3,
      critical: 0,
      total: 6,
    },
  },
});

type Fixture = {
  readonly root: string;
  readonly baselineManifest: string;
  readonly profile: RepositoryExecutionProfile;
};

const git = async (root: string, args: ReadonlyArray<string>): Promise<string> =>
  (await execFileAsync("git", [...args], { cwd: root, encoding: "utf8" })).stdout;

const initializeFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "roster-dependency-worker-"));
  const baselineManifest = `${JSON.stringify({
    name: "dependency-worker-fixture",
    version: "1.0.0",
    scripts: { test: "node --test" },
  }, null, 2)}\n`;
  const baselineLock = `${JSON.stringify({
    name: "dependency-worker-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "dependency-worker-fixture", version: "1.0.0" },
    },
  }, null, 2)}\n`;
  const toolchain = "{\"validated\":true}\n";
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Roster Test"]);
  await Promise.all([
    writeFile(join(root, "package.json"), baselineManifest),
    writeFile(join(root, "package-lock.json"), baselineLock),
    writeFile(join(root, "toolchain.json"), toolchain),
    writeFile(join(root, ".gitignore"), "node_modules/\n"),
  ]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "--no-gpg-sign", "-m", "baseline"]);
  const profile = compileRepositoryExecutionProfile({
    source: "detected",
    repositoryFingerprint: "c".repeat(64),
    evidenceFiles: ["package.json", "package-lock.json", "toolchain.json"],
    evidenceHash: repositoryExecutionProfileEvidenceHash([
      { path: "package.json", content: baselineManifest },
      { path: "package-lock.json", content: baselineLock },
      { path: "toolchain.json", content: toolchain },
    ]),
    installCommands: [{
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
    }],
    verifyCommands: [{
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["test"],
    }],
  });
  return { root, baselineManifest, profile };
};

const editedManifest = (baseline: string, spec = "1.3.0"): string => {
  const manifest = JSON.parse(baseline) as Record<string, unknown>;
  manifest.dependencies = { "left-pad": spec };
  return `${JSON.stringify(manifest, null, 2)}\n`;
};

const publicLock = (): string => `${JSON.stringify({
  name: "dependency-worker-fixture",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "dependency-worker-fixture",
      version: "1.0.0",
      dependencies: { "left-pad": "1.3.0" },
    },
    "node_modules/left-pad": {
      version: "1.3.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      integrity: "sha512-test",
    },
  },
}, null, 2)}\n`;

const fakeRunner = (
  root: string,
  executions: CommandExecution[],
  resolvedLock = publicLock(),
): CommandRunner => async (execution): Promise<CommandExecutionResult> => {
  executions.push(execution);
  assert.equal(execution.command, process.platform === "win32" ? "npm.cmd" : "npm");
  assert.equal(await realpath(execution.cwd!), await realpath(root));
  assert.equal(execution.stdin, "");
  assert.equal(execution.replaceEnvironment, true);
  assert.equal(execution.timeoutMs, 300_000);
  assert.equal(execution.maxOutputBytes, 256 * 1_024);
  assert.ok(execution.signal);
  assert.equal(execution.env?.npm_config_registry, "https://registry.npmjs.org/");
  assert.equal(execution.env?.npm_config_ignore_scripts, "true");
  assert.equal(execution.env?.ROSTER_PARENT_TEST_SECRET, undefined);
  assert.equal(execution.env?.NODE_OPTIONS, undefined);
  assert.equal(execution.env?.NPM_TOKEN, undefined);
  if (execution.args[0] === "install") {
    await writeFile(join(root, "package-lock.json"), resolvedLock);
    return { exitCode: 0, stdout: "lock resolved", stderr: "" };
  }
  if (execution.args[0] === "ci") {
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", "materialized.txt"), "ignored runtime state\n");
    return { exitCode: 0, stdout: "materialized", stderr: "" };
  }
  assert.deepEqual(execution.args, ["audit", "--omit=dev", "--json"]);
  return { exitCode: 1, stdout: AUDIT, stderr: "" };
};

const access = (directory: RosterFunctionDirectory) => ({
  functionGrants: directory.descriptors().map((descriptor) => descriptor.id),
  allowedEffects: ["read", "write", "external"] as const,
});

test("dependency worker is absent from descriptors, providers, catalog search, and direct calls without authority", async () => {
  const fixture = await initializeFixture();
  const directory = new RosterFunctionDirectory(createCodingWorkerFunctionDescriptors());
  const dispose = await bindCodingWorkerFunctionProviders({
    directory,
    workingDirectory: fixture.root,
  });
  try {
    assert.throws(
      () => directory.descriptor(CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID),
      /is not declared/,
    );
    assert.equal(directory.providerBindings().some((binding) =>
      binding.functionId === CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID), false);
    const plane = createRosterFunctionExecutionPlane({
      directory,
      access: () => access(directory),
    });
    const invoke = plane.functionInvoker(NODE, TASK);
    const searched = await invoke({
      functionId: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
      value: { query: "dependencies", capabilities: ["workspace"], limit: 16 },
    }, {
      executionId: "absent",
      runId: "absent",
      nodeId: NODE.id,
      taskId: TASK.taskId,
    });
    assert.equal(searched.status, "completed");
    assert.doesNotMatch(JSON.stringify(searched), /repository\.dependencies\.resolve/);
    await assert.rejects(directory.invoke({
      node: NODE,
      functionId: CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID,
      value: { operation: CODING_DEPENDENCY_RESOLUTION_OPERATION },
      access: access(directory),
    }), /is not declared/);
  } finally {
    dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("authorized dependency worker is discovered by compact search and pinned invoke returns only a bounded receipt", async () => {
  const fixture = await initializeFixture();
  const executions: CommandExecution[] = [];
  const priorSecret = process.env.ROSTER_PARENT_TEST_SECRET;
  process.env.ROSTER_PARENT_TEST_SECRET = "must-not-reach-child";
  await writeFile(join(fixture.root, "package.json"), editedManifest(fixture.baselineManifest));
  const directory = new RosterFunctionDirectory(createCodingWorkerFunctionDescriptors({
    dependencyResolution: "registry",
  }));
  const dispose = await bindCodingWorkerFunctionProviders({
    directory,
    workingDirectory: fixture.root,
    dependencyResolution: "registry",
    repositoryExecutionProfile: fixture.profile,
    dependencyCommandRunner: fakeRunner(fixture.root, executions),
  });
  const activities: RosterFunctionActivity[] = [];
  try {
    const plane = createRosterFunctionExecutionPlane({
      directory,
      access: () => access(directory),
      onActivity: async (activity) => activities.push(activity),
    });
    assert.deepEqual(plane.functionTools(NODE, TASK).map((tool) => tool.id), [
      ROSTER_CATALOG_SEARCH_FUNCTION_ID,
      ROSTER_CATALOG_INVOKE_FUNCTION_ID,
    ]);
    const invoke = plane.functionInvoker(NODE, TASK);
    const control = {
      executionId: "dependency-success",
      runId: "dependency-success",
      nodeId: NODE.id,
      taskId: TASK.taskId,
    };
    const searched = await invoke({
      functionId: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
      value: { query: "dependencies", capabilities: ["workspace"], limit: 4 },
    }, control);
    assert.equal(searched.status, "completed");
    if (searched.status !== "completed") throw new Error("Expected completed search");
    const snapshot = searched.output as {
      readonly catalogVersion: string;
      readonly entries: ReadonlyArray<{
        readonly id: string;
        readonly version: string;
        readonly providers: ReadonlyArray<{ readonly providerId: string; readonly epoch: number }>;
      }>;
    };
    assert.equal(snapshot.entries.length, 1);
    const entry = snapshot.entries[0]!;
    assert.equal(entry.id, CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID);
    const provider = entry.providers[0]!;
    const pinned = {
      operation: "call" as const,
      catalogVersion: snapshot.catalogVersion,
      functionId: entry.id,
      functionVersion: entry.version,
      providerId: provider.providerId,
      providerEpoch: provider.epoch,
    };
    await assert.rejects(invoke({
      functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
      value: {
        ...pinned,
        value: { operation: CODING_DEPENDENCY_RESOLUTION_OPERATION, command: "npm install" },
      },
    }, control), /additional properties|must NOT have additional properties/i);
    const result = await invoke({
      functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
      value: {
        ...pinned,
        value: { operation: CODING_DEPENDENCY_RESOLUTION_OPERATION },
      },
    }, control);
    assert.equal(result.status, "completed");
    if (result.status !== "completed") throw new Error("Expected completed dependency resolution");
    const receipt = result.output as {
      readonly changed: boolean;
      readonly audit: { readonly total: number };
      readonly commands: { readonly lockfile: number; readonly materialize: number; readonly audit: number };
    };
    assert.equal(receipt.changed, true);
    assert.equal(receipt.audit.total, 6);
    assert.deepEqual(receipt.commands, { lockfile: 0, materialize: 0, audit: 1 });
    assert.doesNotMatch(JSON.stringify(receipt), /left-pad|materialized|lock resolved/);
    assert.deepEqual(executions.map((execution) => execution.args), [
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
      ["audit", "--omit=dev", "--json"],
    ]);
    assert.equal(
      await readFile(join(fixture.root, "node_modules", "materialized.txt"), "utf8"),
      "ignored runtime state\n",
    );
    await assert.rejects(invoke({
      functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
      value: {
        ...pinned,
        value: { operation: CODING_DEPENDENCY_RESOLUTION_OPERATION },
      },
    }, control), /already attempted this manifest frontier/);
    assert.deepEqual(activities.map((activity) => activity.operation), [
      "catalog.search",
      "function.call",
    ]);
    const status = await git(fixture.root, ["status", "--short"]);
    assert.match(status, /^ M package-lock\.json\n M package\.json\n$/);
    assert.doesNotMatch(status, /node_modules|roster-dependency-resolution/);
  } finally {
    if (priorSecret === undefined) delete process.env.ROSTER_PARENT_TEST_SECRET;
    else process.env.ROSTER_PARENT_TEST_SECRET = priorSecret;
    dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dependency worker rejects manifest non-registry expansion before running npm", async () => {
  const fixture = await initializeFixture();
  const executions: CommandExecution[] = [];
  await writeFile(join(fixture.root, "package.json"), editedManifest(fixture.baselineManifest, "git+https://example.com/repo.git"));
  const directory = new RosterFunctionDirectory(createCodingWorkerFunctionDescriptors({
    dependencyResolution: "registry",
  }));
  const dispose = await bindCodingWorkerFunctionProviders({
    directory,
    workingDirectory: fixture.root,
    dependencyResolution: "registry",
    repositoryExecutionProfile: fixture.profile,
    dependencyCommandRunner: fakeRunner(fixture.root, executions),
  });
  try {
    await assert.rejects(directory.invoke({
      node: NODE,
      functionId: CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID,
      value: { operation: CODING_DEPENDENCY_RESOLUTION_OPERATION },
      access: access(directory),
    }), /non-registry dependency/);
    assert.equal(executions.length, 0);
  } finally {
    dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dependency worker rejects lock host expansion before npm ci and records no successful call activity", async () => {
  const fixture = await initializeFixture();
  const executions: CommandExecution[] = [];
  await writeFile(join(fixture.root, "package.json"), editedManifest(fixture.baselineManifest));
  const expandedLock = publicLock().replace(
    "https://registry.npmjs.org/",
    "https://packages.example.com/",
  );
  const directory = new RosterFunctionDirectory(createCodingWorkerFunctionDescriptors({
    dependencyResolution: "registry",
  }));
  const dispose = await bindCodingWorkerFunctionProviders({
    directory,
    workingDirectory: fixture.root,
    dependencyResolution: "registry",
    repositoryExecutionProfile: fixture.profile,
    dependencyCommandRunner: fakeRunner(fixture.root, executions, expandedLock),
  });
  const activities: RosterFunctionActivity[] = [];
  try {
    const plane = createRosterFunctionExecutionPlane({
      directory,
      access: () => access(directory),
      onActivity: async (activity) => activities.push(activity),
    });
    const invoke = plane.functionInvoker(NODE, TASK);
    const control = {
      executionId: "dependency-host-reject",
      runId: "dependency-host-reject",
      nodeId: NODE.id,
      taskId: TASK.taskId,
    };
    const searched = await invoke({
      functionId: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
      value: { query: "dependencies", limit: 4 },
    }, control);
    if (searched.status !== "completed") throw new Error("Expected completed search");
    const snapshot = searched.output as {
      readonly catalogVersion: string;
      readonly entries: ReadonlyArray<{
        readonly id: string;
        readonly version: string;
        readonly providers: ReadonlyArray<{ readonly providerId: string; readonly epoch: number }>;
      }>;
    };
    const entry = snapshot.entries[0]!;
    const provider = entry.providers[0]!;
    await assert.rejects(invoke({
      functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
      value: {
        operation: "call",
        catalogVersion: snapshot.catalogVersion,
        functionId: entry.id,
        functionVersion: entry.version,
        providerId: provider.providerId,
        providerEpoch: provider.epoch,
        value: { operation: CODING_DEPENDENCY_RESOLUTION_OPERATION },
      },
    }, control), /expands resolved hosts/);
    assert.equal(executions.length, 1);
    assert.deepEqual(activities.map((activity) => activity.operation), ["catalog.search"]);
  } finally {
    dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dependency worker preserves an unchanged baseline-locked non-registry dependency", async () => {
  const fixture = await initializeFixture();
  const baselineManifest = `${JSON.stringify({
    name: "dependency-worker-fixture",
    version: "1.0.0",
    scripts: { test: "node --test" },
    dependencies: { local: "file:vendor/local" },
  }, null, 2)}\n`;
  const baselineLockObject = {
    name: "dependency-worker-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "dependency-worker-fixture",
        version: "1.0.0",
        dependencies: { local: "file:vendor/local" },
      },
      "node_modules/local": {
        version: "1.0.0",
        resolved: "file:vendor/local",
      },
    },
  };
  const baselineLock = `${JSON.stringify(baselineLockObject, null, 2)}\n`;
  await Promise.all([
    writeFile(join(fixture.root, "package.json"), baselineManifest),
    writeFile(join(fixture.root, "package-lock.json"), baselineLock),
  ]);
  await git(fixture.root, ["add", "package.json", "package-lock.json"]);
  await git(fixture.root, ["commit", "--no-gpg-sign", "-m", "locked local baseline"]);
  const profile = compileRepositoryExecutionProfile({
    source: "detected",
    repositoryFingerprint: "d".repeat(64),
    evidenceFiles: ["package.json", "package-lock.json", "toolchain.json"],
    evidenceHash: repositoryExecutionProfileEvidenceHash([
      { path: "package.json", content: baselineManifest },
      { path: "package-lock.json", content: baselineLock },
      { path: "toolchain.json", content: "{\"validated\":true}\n" },
    ]),
    installCommands: [{
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
    }],
    verifyCommands: [{
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["test"],
    }],
  });
  const currentManifest = JSON.parse(baselineManifest) as Record<string, unknown>;
  currentManifest.dependencies = {
    local: "file:vendor/local",
    "left-pad": "1.3.0",
  };
  await writeFile(
    join(fixture.root, "package.json"),
    `${JSON.stringify(currentManifest, null, 2)}\n`,
  );
  const postLockObject = JSON.parse(publicLock()) as {
    packages: Record<string, Record<string, unknown>>;
  };
  postLockObject.packages[""]!.dependencies = {
    local: "file:vendor/local",
    "left-pad": "1.3.0",
  };
  postLockObject.packages["node_modules/local"] = {
    version: "1.0.0",
    resolved: "file:vendor/local",
  };
  const postLock = `${JSON.stringify(postLockObject, null, 2)}\n`;
  const executions: CommandExecution[] = [];
  const directory = new RosterFunctionDirectory(createCodingWorkerFunctionDescriptors({
    dependencyResolution: "registry",
  }));
  const dispose = await bindCodingWorkerFunctionProviders({
    directory,
    workingDirectory: fixture.root,
    dependencyResolution: "registry",
    repositoryExecutionProfile: profile,
    dependencyCommandRunner: fakeRunner(fixture.root, executions, postLock),
  });
  try {
    const result = await directory.invoke({
      node: NODE,
      functionId: CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID,
      value: { operation: CODING_DEPENDENCY_RESOLUTION_OPERATION },
      access: access(directory),
    });
    assert.equal(result.status, "completed");
    assert.equal(executions.length, 3);
  } finally {
    dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dependency worker rejects stale non-manifest execution-profile evidence", async () => {
  const fixture = await initializeFixture();
  const executions: CommandExecution[] = [];
  await Promise.all([
    writeFile(join(fixture.root, "package.json"), editedManifest(fixture.baselineManifest)),
    writeFile(join(fixture.root, "toolchain.json"), "{\"validated\":false}\n"),
  ]);
  const directory = new RosterFunctionDirectory(createCodingWorkerFunctionDescriptors({
    dependencyResolution: "registry",
  }));
  const dispose = await bindCodingWorkerFunctionProviders({
    directory,
    workingDirectory: fixture.root,
    dependencyResolution: "registry",
    repositoryExecutionProfile: fixture.profile,
    dependencyCommandRunner: fakeRunner(fixture.root, executions),
  });
  try {
    await assert.rejects(directory.invoke({
      node: NODE,
      functionId: CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID,
      value: { operation: CODING_DEPENDENCY_RESOLUTION_OPERATION },
      access: access(directory),
    }), /execution profile is stale/i);
    assert.equal(executions.length, 0);
  } finally {
    dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
