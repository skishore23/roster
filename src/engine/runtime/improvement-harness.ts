import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { canonicalize, hashCanonical } from "../../core/canonical.js";
import type { JsonValue } from "../orchestration/types.js";
import type { ImprovementArtifactType } from "../../modules/self-improvement.js";
import { runCommand } from "./command-node-runtime.js";
import {
  createGitRunWorkspace,
  disposeGitRunWorkspace,
  prepareGitRunWorkspaceDependencies,
} from "./git-run-workspace.js";
import { normalizeImprovementTarget } from "./self-improvement-framework.js";

export type HarnessCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly durationMs?: number;
};

export type HarnessResult = {
  readonly status: "passed" | "failed";
  readonly checks: ReadonlyArray<HarnessCheck>;
  readonly report: string;
  readonly evidenceHash: string;
  readonly wallTimeMs: number;
};

export type ImprovementHarnessCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

const MAX_PATCH_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 3 * 60_000;

const clip = (text: string, limit = 4_000): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;

const commandFromEnvironment = (artifactType: ImprovementArtifactType): ImprovementHarnessCommand => {
  const name = artifactType === "harness_patch"
    ? "IMPROVEMENT_HARNESS_COMMAND_JSON"
    : "IMPROVEMENT_VALIDATE_COMMAND_JSON";
  const raw = process.env[name];
  if (!raw?.trim()) throw new Error(`${name} missing`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON argv array`);
  }
  if (
    !Array.isArray(parsed)
    || parsed.length < 1
    || parsed.length > 128
    || parsed.some((entry) => typeof entry !== "string" || entry.includes("\0"))
  ) throw new Error(`${name} must be a bounded JSON argv array`);
  return { command: parsed[0]!, args: parsed.slice(1) };
};

const mergePatch = (base: JsonValue, patch: JsonValue): JsonValue => {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const output: Record<string, JsonValue> = base && typeof base === "object" && !Array.isArray(base)
    ? { ...(base as Readonly<Record<string, JsonValue>>) }
    : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete output[key];
    else output[key] = mergePatch(output[key] ?? null, value);
  }
  return output;
};

const materializeCandidate = async (input: {
  readonly workspace: string;
  readonly target: string;
  readonly patch: JsonValue;
}): Promise<string> => {
  if (!input.target.includes("/") && !input.target.endsWith(".json")) {
    const candidatePath = resolve(input.workspace, ".roster-improvement-candidate.json");
    await writeFile(candidatePath, `${canonicalize(input.patch)}\n`, "utf8");
    return candidatePath;
  }
  const candidatePath = resolve(input.workspace, input.target);
  const within = relative(input.workspace, candidatePath);
  if (isAbsolute(within) || within.startsWith("..")) {
    throw new Error("Improvement target escapes its isolated workspace");
  }
  let baseline: JsonValue;
  try {
    baseline = JSON.parse(await readFile(candidatePath, "utf8")) as JsonValue;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Improvement target ${input.target} does not exist in the committed baseline`);
    }
    throw new Error(`Improvement target ${input.target} is not valid JSON`);
  }
  await writeFile(candidatePath, `${canonicalize(mergePatch(baseline, input.patch))}\n`, "utf8");
  return candidatePath;
};

export const evaluateImprovementProposal = async (opts: {
  readonly artifactType: ImprovementArtifactType;
  readonly target: string;
  readonly patch: string;
  readonly repositoryRoot: string;
  readonly command?: ImprovementHarnessCommand;
  readonly timeoutMs?: number;
  /** Defaults to true so repository validation never borrows the live checkout's dependency tree. */
  readonly prepareDependencies?: boolean;
  readonly signal?: AbortSignal;
}): Promise<HarnessResult> => {
  const started = Date.now();
  const checks: HarnessCheck[] = [];
  const patchBytes = Buffer.byteLength(opts.patch, "utf8");
  checks.push({
    name: "patch.size",
    ok: patchBytes > 0 && patchBytes <= MAX_PATCH_BYTES,
    detail: `Patch is ${patchBytes} byte(s); limit is ${MAX_PATCH_BYTES}.`,
  });

  let patch: JsonValue | undefined;
  try {
    patch = JSON.parse(opts.patch) as JsonValue;
    checks.push({ name: "patch.json", ok: true, detail: "Patch is valid JSON merge-patch input." });
  } catch {
    checks.push({ name: "patch.json", ok: false, detail: "Patch is not valid JSON." });
  }

  let target: string | undefined;
  try {
    target = normalizeImprovementTarget(opts.target);
    checks.push({ name: "target.safety", ok: true, detail: `Target '${target}' is bounded and relative.` });
  } catch (error) {
    checks.push({
      name: "target.safety",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (!checks.every(({ ok }) => ok) || patch === undefined || target === undefined) {
    return finalize(checks, started);
  }

  const runId = `improvement-${hashCanonical({
    artifactType: opts.artifactType,
    target,
    patch,
    nonce: started,
  }).slice(0, 28)}`;
  const workspace = await createGitRunWorkspace({ repositoryRoot: opts.repositoryRoot, runId });
  try {
    if (opts.prepareDependencies !== false) {
      await prepareGitRunWorkspaceDependencies(workspace, { signal: opts.signal });
      checks.push({
        name: "dependencies.materialized",
        ok: true,
        detail: "Lockfile-backed dependencies were materialized inside the isolated workspace.",
      });
    }
    const candidatePath = await materializeCandidate({
      workspace: workspace.workingDirectory,
      target,
      patch,
    });
    checks.push({
      name: "candidate.materialized",
      ok: true,
      detail: `Candidate was applied to isolated baseline ${workspace.baselineCommit}.`,
    });
    const command = opts.command ?? commandFromEnvironment(opts.artifactType);
    const commandStarted = Date.now();
    const result = await runCommand({
      command: command.command,
      args: command.args,
      stdin: "",
      cwd: workspace.workingDirectory,
      env: {
        IMPROVEMENT_ARTIFACT_TYPE: opts.artifactType,
        IMPROVEMENT_TARGET: target,
        IMPROVEMENT_CANDIDATE_PATH: candidatePath,
        IMPROVEMENT_BASELINE_COMMIT: workspace.baselineCommit,
      },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxCaptureBytes: MAX_OUTPUT_BYTES,
    });
    checks.push({
      name: "harness.command",
      ok: result.exitCode === 0,
      durationMs: Date.now() - commandStarted,
      detail: result.exitCode === 0
        ? `Command '${command.command}' succeeded in the isolated workspace.`
        : `Command '${command.command}' failed (code=${String(result.exitCode)}): ${clip(result.stderr || result.stdout)}`,
    });
  } catch (error) {
    checks.push({
      name: "harness.execution",
      ok: false,
      detail: clip(error instanceof Error ? error.message : String(error)),
    });
  } finally {
    await disposeGitRunWorkspace(workspace, { keepBranch: false });
  }
  return finalize(checks, started);
};

const finalize = (checks: ReadonlyArray<HarnessCheck>, started: number): HarnessResult => {
  const status = checks.every(({ ok }) => ok) ? "passed" : "failed";
  const report = checks
    .map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`)
    .join("\n");
  const wallTimeMs = Date.now() - started;
  return Object.freeze({
    status,
    checks: Object.freeze([...checks]),
    report,
    wallTimeMs,
    evidenceHash: hashCanonical({ status, checks, report }),
  });
};
