import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { evaluateImprovementProposal } from "../../src/engine/runtime/improvement-harness.ts";

const execFileAsync = promisify(execFile);

test("improvement harness applies candidates only in a bounded isolated Git worktree", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roster-improvement-harness-"));
  const target = path.join(directory, "policy.json");
  try {
    await fs.writeFile(target, `${JSON.stringify({ stable: true, maxParallel: 4 })}\n`);
    await execFileAsync("git", ["init", "-b", "main"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "Roster Test"], { cwd: directory });
    await execFileAsync("git", ["config", "user.email", "roster@example.test"], { cwd: directory });
    await execFileAsync("git", ["add", "policy.json"], { cwd: directory });
    await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: directory });

    const result = await evaluateImprovementProposal({
      artifactType: "policy_patch",
      target: "policy.json",
      patch: JSON.stringify({ maxParallel: 2, newRule: "exact-replay" }),
      repositoryRoot: directory,
      prepareDependencies: false,
      command: {
        command: process.execPath,
        args: [
          "-e",
          "const fs=require('node:fs');const v=JSON.parse(fs.readFileSync(process.env.IMPROVEMENT_CANDIDATE_PATH,'utf8'));if(v.maxParallel!==2||v.stable!==true||v.newRule!=='exact-replay')process.exit(3)",
        ],
      },
    });

    assert.equal(result.status, "passed");
    assert.match(result.evidenceHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), {
      stable: true,
      maxParallel: 4,
    });
    assert.equal((await execFileAsync("git", ["status", "--porcelain"], { cwd: directory })).stdout, "");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("improvement harness rejects path traversal before starting a command", async () => {
  const result = await evaluateImprovementProposal({
    artifactType: "prompt_patch",
    target: "../outside.json",
    patch: "{}",
    repositoryRoot: process.cwd(),
    prepareDependencies: false,
    command: { command: process.execPath, args: ["-e", "process.exit(99)"] },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.checks.some((check) => check.name === "target.safety" && !check.ok), true);
});
