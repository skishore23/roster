import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { codingRepositoryValidationRuntime } from "../../src/domains/coding.ts";
import { createCommandNodeRuntimeAdapter } from "../../src/engine/runtime/command-node-runtime.ts";
import { NodeRuntimeRegistry } from "../../src/engine/runtime/node-runtime.ts";
import {
  compileRepositoryExecutionProfile,
  repositoryExecutionProfileEvidenceHash,
  type RepositoryExecutionProfile,
} from "../../src/engine/runtime/repository-toolchain.ts";

const execFileAsync = promisify(execFile);

type ValidationReport = {
  readonly status: string;
  readonly command: string;
  readonly evidence: string;
  readonly frontierHash: string;
};

const initializeRepository = async (repositoryRoot: string, verify: string): Promise<void> => {
  await execFileAsync("git", ["init"], { cwd: repositoryRoot });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repositoryRoot });
  await execFileAsync("git", ["config", "user.name", "Roster Test"], { cwd: repositoryRoot });
  await writeFile(join(repositoryRoot, "package.json"), `${JSON.stringify({
    name: "validation-fixture",
    version: "1.0.0",
    scripts: { verify, test: verify },
  }, null, 2)}\n`);
  await execFileAsync("git", ["add", "package.json"], { cwd: repositoryRoot });
  await execFileAsync("git", ["commit", "--no-gpg-sign", "-m", "base"], { cwd: repositoryRoot });
};

const executeValidation = async (
  repositoryRoot: string,
  executionProfile?: RepositoryExecutionProfile,
): Promise<ValidationReport> => {
  const runtime = codingRepositoryValidationRuntime(repositoryRoot, executionProfile);
  assert.equal(runtime.kind, "shell");
  assert.equal(runtime.command[0], process.execPath);
  assert.ok(runtime.command.includes(repositoryRoot));
  const registry = new NodeRuntimeRegistry([
    createCommandNodeRuntimeAdapter({ maxOutputBytes: 2 * 1_024 * 1_024 }),
  ]);
  const output = await registry.execute<{ readonly repository_validation_report: ValidationReport }>({
    runId: "repository-validation-worker-test",
    node: {
      id: "validation-worker",
      name: "Validation Worker",
      capabilities: ["validate"],
      runtime,
    },
    task: {
      taskId: "validate-repository",
      agentId: "validation-worker",
      capability: "validate",
    },
    execute: async () => {
      throw new Error("shell runtime must not use the Roster-native callback");
    },
  });
  return output.repository_validation_report;
};

test("repository validation worker runs the exact gate on the isolated checkout and reports its staged frontier", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-host-validation-"));
  try {
    await initializeRepository(repositoryRoot, "node -e \"console.log('validation-ok')\"");
    await writeFile(join(repositoryRoot, "README.md"), "# Candidate frontier\n");

    const report = await executeValidation(repositoryRoot);

    assert.equal(report.status, "passed");
    assert.equal(report.command, "npm run verify");
    assert.match(report.evidence, /exitCode=0/);
    assert.match(report.evidence, /frontierStable=true/);
    const staged = await execFileAsync("git", [
      "--no-pager",
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "HEAD",
      "--",
    ], { cwd: repositoryRoot, encoding: "buffer" });
    assert.equal(
      report.frontierHash,
      createHash("sha256").update(staged.stdout).digest("hex"),
    );
    assert.notEqual(
      report.frontierHash,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("repository validation fails closed when the gate mutates the staged frontier", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-host-validation-mutation-"));
  try {
    await initializeRepository(
      repositoryRoot,
      "node -e \"require('node:fs').writeFileSync('generated.txt', 'generated')\"",
    );

    const report = await executeValidation(repositoryRoot);

    assert.equal(report.status, "failed");
    assert.match(report.evidence, /exitCode=0/);
    assert.match(report.evidence, /frontierStable=false/);
    assert.notEqual(
      report.frontierHash,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("repository validation executes an onboarded profile instead of static detection", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-host-onboarded-validation-"));
  try {
    await initializeRepository(repositoryRoot, "node -e \"console.log('profile-ok')\"");
    const packageJson = await readFile(join(repositoryRoot, "package.json"), "utf8");
    const executionProfile = compileRepositoryExecutionProfile({
      source: "onboarded",
      repositoryFingerprint: "c".repeat(64),
      evidenceFiles: ["package.json"],
      evidenceHash: repositoryExecutionProfileEvidenceHash([{ path: "package.json", content: packageJson }]),
      installCommands: [],
      verifyCommands: [{ command: "npm", args: ["test"] }],
    });
    const report = await executeValidation(repositoryRoot, executionProfile);
    assert.equal(report.status, "passed");
    assert.equal(report.command, "roster repository toolchain");
    assert.deepEqual((report as ValidationReport & { readonly checks: ReadonlyArray<string> }).checks, ["npm test"]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("repository validation runs the bounded uv quality gate for Python projects", async (context) => {
  if (process.platform === "win32") {
    context.skip("the fake uv executable fixture is POSIX-only");
    return;
  }
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-host-python-validation-"));
  const bin = join(repositoryRoot, ".test-bin");
  const priorPath = process.env.PATH;
  try {
    await execFileAsync("git", ["init"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.name", "Roster Test"], { cwd: repositoryRoot });
    await writeFile(join(repositoryRoot, "pyproject.toml"), [
      "[project]",
      "name = \"python-validation-fixture\"",
      "version = \"0.1.0\"",
      "[tool.ruff]",
      "[tool.mypy]",
      "[tool.pytest.ini_options]",
      "",
    ].join("\n"));
    await writeFile(join(repositoryRoot, "uv.lock"), "version = 1\nrevision = 1\n");
    await execFileAsync("git", ["add", "pyproject.toml", "uv.lock"], { cwd: repositoryRoot });
    await execFileAsync("git", ["commit", "--no-gpg-sign", "-m", "base"], { cwd: repositoryRoot });
    await mkdir(bin);
    const fakeUv = join(bin, "uv");
    await writeFile(fakeUv, "#!/usr/bin/env node\nprocess.stdout.write(`uv ${process.argv.slice(2).join(' ')} ok\\n`);\n");
    await chmod(fakeUv, 0o755);
    process.env.PATH = `${bin}:${priorPath ?? ""}`;
    await writeFile(join(repositoryRoot, "README.md"), "# Python candidate\n");

    const report = await executeValidation(repositoryRoot);

    assert.equal(report.status, "passed");
    assert.equal(report.command, "roster repository toolchain");
    assert.match(report.evidence, /frontierStable=true/);
    assert.deepEqual((report as ValidationReport & { readonly checks: ReadonlyArray<string> }).checks, [
      "uv run --frozen --all-extras python -m ruff check .",
      "uv run --frozen --all-extras python -m ruff format --check .",
      "uv run --frozen --all-extras python -m mypy",
      "uv run --frozen --all-extras python -m pytest",
    ]);
  } finally {
    process.env.PATH = priorPath;
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
