import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";

import {
  CODING_CHANGE_FRONTIER_FUNCTION_ID,
  captureCodingChangeFrontier,
} from "../../src/domains/coding-change-frontier.ts";
import {
  CODING_TASK_CONTEXT_SCHEMA,
  codingCapabilityUsesChangeFrontier,
  codingTaskContextPolicy,
} from "../../src/domains/coding-context.ts";
import {
  bindCodingWorkerFunctionProviders,
  createCodingWorkerFunctionDescriptors,
} from "../../src/domains/coding-workers.ts";
import { RosterFunctionDirectory } from "../../src/engine/functions/function-directory.ts";

const execFileAsync = promisify(execFile);

const git = async (root: string, ...args: ReadonlyArray<string>): Promise<string> => {
  const result = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  return result.stdout.trim();
};

test("Coding projects context by task semantics without reducing any editing phase to only a diff", () => {
  const proposal = codingTaskContextPolicy("propose");
  const implementation = codingTaskContextPolicy("implement");
  const review = codingTaskContextPolicy("review");
  const remediation = codingTaskContextPolicy("remediate");
  const certification = codingTaskContextPolicy("certify");

  assert.equal(proposal.schema, CODING_TASK_CONTEXT_SCHEMA);
  assert.equal(proposal.changeFrontier, "none");
  assert.equal(implementation.changeFrontier, "optional");
  assert.equal(review.changeFrontier, "required");
  assert.equal(remediation.changeFrontier, "required");
  assert.equal(certification.changeFrontier, "required");
  assert.ok(review.primary.includes("change-frontier"));
  assert.ok(review.available.includes("objective"));
  assert.ok(review.available.includes("repository"));
  assert.ok(review.available.includes("implementation-report"));
  assert.ok(remediation.available.includes("review-findings"));
  assert.ok(certification.available.includes("validation-evidence"));
  assert.equal(codingCapabilityUsesChangeFrontier("respond"), false);
  assert.equal(codingCapabilityUsesChangeFrontier("implement"), true);
  assert.equal(codingCapabilityUsesChangeFrontier("review"), true);
});

test("Coding ChangeFrontier is deterministic, bounded, path-selective, and leaves the real Git index untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-coding-frontier-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.email", "roster@example.test");
    await git(root, "config", "user.name", "Roster Test");
    await writeFile(join(root, "README.md"), "baseline\n", "utf8");
    await git(root, "add", "--", ".");
    await git(root, "commit", "-qm", "initial");
    const firstCommit = await git(root, "rev-parse", "HEAD");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.txt"), "original\n", "utf8");
    await git(root, "add", "--", ".");
    await git(root, "commit", "-qm", "baseline");
    const baselineCommit = await git(root, "rev-parse", "HEAD");

    await writeFile(join(root, "README.md"), "baseline\nchanged docs\n", "utf8");
    await writeFile(
      join(root, "src", "a.txt"),
      `original\n${"bounded frontier evidence\n".repeat(64)}`,
      "utf8",
    );

    const first = await captureCodingChangeFrontier({
      workingDirectory: root,
      baselineCommit,
    });
    const replay = await captureCodingChangeFrontier({
      workingDirectory: root,
      baselineCommit,
    });
    assert.equal(first.patchHash, replay.patchHash);
    assert.equal(first.candidateTree, replay.candidateTree);
    assert.deepEqual(first.changedFiles, ["README.md", "src/a.txt"]);
    assert.equal(first.patch, "");
    assert.ok(first.patchBytes > 0);
    assert.equal(await git(root, "diff", "--cached", "--name-only"), "");

    const selected = await captureCodingChangeFrontier({
      workingDirectory: root,
      baselineCommit,
      operation: "patch",
      path: "src/a.txt",
      maxBytes: 128,
    });
    assert.equal(selected.patchHash, first.patchHash);
    assert.equal(selected.selectedPath, "src/a.txt");
    assert.match(selected.patch, /src\/a\.txt/);
    assert.doesNotMatch(selected.patch, /README\.md/);
    assert.equal(selected.patchTruncated, true);
    assert.ok(Buffer.byteLength(selected.patch) <= 128);
    assert.ok(selected.selectedPatchBytes > 128);

    await git(root, "add", "-A", "--", ".");
    const trustedPatch = await execFileAsync("git", [
      "--no-pager",
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      baselineCommit,
      "--",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(
      first.patchHash,
      createHash("sha256").update(trustedPatch.stdout).digest("hex"),
      "live ChangeFrontier identity must equal the trusted final Git frontier command",
    );
    await git(root, "reset", "--quiet", baselineCommit);

    const directory = new RosterFunctionDirectory(createCodingWorkerFunctionDescriptors());
    const dispose = await bindCodingWorkerFunctionProviders({
      directory,
      workingDirectory: root,
      baselineCommit,
    });
    try {
      const invoked = await directory.invoke({
        node: {
          id: "reviewer",
          name: "Reviewer",
          capabilities: ["workspace"],
          runtime: { kind: "roster-native" },
        },
        functionId: CODING_CHANGE_FRONTIER_FUNCTION_ID,
        value: { operation: "summary" },
        access: {
          functionGrants: [CODING_CHANGE_FRONTIER_FUNCTION_ID],
          allowedEffects: ["read"],
        },
      });
      assert.equal(invoked.status, "completed");
      if (invoked.status !== "completed") throw new Error("Expected ChangeFrontier invocation");
      assert.equal(
        (invoked.output as { readonly patchHash: string }).patchHash,
        first.patchHash,
      );
    } finally {
      dispose();
    }

    await writeFile(join(root, "README.md"), "baseline\nchanged again\n", "utf8");
    const changed = await captureCodingChangeFrontier({
      workingDirectory: root,
      baselineCommit,
    });
    assert.notEqual(changed.patchHash, first.patchHash);
    assert.notEqual(changed.candidateTree, first.candidateTree);

    await mkdir(join(root, "bulk"));
    await Promise.all(Array.from({ length: 300 }, (_, index) =>
      writeFile(join(root, "bulk", `${String(index).padStart(3, "0")}.txt`), "x\n", "utf8")));
    const boundedNames = await captureCodingChangeFrontier({
      workingDirectory: root,
      baselineCommit,
    });
    assert.equal(boundedNames.changedFiles.length, 256);
    assert.equal(boundedNames.omittedChangedFiles, 46);

    await assert.rejects(captureCodingChangeFrontier({
      workingDirectory: root,
      baselineCommit: firstCommit,
    }), /baseline .* is stale/u);
    await assert.rejects(captureCodingChangeFrontier({
      workingDirectory: root,
      baselineCommit,
      operation: "patch",
      path: "../outside.txt",
    }), /escapes the authorized repository root/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
