#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  NODE_EXECUTION_SCHEMA_VERSION,
  type NodeExecutionEnvelope,
  type NodeExecutionResult,
} from "./node-runtime.js";
import {
  assertRepositoryExecutionProfileEvidence,
  inspectRepositoryToolchains,
  parseRepositoryExecutionProfile,
  renderRepositoryToolchainCommand,
  repositoryExecutionProfileCommands,
  repositoryToolchainCommandCwd,
  repositoryToolchainCommands,
  type RepositoryExecutionProfile,
} from "./repository-toolchain.js";

const MAX_INPUT_BYTES = 1_048_576;
const MAX_CAPTURE_BYTES = 256 * 1_024;

type CapturedProcess = {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
};

const appendTail = (chunks: Buffer[], chunk: Buffer): void => {
  chunks.push(chunk);
  let bytes = chunks.reduce((total, value) => total + value.byteLength, 0);
  while (bytes > MAX_CAPTURE_BYTES && chunks.length > 0) {
    const overflow = bytes - MAX_CAPTURE_BYTES;
    const first = chunks[0]!;
    if (first.byteLength <= overflow) {
      chunks.shift();
      bytes -= first.byteLength;
    } else {
      chunks[0] = first.subarray(overflow);
      bytes -= overflow;
    }
  }
};

const runProcess = (
  command: string,
  args: ReadonlyArray<string>,
  workingDirectory: string,
  forwardOutput = false,
): Promise<CapturedProcess> => new Promise((resolveProcess, rejectProcess) => {
  const child = spawn(command, [...args], {
    cwd: workingDirectory,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    appendTail(stdout, chunk);
    if (forwardOutput) process.stderr.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    appendTail(stderr, chunk);
    if (forwardOutput) process.stderr.write(chunk);
  });
  child.once("error", rejectProcess);
  child.once("close", (exitCode) => resolveProcess({
    exitCode,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    stdoutBytes,
    stderrBytes,
  }));
});

const testEvidence = (output: string): string => {
  const summaries = [...output.matchAll(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/g)]
    .map((match) => `tests=${match[1]} pass=${match[2]} fail=${match[3]}`);
  return summaries.length ? summaries.join("; ") : "no test summary parsed";
};

export const executeRepositoryValidation = async (
  envelope: NodeExecutionEnvelope,
  workingDirectory: string,
  executionProfile?: RepositoryExecutionProfile,
): Promise<NodeExecutionResult> => {
  if (envelope.schemaVersion !== NODE_EXECUTION_SCHEMA_VERSION) {
    return {
      schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
      status: "failed",
      error: "Repository validation received an unsupported execution envelope",
      retryable: false,
    };
  }
  if (envelope.task.capability !== "validate") {
    return {
      schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
      status: "failed",
      error: "Repository validation worker only accepts the validate capability",
      retryable: false,
    };
  }
  const startedAt = Date.now();
  try {
    const stagedBefore = await runProcess("git", ["add", "-A", "--", "."], workingDirectory);
    if (stagedBefore.exitCode !== 0) {
      throw new Error(`Git frontier staging failed with exit code ${String(stagedBefore.exitCode)}`);
    }
    const frontierBefore = await runProcess("git", [
      "--no-pager",
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "HEAD",
      "--",
    ], workingDirectory);
    if (frontierBefore.exitCode !== 0) {
      throw new Error(`Initial Git frontier read failed with exit code ${String(frontierBefore.exitCode)}`);
    }
    if (executionProfile) await assertRepositoryExecutionProfileEvidence(workingDirectory, executionProfile);
    const commands = executionProfile
      ? repositoryExecutionProfileCommands(executionProfile, "verify")
      : repositoryToolchainCommands(await inspectRepositoryToolchains(workingDirectory), "verify");
    if (!commands.length) {
      throw new Error("Repository validation found no supported lockfile-backed verification toolchain");
    }
    const verifications: CapturedProcess[] = [];
    for (const command of commands) {
      verifications.push(await runProcess(
        command.command,
        command.args,
        repositoryToolchainCommandCwd(workingDirectory, command),
        true,
      ));
    }
    const stagedAfter = await runProcess("git", ["add", "-A", "--", "."], workingDirectory);
    if (stagedAfter.exitCode !== 0) {
      throw new Error(`Git frontier restaging failed with exit code ${String(stagedAfter.exitCode)}`);
    }
    const frontier = await runProcess("git", [
      "--no-pager",
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "HEAD",
      "--",
    ], workingDirectory);
    if (frontier.exitCode !== 0) {
      throw new Error(`Git frontier read failed with exit code ${String(frontier.exitCode)}`);
    }
    const combinedTail = verifications.map((verification) =>
      `${verification.stdout.toString("utf8")}\n${verification.stderr.toString("utf8")}`).join("\n");
    const frontierStable = frontierBefore.stdout.equals(frontier.stdout);
    const verificationPassed = verifications.every((verification) => verification.exitCode === 0);
    const passed = verificationPassed && frontierStable;
    const renderedCommands = commands.map(renderRepositoryToolchainCommand);
    const command = renderedCommands.length === 1 && renderedCommands[0] === "npm run verify"
      ? "npm run verify"
      : "roster repository toolchain";
    return {
      schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
      status: "completed",
      output: {
        repository_validation_report: {
          status: passed ? "passed" : "failed",
          command,
          checks: renderedCommands,
          summary: passed
            ? "Repository verification completed successfully."
            : !verificationPassed
              ? "At least one repository verification command failed."
              : "Repository verification changed the staged frontier.",
          evidence: [
            verifications.length === 1
              ? `exitCode=${String(verifications[0]?.exitCode)}`
              : `exitCodes=${verifications.map((verification) => String(verification.exitCode)).join(",")}`,
            `frontierStable=${String(frontierStable)}`,
            `stdoutBytes=${verifications.reduce((total, verification) => total + verification.stdoutBytes, 0)}`,
            `stderrBytes=${verifications.reduce((total, verification) => total + verification.stderrBytes, 0)}`,
            testEvidence(combinedTail),
          ].join("; "),
          frontierHash: createHash("sha256").update(frontier.stdout).digest("hex"),
        },
      },
      usage: { durationMs: Date.now() - startedAt },
    };
  } catch (error) {
    return {
      schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
};

const readEnvelope = async (): Promise<NodeExecutionEnvelope> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_INPUT_BYTES) throw new Error("Repository validation envelope exceeded its input bound");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as NodeExecutionEnvelope;
};

const main = async (): Promise<void> => {
  try {
    const workingDirectory = process.argv[2];
    if (!workingDirectory) throw new Error("Repository validation requires an isolated working directory");
    const executionProfile = process.argv[3]
      ? parseRepositoryExecutionProfile(JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8")))
      : undefined;
    if (process.argv[3] && !executionProfile) throw new Error("Repository validation received an invalid execution profile");
    process.stdout.write(JSON.stringify(await executeRepositoryValidation(
      await readEnvelope(),
      workingDirectory,
      executionProfile,
    )));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      retryable: false,
    } satisfies NodeExecutionResult));
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
