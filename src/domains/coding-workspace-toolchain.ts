import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type { LlmStructured } from "../adapters/openai.js";
import { hashCanonical } from "../core/canonical.js";
import {
  compileRepositoryExecutionProfile,
  repositoryExecutionProfileEvidenceHash,
  type RepositoryExecutionProfile,
  type RepositoryToolchainCommand,
} from "../engine/runtime/repository-toolchain.js";
import type { CodingWorkspaceProfile } from "./coding-workspace.js";

const execFileAsync = promisify(execFile);
const MAX_EVIDENCE_FILES = 12;
const MAX_EVIDENCE_FILE_BYTES = 16 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_EVIDENCE_SOURCE_BYTES = 256 * 1024;
const TOOLCHAIN_EVIDENCE_PATTERN = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lock|pyproject\.toml|uv\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Makefile|Justfile|Taskfile\.ya?ml|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\/wrapper\/gradle-wrapper\.properties|Gemfile|Gemfile\.lock|Package\.swift|Package\.resolved|[^/]+\.(?:sln|csproj)|turbo\.json|nx\.json|README[^/]*\.md|\.github\/workflows\/[^/]+\.ya?ml)$/i;

const commandSchema = z.object({
  command: z.string().min(1).max(80),
  args: z.array(z.string().min(1).max(512)).max(24),
  cwd: z.string().min(1).max(512).nullable(),
});

const proposalSchema = z.object({
  summary: z.string().min(1).max(600),
  evidenceFiles: z.array(z.string().min(1).max(512)).min(1).max(24),
  installCommands: z.array(commandSchema).max(8),
  verifyCommands: z.array(commandSchema).min(1).max(8),
});

export type CodingWorkspaceToolchainEvidence = {
  readonly path: string;
  readonly content: string;
  readonly contentHash: string;
  readonly truncated: boolean;
};

export type CodingWorkspaceToolchainProposal = z.infer<typeof proposalSchema>;

const runtimeCommands = (
  commands: CodingWorkspaceToolchainProposal["installCommands"],
): ReadonlyArray<RepositoryToolchainCommand> => commands.map(({ cwd, ...command }) => ({
  ...command,
  ...(cwd === null ? {} : { cwd }),
}));

export type CodingWorkspaceToolchainOnboardingInput = {
  readonly repositoryRoot: string;
  readonly repositoryFingerprint: string;
  readonly technologies: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<CodingWorkspaceToolchainEvidence>;
  readonly allowedCommands: ReadonlyArray<string>;
};

export type CodingWorkspaceToolchainOnboarder = (
  input: CodingWorkspaceToolchainOnboardingInput,
) => Promise<CodingWorkspaceToolchainProposal>;

const toolchainEvidence = async (repositoryRoot: string): Promise<ReadonlyArray<CodingWorkspaceToolchainEvidence>> => {
  const root = await realpath(resolve(repositoryRoot));
  const listed = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: root,
    timeout: 12_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).catch(() => undefined);
  if (!listed) return [];
  const candidates = listed.stdout.split("\0")
    .filter((path) => TOOLCHAIN_EVIDENCE_PATTERN.test(path))
    .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  const evidence: CodingWorkspaceToolchainEvidence[] = [];
  let retained = 0;
  for (const path of candidates) {
    if (evidence.length >= MAX_EVIDENCE_FILES || retained >= MAX_EVIDENCE_BYTES) break;
    const absolutePath = join(root, path);
    const info = await lstat(absolutePath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_EVIDENCE_SOURCE_BYTES) continue;
    const canonicalPath = await realpath(absolutePath).catch(() => undefined);
    if (!canonicalPath) continue;
    const repositoryPath = relative(root, canonicalPath);
    if (!repositoryPath || repositoryPath.startsWith("..") || isAbsolute(repositoryPath)) continue;
    const raw = await readFile(canonicalPath).catch(() => undefined);
    if (!raw || raw.includes(0)) continue;
    const limit = Math.min(MAX_EVIDENCE_FILE_BYTES, MAX_EVIDENCE_BYTES - retained);
    const content = raw.subarray(0, limit).toString("utf8");
    retained += Buffer.byteLength(content);
    evidence.push({
      path,
      content,
      contentHash: hashCanonical(raw.toString("utf8")),
      truncated: raw.byteLength > limit,
    });
  }
  return evidence;
};

export const modelCodingWorkspaceToolchainOnboarder = (
  llmStructured: LlmStructured,
): CodingWorkspaceToolchainOnboarder => async (input) => {
  const result = await llmStructured({
    system: [
      "Create one bounded repository execution profile from the supplied Git-tracked evidence.",
      "Prefer commands already declared by manifests, build files, or CI workflows; do not invent scripts or dependencies.",
      "Return direct executable argv only. Never use a shell, chaining, redirection, environment mutation, network utilities, or absolute paths.",
      "Use installCommands only for lockfile-backed dependency materialization. Keep verifyCommands to the smallest authoritative lint, typecheck, test, or build gate.",
      "Every evidenceFiles entry must name one supplied file. Set cwd to null for the repository root; otherwise it must be repository-relative and justified by monorepo structure.",
      "Do not edit files, install packages, run commands, create agents, or request human approval.",
    ].join(" "),
    user: JSON.stringify(input),
    schema: proposalSchema,
    schemaName: "coding_workspace_toolchain_onboarding",
  });
  return proposalSchema.parse(result.parsed);
};

export const onboardCodingWorkspaceToolchain = async (input: {
  readonly profile: CodingWorkspaceProfile;
  readonly onboarder?: CodingWorkspaceToolchainOnboarder;
  readonly onState?: (state: "active" | "complete", profile?: RepositoryExecutionProfile) => void | Promise<void>;
}): Promise<CodingWorkspaceProfile> => {
  if (input.profile.executionProfile || !input.onboarder) return input.profile;
  await input.onState?.("active");
  const evidence = await toolchainEvidence(input.profile.repositoryRoot);
  if (!evidence.length) {
    await input.onState?.("complete");
    return input.profile;
  }
  const proposal = await input.onboarder({
    repositoryRoot: input.profile.repositoryRoot,
    repositoryFingerprint: input.profile.fingerprint,
    technologies: input.profile.technologies,
    evidence,
    allowedCommands: [
      "npm", "pnpm", "yarn", "bun", "uv", "python", "python3", "pytest", "ruff", "mypy",
      "cargo", "go", "make", "gradle", "./gradlew", "mvn", "./mvnw", "bundle", "dotnet", "swift",
    ],
  });
  const suppliedEvidence = new Set(evidence.map((entry) => entry.path));
  if (proposal.evidenceFiles.some((path) => !suppliedEvidence.has(path))) {
    throw new Error("Toolchain onboarding cited repository evidence outside its bounded input");
  }
  const executionProfile = compileRepositoryExecutionProfile({
    source: "onboarded",
    repositoryFingerprint: input.profile.fingerprint,
    evidenceFiles: proposal.evidenceFiles,
    evidenceHash: repositoryExecutionProfileEvidenceHash(evidence
      .filter((entry) => proposal.evidenceFiles.includes(entry.path))
      .map((entry) => ({ path: entry.path, contentHash: entry.contentHash }))),
    installCommands: runtimeCommands(proposal.installCommands),
    verifyCommands: runtimeCommands(proposal.verifyCommands),
  });
  await input.onState?.("complete", executionProfile);
  return {
    ...input.profile,
    toolchains: [...new Set([...(input.profile.toolchains ?? []), "onboarded" as const])],
    executionProfile,
  };
};
