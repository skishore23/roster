import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { hashCanonical } from "../core/canonical.js";
import type {
  DomainPack,
  JsonValue,
  WorkspaceNode,
  WorkspaceNodeContinuityPolicy,
} from "../engine/orchestration/types.js";
import {
  detectedRepositoryExecutionProfile,
  inspectRepositoryToolchainManifests,
  parseRepositoryExecutionProfile,
  type RepositoryExecutionProfile,
  type RepositoryManifest,
  type RepositoryToolchainId,
} from "../engine/runtime/repository-toolchain.js";
import type { OrchestrationState } from "../modules/orchestration.js";

const execFileAsync = promisify(execFile);

export const CODING_WORKSPACE_CATALOG_STREAM = "agents/coding-agent/workspaces";
export const CODING_WORKSPACE_CATALOG_ENTRY_SCHEMA = "roster.coding-workspace-entry.v1" as const;
export const CODING_WORKSPACE_CATALOG_OUTPUT_PREFIX = "workspace:";
export const CODING_WORKSPACE_SETTINGS_SCHEMA = "roster.coding-workspace-settings.v2" as const;
export const CODING_WORKSPACE_SETTINGS_OUTPUT_PREFIX = "workspace-settings:";
export const CODING_WORKSPACE_PROFILE_SCHEMA = "roster.coding-workspace.v1" as const;
export const CODING_WORKSPACE_PROFILE_OUTPUT = "workspace_profile";
const CODING_WORKSPACE_SCAN_VERSION = 8;
const MAX_REPOSITORY_FILES = 100_000;
const MAX_RETAINED_REPOSITORY_PATHS = 20_000;
const REQUIRED_TEAM_SPECIALISTS = 2;
export const MAX_CODING_WORKSPACE_SPECIALISTS = 10;
export const MAX_CODING_WORKSPACE_NODE_PREFERENCES = MAX_CODING_WORKSPACE_SPECIALISTS;
const MAX_REPOSITORY_SKILLS = 24;
const MAX_REPOSITORY_SKILL_BYTES = 64 * 1024;
const MAX_REPOSITORY_TOOLCHAIN_MANIFESTS = 64;
const MAX_REPOSITORY_TOOLCHAIN_MANIFEST_BYTES = 256 * 1024;
const MAX_REPOSITORY_AREA_SUMMARIES = 32;
const MAX_REPRESENTATIVE_FILES_PER_AREA = 6;
export const CODING_HUMAN_NODE_ID = "human.operator";

export type CodingRepositorySkillProvider = "codex-cli" | "claude-code" | "pi-agent" | "hermes-agent";

export type CodingRepositorySkill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly relativePath: string;
  readonly providers: ReadonlyArray<CodingRepositorySkillProvider>;
};

const repositorySkillPathspecs = [
  ":(glob).agents/skills/**/SKILL.md",
  ":(glob).codex/skills/**/SKILL.md",
  ":(glob).claude/skills/**/SKILL.md",
  ":(glob).pi/skills/**/SKILL.md",
] as const;

const repositorySkillProviders = (path: string): ReadonlyArray<CodingRepositorySkillProvider> =>
  path.startsWith(".codex/skills/")
    ? ["codex-cli"]
    : path.startsWith(".claude/skills/")
      ? ["claude-code"]
      : path.startsWith(".pi/skills/")
        ? ["pi-agent"]
        : ["codex-cli", "claude-code", "pi-agent", "hermes-agent"];

const frontmatterString = (frontmatter: string, key: string): string | undefined => {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return undefined;
  const value = match[1]?.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
  return value || undefined;
};

const parseRepositorySkill = (
  relativePath: string,
  content: string,
): CodingRepositorySkill | undefined => {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return undefined;
  const name = frontmatterString(frontmatter, "name")?.slice(0, 80);
  const description = frontmatterString(frontmatter, "description")?.slice(0, 280);
  if (!name || !description) return undefined;
  return {
    id: `repository-skill-${hashCanonical(relativePath).slice(0, 20)}`,
    name,
    description,
    relativePath,
    providers: repositorySkillProviders(relativePath),
  };
};

/**
 * Discovers bounded, tracked repository skills from the exact Git checkout.
 * Skill contents remain Git-owned; Roster projects only stable descriptors and
 * runtime paths, and rejects symlinks or files that escape the checkout.
 */
export const discoverCodingRepositorySkills = async (
  repositoryRoot: string,
): Promise<ReadonlyArray<CodingRepositorySkill>> => {
  const root = await realpath(resolve(repositoryRoot));
  const result = await execFileAsync("git", ["ls-files", "-z", "--", ...repositorySkillPathspecs], {
    cwd: root,
    timeout: 4_000,
    maxBuffer: 256 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).catch(() => undefined);
  if (!result) return [];
  const paths = [...new Set(result.stdout.split("\0").filter(Boolean))]
    .sort()
    .slice(0, MAX_REPOSITORY_SKILLS);
  const skills = await Promise.all(paths.map(async (path): Promise<CodingRepositorySkill | undefined> => {
    const absolutePath = join(root, path);
    const info = await lstat(absolutePath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_REPOSITORY_SKILL_BYTES) return undefined;
    const canonicalPath = await realpath(absolutePath).catch(() => undefined);
    if (!canonicalPath) return undefined;
    const rootRelativePath = relative(root, canonicalPath);
    if (!rootRelativePath || rootRelativePath.startsWith("..") || isAbsolute(rootRelativePath)) return undefined;
    const content = await readFile(canonicalPath, "utf8").catch(() => undefined);
    return content === undefined ? undefined : parseRepositorySkill(path, content);
  }));
  return skills.filter((skill): skill is CodingRepositorySkill => skill !== undefined);
};

export type CodingRepositoryWorkspace = {
  readonly schema: typeof CODING_WORKSPACE_CATALOG_ENTRY_SCHEMA;
  readonly id: string;
  readonly repositoryRoot: string;
  readonly profileStream: string;
};

export type CodingWorkspaceWorkerRuntime = CodingRepositorySkillProvider;

export const DEFAULT_CODING_WORKSPACE_WORKER_RUNTIME: CodingWorkspaceWorkerRuntime = "pi-agent";

export const CODING_WORKSPACE_CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

export const CODING_WORKSPACE_PI_MODELS = [
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
] as const;

export const CODING_WORKSPACE_CLAUDE_MODELS = [
  "opus",
  "sonnet",
  "haiku",
] as const;

export const CODING_WORKSPACE_HERMES_MODELS = ["default"] as const;

export type CodingWorkspaceCodexModel = typeof CODING_WORKSPACE_CODEX_MODELS[number];
export type CodingWorkspacePiModel = typeof CODING_WORKSPACE_PI_MODELS[number];
export type CodingWorkspaceClaudeModel = typeof CODING_WORKSPACE_CLAUDE_MODELS[number];
export type CodingWorkspaceHermesModel = typeof CODING_WORKSPACE_HERMES_MODELS[number];
export type CodingWorkspaceWorkerModel = CodingWorkspaceCodexModel
  | CodingWorkspacePiModel
  | CodingWorkspaceClaudeModel
  | CodingWorkspaceHermesModel;

export const DEFAULT_CODING_WORKSPACE_CODEX_MODEL: CodingWorkspaceCodexModel = "gpt-5.6-luna";
export const DEFAULT_CODING_WORKSPACE_PI_MODEL: CodingWorkspacePiModel = "openai-codex/gpt-5.6-luna";
export const DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL: CodingWorkspaceClaudeModel = "sonnet";
export const DEFAULT_CODING_WORKSPACE_HERMES_MODEL: CodingWorkspaceHermesModel = "default";

export const CODING_WORKSPACE_DISCOVERY_PI_EXTENSION_PACKAGES = ["@cortexkit/aft-pi"] as const;

/** Read-only Pi/AFT surface used while discovering and enriching saved specialists. */
export const CODING_WORKSPACE_DISCOVERY_PI_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "aft_outline",
  "aft_zoom",
  "aft_search",
  "ast_grep_search",
  "lsp_diagnostics",
] as const;

/**
 * A saved logical node's preferred writable runtime. Review bindings remain a
 * separate read-only policy boundary and are never weakened by this setting.
 */
export type CodingWorkspaceNodePreference = {
  readonly nodeId: string;
  readonly workerRuntime: CodingWorkspaceWorkerRuntime;
  readonly codexModel: CodingWorkspaceCodexModel;
  readonly piModel: CodingWorkspacePiModel;
  readonly claudeModel: CodingWorkspaceClaudeModel;
  readonly hermesModel: CodingWorkspaceHermesModel;
};

export type CodingWorkspaceSettings = {
  readonly schema: typeof CODING_WORKSPACE_SETTINGS_SCHEMA;
  readonly workspaceId: string;
  readonly workerRuntime: CodingWorkspaceWorkerRuntime;
  readonly codexModel: CodingWorkspaceCodexModel;
  readonly piModel: CodingWorkspacePiModel;
  readonly claudeModel: CodingWorkspaceClaudeModel;
  readonly hermesModel: CodingWorkspaceHermesModel;
  readonly nodePreferences: ReadonlyArray<CodingWorkspaceNodePreference>;
  readonly revision: number;
};

export const codingWorkspaceSettingsOutputKey = (workspaceId: string): string =>
  `${CODING_WORKSPACE_SETTINGS_OUTPUT_PREFIX}${workspaceId}`;

export const codingWorkspaceSettings = (
  workspaceId: string,
  workerRuntime: CodingWorkspaceWorkerRuntime,
  revision: number,
  models: {
    readonly codexModel?: CodingWorkspaceCodexModel;
    readonly piModel?: CodingWorkspacePiModel;
    readonly claudeModel?: CodingWorkspaceClaudeModel;
    readonly hermesModel?: CodingWorkspaceHermesModel;
    readonly nodePreferences?: ReadonlyArray<CodingWorkspaceNodePreference>;
  } = {},
): CodingWorkspaceSettings => ({
  schema: CODING_WORKSPACE_SETTINGS_SCHEMA,
  workspaceId,
  workerRuntime,
  codexModel: models.codexModel ?? DEFAULT_CODING_WORKSPACE_CODEX_MODEL,
  piModel: models.piModel ?? DEFAULT_CODING_WORKSPACE_PI_MODEL,
  claudeModel: models.claudeModel ?? DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL,
  hermesModel: models.hermesModel ?? DEFAULT_CODING_WORKSPACE_HERMES_MODEL,
  nodePreferences: [...(models.nodePreferences ?? [])].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  revision,
});

export const codingWorkspaceCodexModel = (value: unknown): CodingWorkspaceCodexModel | undefined =>
  typeof value === "string" && (CODING_WORKSPACE_CODEX_MODELS as ReadonlyArray<string>).includes(value)
    ? value as CodingWorkspaceCodexModel
    : undefined;

export const codingWorkspacePiModel = (value: unknown): CodingWorkspacePiModel | undefined =>
  typeof value === "string" && (CODING_WORKSPACE_PI_MODELS as ReadonlyArray<string>).includes(value)
    ? value as CodingWorkspacePiModel
    : undefined;

export const codingWorkspaceClaudeModel = (value: unknown): CodingWorkspaceClaudeModel | undefined =>
  typeof value === "string" && (CODING_WORKSPACE_CLAUDE_MODELS as ReadonlyArray<string>).includes(value)
    ? value as CodingWorkspaceClaudeModel
    : undefined;

export const codingWorkspaceHermesModel = (value: unknown): CodingWorkspaceHermesModel | undefined =>
  typeof value === "string" && (CODING_WORKSPACE_HERMES_MODELS as ReadonlyArray<string>).includes(value)
    ? value as CodingWorkspaceHermesModel
    : undefined;

export const isCodingWorkspaceWorkerRuntime = (value: unknown): value is CodingWorkspaceWorkerRuntime =>
  value === "codex-cli" || value === "claude-code" || value === "pi-agent" || value === "hermes-agent";

export const codingWorkspaceSelectedModel = (
  settings: Pick<CodingWorkspaceSettings, "workerRuntime" | "codexModel" | "piModel" | "claudeModel" | "hermesModel">,
): CodingWorkspaceWorkerModel => {
  if (settings.workerRuntime === "pi-agent") return settings.piModel;
  if (settings.workerRuntime === "claude-code") return settings.claudeModel;
  if (settings.workerRuntime === "hermes-agent") return settings.hermesModel;
  return settings.codexModel;
};

export const codingWorkspaceNodePreference = (
  settings: CodingWorkspaceSettings,
  nodeId: string,
): CodingWorkspaceNodePreference => settings.nodePreferences.find((preference) => preference.nodeId === nodeId) ?? {
  nodeId,
  workerRuntime: settings.workerRuntime,
  codexModel: settings.codexModel,
  piModel: settings.piModel,
  claudeModel: settings.claudeModel,
  hermesModel: settings.hermesModel,
};

export const codingWorkspaceNodeSelectedModel = (
  settings: CodingWorkspaceSettings,
  nodeId: string,
): CodingWorkspaceWorkerModel =>
  codingWorkspaceSelectedModel(codingWorkspaceNodePreference(settings, nodeId));

export const parseCodingWorkspaceSettings = (
  value: string | undefined,
  expectedWorkspaceId?: string,
): CodingWorkspaceSettings | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<CodingWorkspaceSettings>;
    const codexModel = codingWorkspaceCodexModel(parsed.codexModel);
    const piModel = codingWorkspacePiModel(parsed.piModel);
    // These fields were added additively to the v2 contract. Older receipts
    // remain valid and acquire the bounded runtime defaults when projected.
    const claudeModel = parsed.claudeModel === undefined
      ? DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL
      : codingWorkspaceClaudeModel(parsed.claudeModel);
    const hermesModel = parsed.hermesModel === undefined
      ? DEFAULT_CODING_WORKSPACE_HERMES_MODEL
      : codingWorkspaceHermesModel(parsed.hermesModel);
    const rawNodePreferences = parsed.nodePreferences;
    if (!Array.isArray(rawNodePreferences) || rawNodePreferences.length > MAX_CODING_WORKSPACE_NODE_PREFERENCES) {
      return undefined;
    }
    const nodePreferences = rawNodePreferences.flatMap((value): CodingWorkspaceNodePreference[] => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
      const preference = value as Partial<CodingWorkspaceNodePreference>;
      const preferenceCodexModel = codingWorkspaceCodexModel(preference.codexModel);
      const preferencePiModel = codingWorkspacePiModel(preference.piModel);
      const preferenceClaudeModel = preference.claudeModel === undefined
        ? DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL
        : codingWorkspaceClaudeModel(preference.claudeModel);
      const preferenceHermesModel = preference.hermesModel === undefined
        ? DEFAULT_CODING_WORKSPACE_HERMES_MODEL
        : codingWorkspaceHermesModel(preference.hermesModel);
      return typeof preference.nodeId === "string"
        && /^workspace\.[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(preference.nodeId)
        && isCodingWorkspaceWorkerRuntime(preference.workerRuntime)
        && preferenceCodexModel
        && preferencePiModel
        && preferenceClaudeModel
        && preferenceHermesModel
        ? [{
            nodeId: preference.nodeId,
            workerRuntime: preference.workerRuntime,
            codexModel: preferenceCodexModel,
            piModel: preferencePiModel,
            claudeModel: preferenceClaudeModel,
            hermesModel: preferenceHermesModel,
          }]
        : [];
    });
    if (nodePreferences.length !== rawNodePreferences.length
      || new Set(nodePreferences.map((preference) => preference.nodeId)).size !== nodePreferences.length) {
      return undefined;
    }
    if (
      parsed.schema !== CODING_WORKSPACE_SETTINGS_SCHEMA
      || typeof parsed.workspaceId !== "string"
      || !/^workspace_[a-f0-9]{20}$/.test(parsed.workspaceId)
      || (expectedWorkspaceId !== undefined && parsed.workspaceId !== expectedWorkspaceId)
      || !isCodingWorkspaceWorkerRuntime(parsed.workerRuntime)
      || !codexModel
      || !piModel
      || !claudeModel
      || !hermesModel
      || typeof parsed.revision !== "number"
      || !Number.isSafeInteger(parsed.revision)
      || parsed.revision < 1
    ) return undefined;
    return {
      schema: CODING_WORKSPACE_SETTINGS_SCHEMA,
      workspaceId: parsed.workspaceId,
      workerRuntime: parsed.workerRuntime,
      codexModel,
      piModel,
      claudeModel,
      hermesModel,
      nodePreferences: nodePreferences.sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
      revision: parsed.revision,
    };
  } catch {
    return undefined;
  }
};

export const codingRepositoryWorkspaceId = (repositoryRoot: string): string =>
  `workspace_${hashCanonical(resolve(repositoryRoot)).slice(0, 20)}`;

export const codingRepositoryWorkspaceProfileStream = (workspaceId: string): string =>
  `agents/coding-agent/workspaces/${workspaceId}/profile`;

export const codingRepositoryWorkspaceRevision = (
  workspace: CodingRepositoryWorkspace,
  fingerprint: string,
): CodingRepositoryWorkspace => ({
  ...workspace,
  profileStream: `${codingRepositoryWorkspaceProfileStream(workspace.id)}/revisions/${fingerprint.slice(0, 32)}`,
});

export const codingRepositoryWorkspace = (
  repositoryRoot: string,
): CodingRepositoryWorkspace => {
  const canonicalRoot = resolve(repositoryRoot);
  const id = codingRepositoryWorkspaceId(canonicalRoot);
  return {
    schema: CODING_WORKSPACE_CATALOG_ENTRY_SCHEMA,
    id,
    repositoryRoot: canonicalRoot,
    profileStream: codingRepositoryWorkspaceProfileStream(id),
  };
};

export const parseCodingRepositoryWorkspace = (value: string | undefined): CodingRepositoryWorkspace | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<CodingRepositoryWorkspace>;
    if (
      parsed.schema !== CODING_WORKSPACE_CATALOG_ENTRY_SCHEMA
      || typeof parsed.id !== "string"
      || !/^workspace_[a-f0-9]{20}$/.test(parsed.id)
      || typeof parsed.repositoryRoot !== "string"
      || resolve(parsed.repositoryRoot) !== parsed.repositoryRoot
      || codingRepositoryWorkspaceId(parsed.repositoryRoot) !== parsed.id
      || typeof parsed.profileStream !== "string"
      || !new RegExp(`^${codingRepositoryWorkspaceProfileStream(parsed.id)}(?:/revisions/[a-f0-9]{32})?$`).test(parsed.profileStream)
    ) return undefined;
    return {
      schema: CODING_WORKSPACE_CATALOG_ENTRY_SCHEMA,
      id: parsed.id,
      repositoryRoot: parsed.repositoryRoot,
      profileStream: parsed.profileStream,
    };
  } catch {
    return undefined;
  }
};

export type CodingWorkspaceSpecialty =
  | "implementation"
  | "quality"
  | "ui"
  | "api"
  | "data"
  | "documentation"
  | "security"
  | "runtime"
  | "machine-learning"
  | "experiment";

export type CodingWorkspaceReview = {
  readonly schema: typeof CODING_WORKSPACE_PROFILE_SCHEMA;
  readonly repositoryRoot: string;
  readonly fingerprint: string;
  readonly fileCount: number;
  readonly filesTruncated: boolean;
  /** Complete Git-index path count; retained path samples remain separately bounded. */
  readonly indexedFileCount?: number;
  readonly retainedPathCount?: number;
  readonly pathIndexHash?: string;
  readonly technologies: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<string>;
  readonly reviewedAt: number;
  readonly scanVersion?: number;
  readonly packageManifestCount?: number;
  readonly toolchains?: ReadonlyArray<RepositoryToolchainId>;
  readonly executionProfile?: RepositoryExecutionProfile;
  readonly topLevelAreas?: ReadonlyArray<string>;
  readonly areaSummaries?: ReadonlyArray<CodingWorkspaceAreaSummary>;
  readonly enrichmentVersion?: number;
  readonly enrichmentEpoch?: number;
  readonly enrichmentStatus?: "complete" | "partial" | "conflicted";
  readonly dependencies?: ReadonlyArray<CodingWorkspaceDependency>;
  readonly dependencyProposals?: ReadonlyArray<CodingWorkspaceDependencyProposal>;
  readonly dependencyConflicts?: ReadonlyArray<CodingWorkspaceDependencyConflict>;
  /**
   * Content address over the accepted review plus every prompt-facing node
   * profile. New publications require it; legacy profiles are upgraded in
   * memory after their structural invariants are checked.
   */
  readonly publicationFingerprint?: string;
};

export type CodingWorkspaceAreaSummary = {
  readonly name: string;
  /** Count across the complete streamed Git path index used for this profile. */
  readonly sampledFileCount: number;
  readonly representativeFiles: ReadonlyArray<string>;
};

const MONOREPO_CONTAINER_AREAS = new Set([
  "apps",
  "crates",
  "infra",
  "libs",
  "modules",
  "packages",
  "plugins",
  "services",
  "tools",
]);

/**
 * Returns a bounded logical repository area. Common monorepo containers keep
 * one child segment so independent packages do not collapse into one bucket.
 */
export const codingRepositoryArea = (path: string): string => {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return ".";
  if (segments.length > 1 && MONOREPO_CONTAINER_AREAS.has(segments[0]!)) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments.length > 1 ? segments[0]! : ".";
};

export type CodingRepositoryPathIndex = {
  readonly version: 1;
  readonly totalFileCount: number;
  readonly retainedFiles: ReadonlyArray<string>;
  readonly hash: string;
  readonly topLevelAreas: ReadonlyArray<string>;
  readonly areaSummaries: ReadonlyArray<CodingWorkspaceAreaSummary>;
  readonly specialistFileScores: Readonly<Record<CodingWorkspaceSpecialty, number>>;
  readonly technologySignals: ReadonlyArray<string>;
};

const emptySpecialistFileScores = (): Record<CodingWorkspaceSpecialty, number> => ({
  implementation: 0,
  quality: 0,
  ui: 0,
  api: 0,
  data: 0,
  documentation: 0,
  security: 0,
  runtime: 0,
  "machine-learning": 0,
  experiment: 0,
});

const scoreRepositoryPath = (
  path: string,
  scores: Record<CodingWorkspaceSpecialty, number>,
): void => {
  if (/(^|\/)(views?|browser|components?|pages?|frontend|web)(\/|\.|$)/i.test(path)) scores.ui += 1;
  if (/(^|\/)(api|routes?|controllers?|server|http|rpc|graphql)(\/|\.|$)/i.test(path)) scores.api += 2;
  if (/(^|\/)(data|datasets?|manifests?|migrations?|schema|spacetimedb|prisma|database|storage)(\/|\.|$)/i.test(path)) scores.data += 2;
  if (/(^|\/)(readme[^/]*\.md|docs\/|documentation\/)/i.test(path)) scores.documentation += 1;
  if (/(^|\/)(auth|security|oauth|permissions?|secrets?|policies?)(\/|\.|-)/i.test(path)) scores.security += 2;
  if (/(^|\/)(engine\/runtime|orchestration|\.github\/workflows|docker|infra|deploy|terraform|pulumi|k8s|kubernetes|helm)(\/|\.|$)/i.test(path)
    || /(^|\/)(dockerfile|compose\.ya?ml|[^/]+\.tf)$/i.test(path)) scores.runtime += 2;
  if (/(^|\/)(models?|train(?:ing)?|losses?|codec|fusion|inference|sampl(?:e|ing))(\/|\.|$)/i.test(path)) {
    scores["machine-learning"] += 2;
  }
  if (/(^|\/)(configs?|experiments?|evaluat(?:e|ion)|benchmarks?|runpod|checkpoints?|metrics?)(\/|\.|$)/i.test(path)) {
    scores.experiment += 2;
  }
};

const addRepositoryTechnologySignals = (path: string, signals: Set<string>): void => {
  if (/\.(ts|tsx|mts|cts)$/.test(path)) signals.add("TypeScript");
  if (/\.(js|jsx|mjs|cjs)$/.test(path)) signals.add("JavaScript");
  if (/\.py$/.test(path)) signals.add("Python");
  if (/\.rs$/.test(path)) signals.add("Rust");
  if (/\.go$/.test(path)) signals.add("Go");
  if (/\.lean$/.test(path)) signals.add("Lean");
  if (/\.(java|kt|kts)$/.test(path)) signals.add("JVM");
  if (/\.(rb|gemspec)$/.test(path)) signals.add("Ruby");
  if (/\.php$/.test(path)) signals.add("PHP");
  if (/\.(cs|csproj)$/.test(path)) signals.add(".NET");
  if (/\.swift$/.test(path)) signals.add("Swift");
  if (path.startsWith("spacetimedb/")) signals.add("SpacetimeDB");
  if (/(^|\/)dockerfile$|docker-compose/i.test(path)) signals.add("Docker");
  if (/(^|\/)package\.json$/.test(path)) signals.add("Node.js");
  if (/(^|\/)uv\.lock$/.test(path)) signals.add("uv");
  if (/\.tf$/.test(path)) signals.add("Terraform");
  if (/(^|\/)(k8s|kubernetes|helm)(\/|$)/i.test(path)) signals.add("Kubernetes");
};

/**
 * Builds a complete, content-addressed repository path index while retaining
 * only a bounded sample for prompt-facing discovery. The caller may feed this
 * one path at a time from Git stdout, so memory does not scale with file count.
 */
const createCodingRepositoryPathIndexBuilder = (): {
  readonly add: (path: string) => void;
  readonly build: () => CodingRepositoryPathIndex;
} => {
  const digest = createHash("sha256");
  const retainedFiles: string[] = [];
  const topLevelCounts = new Map<string, number>();
  const areaFiles = new Map<string, { count: number; representativeFiles: string[] }>();
  const specialistFileScores = emptySpecialistFileScores();
  const technologySignals = new Set<string>();
  let totalFileCount = 0;
  const add = (rawPath: string): void => {
    const path = rawPath.trim();
    if (!path) return;
    totalFileCount += 1;
    const encoded = Buffer.from(path);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encoded.byteLength);
    digest.update(length);
    digest.update(encoded);
    if (retainedFiles.length < MAX_RETAINED_REPOSITORY_PATHS) retainedFiles.push(path);
    const topLevel = path.includes("/") ? path.split("/", 1)[0]! : ".";
    topLevelCounts.set(topLevel, (topLevelCounts.get(topLevel) ?? 0) + 1);
    const area = codingRepositoryArea(path);
    const current = areaFiles.get(area) ?? { count: 0, representativeFiles: [] };
    current.count += 1;
    if (current.representativeFiles.length < MAX_REPRESENTATIVE_FILES_PER_AREA) {
      current.representativeFiles.push(path);
    }
    areaFiles.set(area, current);
    scoreRepositoryPath(path, specialistFileScores);
    addRepositoryTechnologySignals(path, technologySignals);
  };
  return {
    add,
    build: () => {
      const topLevelAreas = [...topLevelCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, MAX_REPOSITORY_AREA_SUMMARIES)
        .map(([name]) => name);
      const areaCandidates = [...areaFiles.entries()]
        .map(([name, value]): CodingWorkspaceAreaSummary => ({
          name,
          sampledFileCount: value.count,
          representativeFiles: value.representativeFiles,
        }))
        .sort((left, right) => right.sampledFileCount - left.sampledFileCount || left.name.localeCompare(right.name));
      const areasByTopLevel = new Map<string, CodingWorkspaceAreaSummary[]>();
      for (const area of areaCandidates) {
        const topLevel = area.name.includes("/") ? area.name.split("/", 1)[0]! : area.name;
        const current = areasByTopLevel.get(topLevel) ?? [];
        current.push(area);
        areasByTopLevel.set(topLevel, current);
      }
      const areaSummaries: CodingWorkspaceAreaSummary[] = [];
      for (let depth = 0; areaSummaries.length < MAX_REPOSITORY_AREA_SUMMARIES; depth += 1) {
        let added = false;
        for (const topLevel of topLevelAreas) {
          const area = areasByTopLevel.get(topLevel)?.[depth];
          if (!area) continue;
          areaSummaries.push(area);
          added = true;
          if (areaSummaries.length >= MAX_REPOSITORY_AREA_SUMMARIES) break;
        }
        if (!added) break;
      }
      const representativeFiles = areaSummaries.flatMap((area) => area.representativeFiles);
      return {
        version: 1,
        totalFileCount,
        retainedFiles: [...new Set([...representativeFiles, ...retainedFiles])].slice(0, MAX_RETAINED_REPOSITORY_PATHS),
        hash: digest.digest("hex"),
        topLevelAreas,
        areaSummaries,
        specialistFileScores,
        technologySignals: [...technologySignals].sort(),
      };
    },
  };
};

export const buildCodingRepositoryPathIndex = (
  paths: Iterable<string>,
): CodingRepositoryPathIndex => {
  const builder = createCodingRepositoryPathIndexBuilder();
  for (const path of paths) builder.add(path);
  return builder.build();
};

export type CodingWorkspaceDependency = {
  readonly nodeId: string;
  readonly dependsOnNodeId: string;
  readonly reason: string;
};

export type CodingWorkspaceDependencyProposal = CodingWorkspaceDependency & {
  readonly proposalId: string;
  readonly authorNodeId: string;
  readonly evidenceFingerprint: string;
};

export type CodingWorkspaceDependencyConflict = {
  readonly conflictId: string;
  readonly kind: "dependency-cycle";
  readonly proposalIds: ReadonlyArray<string>;
  readonly nodeIds: ReadonlyArray<string>;
};

export type CodingWorkspaceProfile = CodingWorkspaceReview & {
  readonly nodes: ReadonlyArray<WorkspaceNode>;
};

type RepositorySnapshot = {
  readonly repositoryRoot: string;
  readonly files: ReadonlyArray<string>;
  readonly manifests: ReadonlyArray<RepositoryManifest>;
  readonly totalFileCount?: number;
  readonly filesTruncated?: boolean;
  readonly reviewedAt?: number;
  readonly pathIndex?: CodingRepositoryPathIndex;
};

type SpecialistDefinition = {
  readonly specialty: CodingWorkspaceSpecialty;
  readonly givenName: string;
  readonly displayRole: string;
  readonly reason: string;
  readonly score: (context: RepositoryContext) => number;
};

type RepositoryContext = {
  readonly files: ReadonlyArray<string>;
  readonly fileText: string;
  readonly dependencies: ReadonlySet<string>;
  readonly pathIndex?: CodingRepositoryPathIndex;
};

const indexedFileScore = (
  context: RepositoryContext,
  specialty: CodingWorkspaceSpecialty,
  fallback: () => number,
): number => context.pathIndex?.specialistFileScores[specialty] ?? fallback();

const optionalSpecialists: ReadonlyArray<SpecialistDefinition> = [
  {
    specialty: "ui",
    givenName: "Sora",
    displayRole: "Interface Designer",
    reason: "Owns browser, view, component, accessibility, and interaction review.",
    score: (context) => indexedFileScore(context, "ui", () => context.files.filter((file) => /(^|\/)(views?|browser|components?|pages?|frontend|web)(\/|\.|$)/i.test(file)).length)
      + ["react", "next", "vue", "svelte", "@angular/core"].filter((dependency) => context.dependencies.has(dependency)).length * 8,
  },
  {
    specialty: "api",
    givenName: "Theo",
    displayRole: "API Architect",
    reason: "Owns routes, public contracts, validation, and compatibility review.",
    score: (context) => indexedFileScore(context, "api", () => context.files.filter((file) => /(^|\/)(api|routes?|controllers?|server|http|rpc|graphql)(\/|\.|$)/i.test(file)).length * 2)
      + ["express", "fastify", "hono", "@nestjs/core", "graphql"].filter((dependency) => context.dependencies.has(dependency)).length * 8,
  },
  {
    specialty: "data",
    givenName: "Iris",
    displayRole: "Data Architect",
    reason: "Owns schemas, persistence, migrations, transactions, and replay safety.",
    score: (context) => indexedFileScore(context, "data", () => context.files.filter((file) => /(^|\/)(data|datasets?|manifests?|migrations?|schema|spacetimedb|prisma|database|storage)(\/|\.|$)/i.test(file)).length * 2)
      + ["pg", "postgres", "prisma", "drizzle-orm", "mongoose", "sqlite3", "@rocicorp/zero"].filter((dependency) => context.dependencies.has(dependency)).length * 8
      + ((context.pathIndex?.technologySignals.includes("SpacetimeDB")
        ?? context.files.some((file) => file.startsWith("spacetimedb/"))) ? 12 : 0),
  },
  {
    specialty: "documentation",
    givenName: "Nia",
    displayRole: "Technical Writer",
    reason: "Owns contributor guidance, examples, discoverability, and user-facing accuracy.",
    score: (context) => Math.min(8, indexedFileScore(context, "documentation", () =>
      context.files.filter((file) => /(^|\/)(readme[^/]*\.md|docs\/|documentation\/)/i.test(file)).length)),
  },
  {
    specialty: "security",
    givenName: "Zara",
    displayRole: "Security Reviewer",
    reason: "Owns authentication, authorization, secrets, and trust-boundary review.",
    score: (context) => indexedFileScore(context, "security", () => context.files.filter((file) => /(^|\/)(auth|security|oauth|permissions?|secrets?|policies?)(\/|\.|-)/i.test(file)).length * 2)
      + ["passport", "jsonwebtoken", "next-auth", "@auth/core"].filter((dependency) => context.dependencies.has(dependency)).length * 8,
  },
  {
    specialty: "runtime",
    givenName: "Owen",
    displayRole: "Runtime Engineer",
    reason: "Owns worker execution, orchestration, CI, deployment, and operational bounds.",
    score: (context) => indexedFileScore(context, "runtime", () => context.files.filter((file) => /(^|\/)(engine\/runtime|orchestration|\.github\/workflows|docker|infra|deploy|terraform|pulumi|k8s|kubernetes|helm)(\/|\.|$)/i.test(file)
      || /(^|\/)(dockerfile|compose\.ya?ml|[^/]+\.tf)$/i.test(file)).length * 2),
  },
  {
    specialty: "machine-learning",
    givenName: "Ari",
    displayRole: "ML Systems Reviewer",
    reason: "Owns model architecture, tensor contracts, training objectives, inference, and numerical correctness.",
    score: (context) => indexedFileScore(context, "machine-learning", () => context.files.filter((file) => /(^|\/)(models?|train(?:ing)?|losses?|codec|fusion|inference|sampl(?:e|ing))(\/|\.|$)/i.test(file)).length * 2)
      + ["torch", "tensorflow", "jax", "diffusers", "transformers", "accelerate", "flax", "keras"].filter((dependency) => context.dependencies.has(dependency)).length * 10,
  },
  {
    specialty: "experiment",
    givenName: "Eli",
    displayRole: "Experiment Reviewer",
    reason: "Owns evaluation design, reproducibility, compute budgets, checkpoints, metrics, and external-artifact boundaries.",
    score: (context) => indexedFileScore(context, "experiment", () => context.files.filter((file) => /(^|\/)(configs?|experiments?|evaluat(?:e|ion)|benchmarks?|runpod|checkpoints?|metrics?)(\/|\.|$)/i.test(file)).length * 2),
  },
];

const detectedTechnologies = (context: RepositoryContext): string[] => {
  const technologies = new Set<string>(context.pathIndex?.technologySignals ?? []);
  const { files, dependencies } = context;
  if (files.some((file) => /\.(ts|tsx|mts|cts)$/.test(file))) technologies.add("TypeScript");
  if (files.some((file) => /\.(js|jsx|mjs|cjs)$/.test(file))) technologies.add("JavaScript");
  if (files.some((file) => /\.py$/.test(file))) technologies.add("Python");
  if (files.some((file) => /\.rs$/.test(file))) technologies.add("Rust");
  if (files.some((file) => /\.go$/.test(file))) technologies.add("Go");
  if (files.some((file) => /\.lean$/.test(file))) technologies.add("Lean");
  if (files.some((file) => /\.(java|kt|kts)$/.test(file))) technologies.add("JVM");
  if (files.some((file) => /\.(rb|gemspec)$/.test(file))) technologies.add("Ruby");
  if (files.some((file) => /\.php$/.test(file))) technologies.add("PHP");
  if (files.some((file) => /\.(cs|csproj)$/.test(file))) technologies.add(".NET");
  if (files.some((file) => /\.swift$/.test(file))) technologies.add("Swift");
  if (dependencies.has("react")) technologies.add("React");
  if (dependencies.has("next")) technologies.add("Next.js");
  if (files.some((file) => file.startsWith("spacetimedb/"))) technologies.add("SpacetimeDB");
  if (files.some((file) => /(^|\/)dockerfile$|docker-compose/i.test(file))) technologies.add("Docker");
  if (files.some((file) => /(^|\/)package\.json$/.test(file))) technologies.add("Node.js");
  if (files.some((file) => /(^|\/)uv\.lock$/.test(file))) technologies.add("uv");
  if (dependencies.has("torch")) technologies.add("PyTorch");
  if (dependencies.has("diffusers")) technologies.add("Diffusers");
  if (files.some((file) => /\.tf$/.test(file))) technologies.add("Terraform");
  if (files.some((file) => /(^|\/)(k8s|kubernetes|helm)(\/|$)/i.test(file))) technologies.add("Kubernetes");
  return [...technologies].sort();
};

const codingWorkspaceSpecialistContinuity = (): WorkspaceNodeContinuityPolicy => ({
  mode: "workspace",
  policyId: "coding.workspace-specialist-continuity",
  policyVersion: "1",
  wakeAgentId: "coding-agent",
  memory: "private",
  maxPendingInboxItems: 32,
  maxInboxItemsPerWake: 1,
  maxActiveCommitments: 16,
  maxCausalDepth: 3,
  maxWakesPerWindow: 48,
  wakeWindowMs: 24 * 60 * 60 * 1_000,
  minWakeIntervalMs: 0,
});

const CODING_WORKSPACE_SPECIALTIES: ReadonlySet<string> = new Set<CodingWorkspaceSpecialty>([
  "implementation",
  "quality",
  "ui",
  "api",
  "data",
  "documentation",
  "security",
  "runtime",
  "machine-learning",
  "experiment",
]);

export const codingWorkspaceSpecialistPromptProfile = (
  specialty: CodingWorkspaceSpecialty,
): string => `coding.workspace.${specialty}`;

const withCodingWorkspaceSpecialistContinuity = (node: WorkspaceNode): WorkspaceNode =>
  !node.id.startsWith("workspace.") || node.metadata?.participantKind === "human"
    ? node
    : {
        ...node,
        ...(node.promptProfile ? {} : {
          promptProfile: codingWorkspaceSpecialistPromptProfile(
            (typeof node.metadata?.specialty === "string"
              ? node.metadata.specialty
              : node.id.slice("workspace.".length)) as CodingWorkspaceSpecialty,
          ),
        }),
        ...(node.continuity ? {} : { continuity: codingWorkspaceSpecialistContinuity() }),
      };

const specialistNode = (
  specialty: CodingWorkspaceSpecialty,
  givenName: string,
  displayRole: string,
  reason: string,
): WorkspaceNode => {
  const worker = specialty === "implementation";
  return {
    id: `workspace.${specialty}`,
    name: `${givenName}, ${displayRole}`,
    capabilities: worker
      ? ["implement", "investigate", "respond", "remediate", "onboard"]
      : ["investigate", "review", "respond", "certify"],
    promptProfile: codingWorkspaceSpecialistPromptProfile(specialty),
    runtime: {
      kind: "pi-agent",
      metadata: {
        model: DEFAULT_CODING_WORKSPACE_PI_MODEL,
        tools: [...CODING_WORKSPACE_DISCOVERY_PI_TOOLS],
        projectTrust: "no-approve",
      },
    },
    continuity: codingWorkspaceSpecialistContinuity(),
    metadata: {
      role: worker ? "worker" : "supervisor",
      specialty,
      givenName,
      displayRole,
      group: worker ? "Implementation" : "Repository stewards",
      repositoryReason: reason,
      persistent: true,
      displayNameSource: "profile",
      onboardingRuntime: "pi-agent",
      onboardingEvidence: "aft-ast",
      piExtensionPackages: [...CODING_WORKSPACE_DISCOVERY_PI_EXTENSION_PACKAGES],
    },
  };
};

export const codingHumanWorkspaceNode = (): WorkspaceNode => ({
  id: CODING_HUMAN_NODE_ID,
  name: "You, Workspace Participant",
  capabilities: ["clarify", "decide", "authorize"],
  runtime: { kind: "roster-native", profile: "coding.workspace.human" },
  metadata: {
    role: "human",
    specialty: "product-context",
    givenName: "You",
    displayRole: "Workspace Participant",
    group: "Workspace participants",
    participantKind: "human",
    persistent: true,
    execution: "human-mediated",
    repositoryReason: "Provides intent, missing context, authority, and decisions when the agent team needs human judgment.",
    displayNameSource: "profile",
  },
});

export const reviewCodingWorkspaceSnapshot = (snapshot: RepositorySnapshot): CodingWorkspaceProfile => {
  const pathIndex = snapshot.pathIndex;
  const discoveredFiles = [...new Set((pathIndex?.retainedFiles ?? snapshot.files)
    .map((file) => file.trim()).filter(Boolean))].sort();
  const files = discoveredFiles.slice(0, MAX_REPOSITORY_FILES);
  const manifestInspection = inspectRepositoryToolchainManifests(snapshot.manifests, files);
  const dependencies = new Set(manifestInspection.dependencies);
  const context: RepositoryContext = {
    files,
    fileText: files.join("\n").toLowerCase(),
    dependencies,
    ...(pathIndex ? { pathIndex } : {}),
  };
  const selected = optionalSpecialists
    .map((specialist, index) => ({ specialist, index, score: specialist.score(context) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, MAX_CODING_WORKSPACE_SPECIALISTS - REQUIRED_TEAM_SPECIALISTS));
  const signals = selected.map(({ specialist }) => specialist.specialty);
  const technologies = detectedTechnologies(context);
  const fileCount = pathIndex?.totalFileCount
    ?? Math.max(snapshot.totalFileCount ?? discoveredFiles.length, discoveredFiles.length);
  const topLevelAreaFiles = new Map<string, number>();
  const areaFiles = new Map<string, string[]>();
  for (const file of files) {
    const topLevelName = file.includes("/") ? file.split("/", 1)[0]! : ".";
    topLevelAreaFiles.set(topLevelName, (topLevelAreaFiles.get(topLevelName) ?? 0) + 1);
    const name = codingRepositoryArea(file);
    const current = areaFiles.get(name) ?? [];
    current.push(file);
    areaFiles.set(name, current);
  }
  const sampledTopLevelAreas = [...topLevelAreaFiles.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_REPOSITORY_AREA_SUMMARIES)
    .map(([name]) => name);
  const areaCandidates = [...areaFiles.entries()]
    .map(([name, areaEntries]): CodingWorkspaceAreaSummary => ({
      name,
      sampledFileCount: areaEntries.length,
      representativeFiles: areaEntries.slice(0, MAX_REPRESENTATIVE_FILES_PER_AREA),
    }))
    .sort((left, right) => right.sampledFileCount - left.sampledFileCount || left.name.localeCompare(right.name));
  const areasByTopLevel = new Map<string, CodingWorkspaceAreaSummary[]>();
  for (const area of areaCandidates) {
    const topLevel = area.name.includes("/") ? area.name.split("/", 1)[0]! : area.name;
    const current = areasByTopLevel.get(topLevel) ?? [];
    current.push(area);
    areasByTopLevel.set(topLevel, current);
  }
  const sampledAreaSummaries: CodingWorkspaceAreaSummary[] = [];
  for (let depth = 0; sampledAreaSummaries.length < MAX_REPOSITORY_AREA_SUMMARIES; depth += 1) {
    let added = false;
    for (const topLevel of sampledTopLevelAreas) {
      const area = areasByTopLevel.get(topLevel)?.[depth];
      if (!area) continue;
      sampledAreaSummaries.push(area);
      added = true;
      if (sampledAreaSummaries.length >= MAX_REPOSITORY_AREA_SUMMARIES) break;
    }
    if (!added) break;
  }
  const topLevelAreas = pathIndex?.topLevelAreas ?? sampledTopLevelAreas;
  const areaSummaries = pathIndex?.areaSummaries ?? sampledAreaSummaries;
  const fingerprint = hashCanonical({
    schema: CODING_WORKSPACE_PROFILE_SCHEMA,
    scanVersion: CODING_WORKSPACE_SCAN_VERSION,
    files,
    fileCount,
    pathIndexHash: pathIndex?.hash,
    dependencies: [...dependencies].sort(),
    signals,
    toolchains: manifestInspection.toolchains.map((toolchain) => toolchain.id),
  });
  const executionProfile = detectedRepositoryExecutionProfile(manifestInspection, fingerprint);
  const nodes = [
    specialistNode(
      "implementation",
      "Kai",
      "Implementation Engineer",
      "Owns repository changes, integration, targeted validation, and remediation.",
    ),
    specialistNode(
      "quality",
      "Mira",
      "Quality Reviewer",
      "Owns correctness, regression, edge-case, and test-coverage review.",
    ),
    ...selected.map(({ specialist, score }) => specialistNode(
      specialist.specialty,
      specialist.givenName,
      specialist.displayRole,
      `${specialist.reason} Selected from ${score} repository signal${score === 1 ? "" : "s"}.`,
    )),
  ];
  return {
    schema: CODING_WORKSPACE_PROFILE_SCHEMA,
    repositoryRoot: resolve(snapshot.repositoryRoot),
    fingerprint,
    fileCount,
    filesTruncated: pathIndex ? false : Boolean(snapshot.filesTruncated) || discoveredFiles.length > MAX_REPOSITORY_FILES,
    ...(pathIndex ? {
      indexedFileCount: pathIndex.totalFileCount,
      retainedPathCount: pathIndex.retainedFiles.length,
      pathIndexHash: pathIndex.hash,
    } : {}),
    technologies,
    signals,
    reviewedAt: snapshot.reviewedAt ?? Date.now(),
    scanVersion: CODING_WORKSPACE_SCAN_VERSION,
    packageManifestCount: manifestInspection.manifests.length,
    toolchains: manifestInspection.toolchains.map((toolchain) => toolchain.id),
    ...(executionProfile ? { executionProfile } : {}),
    topLevelAreas,
    areaSummaries,
    nodes,
  };
};

const streamGitIndexPaths = async (
  repositoryRoot: string,
  args: ReadonlyArray<string>,
  onPath: (path: string) => void,
): Promise<void> => new Promise((resolveStream, rejectStream) => {
  const child = spawn("git", [...args], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let errorTail = "";
  let settled = false;
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectStream(error);
    else resolveStream();
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(new Error("Git path index scan exceeded 30 seconds"));
  }, 30_000);
  child.stdout.on("data", (chunk: Buffer) => {
    remainder = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    let separator = remainder.indexOf(0);
    while (separator >= 0) {
      onPath(remainder.subarray(0, separator).toString("utf8"));
      remainder = remainder.subarray(separator + 1);
      separator = remainder.indexOf(0);
    }
    if (remainder.length > 16 * 1024) {
      child.kill("SIGKILL");
      finish(new Error("Git path index emitted an oversized repository path"));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    errorTail = `${errorTail}${chunk}`.slice(-4_096);
  });
  child.once("error", (error) => finish(error));
  child.once("close", (code, signal) => {
    if (settled) return;
    if (code !== 0) {
      finish(new Error(`Git path index failed (${signal ?? code ?? "unknown"}): ${errorTail.trim()}`));
      return;
    }
    if (remainder.length) onPath(remainder.toString("utf8"));
    finish();
  });
});

export const inspectCodingWorkspace = async (
  repositoryRoot: string,
): Promise<CodingWorkspaceProfile> => {
  const root = resolve(repositoryRoot);
  let files: string[] = [];
  let trackedFiles: string[] = [];
  let filesTruncated = false;
  let totalFileCount = 0;
  let pathIndex: CodingRepositoryPathIndex | undefined;
  try {
    const indexBuilder = createCodingRepositoryPathIndexBuilder();
    const trackedEvidence = new Set<string>();
    let retainedManifestCount = 0;
    let retainedTestEvidence = false;
    await Promise.all([
      streamGitIndexPaths(root, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ], indexBuilder.add),
      streamGitIndexPaths(root, ["ls-files", "--cached", "-z"], (path) => {
        if (/(^|\/)(package\.json|pyproject\.toml)$/.test(path)) {
          if (retainedManifestCount < MAX_REPOSITORY_TOOLCHAIN_MANIFESTS) {
            trackedEvidence.add(path);
            retainedManifestCount += 1;
          }
        } else if (path === "package-lock.json" || path === "uv.lock") {
          trackedEvidence.add(path);
        } else if (!retainedTestEvidence && /(^|\/)tests?(\/|$)/.test(path)) {
          trackedEvidence.add(path);
          retainedTestEvidence = true;
        }
      }),
    ]);
    const builtPathIndex = indexBuilder.build();
    pathIndex = {
      ...builtPathIndex,
      retainedFiles: [...new Set([...trackedEvidence, ...builtPathIndex.retainedFiles])]
        .slice(0, MAX_RETAINED_REPOSITORY_PATHS),
    };
    files = [...pathIndex.retainedFiles];
    trackedFiles = [...new Set([...trackedEvidence, ...files])].sort();
    totalFileCount = pathIndex.totalFileCount;
    filesTruncated = false;
  } catch {
    files = [];
    trackedFiles = [];
  }
  // Coding runs always start from committed HEAD. Read executable toolchain
  // evidence from that same frontier so an operator's dirty manifest cannot
  // produce a profile that immediately fails in the isolated checkout.
  const manifestPaths = trackedFiles
    .filter((path) => /(^|\/)(package\.json|pyproject\.toml)$/.test(path))
    .sort()
    .slice(0, MAX_REPOSITORY_TOOLCHAIN_MANIFESTS);
  const manifests = (await Promise.all(manifestPaths.map(async (path): Promise<RepositoryManifest | undefined> => {
    try {
      const result = await execFileAsync("git", ["show", `HEAD:${path}`], {
        cwd: root,
        timeout: 8_000,
        maxBuffer: MAX_REPOSITORY_TOOLCHAIN_MANIFEST_BYTES,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
      return Buffer.byteLength(result.stdout) <= MAX_REPOSITORY_TOOLCHAIN_MANIFEST_BYTES
        ? { path, content: result.stdout }
        : undefined;
    } catch {
      return undefined;
    }
  }))).filter((manifest): manifest is RepositoryManifest => manifest !== undefined);
  const manifestInspection = inspectRepositoryToolchainManifests(manifests, trackedFiles);
  return reviewCodingWorkspaceSnapshot({
    repositoryRoot: root,
    files,
    manifests: manifestInspection.manifests,
    totalFileCount,
    filesTruncated,
    ...(pathIndex ? { pathIndex } : {}),
  });
};

export const codingCoordinatorWorkspaceNode = (): WorkspaceNode => ({
  id: "coordinator",
  name: "Roster",
  capabilities: ["coordinate"],
  runtime: { kind: "roster-native", profile: "coding.workspace.coordinator" },
  metadata: {
    role: "coordinator",
    specialty: "coordination",
    givenName: "Roster",
    displayRole: "System Facilitator",
    participantKind: "system",
    group: "Workspace participants",
    persistent: true,
    displayNameSource: "profile",
  },
});

export const CODING_WORKSPACE_CAPABILITIES = [
  { id: "coordinate", description: "Route change conversations through the repository-reviewed team." },
  { id: "implement", description: "Implement and validate repository changes." },
  { id: "investigate", description: "Inspect repository behavior deeply without editing." },
  { id: "remediate", description: "Reconcile specialist findings on the current Git frontier." },
  { id: "onboard", description: "Propose a bounded repository install and verification profile without editing files." },
  { id: "review", description: "Review one repository responsibility without editing." },
  { id: "respond", description: "Answer a dependency-routed peer question without editing." },
  { id: "certify", description: "Certify the exact remediated Git frontier." },
  { id: "clarify", description: "Provide missing intent or repository context without holding a worker lease." },
  { id: "decide", description: "Resolve a bounded product or implementation choice requested by the team." },
  { id: "authorize", description: "Grant or deny an explicitly requested human authority boundary." },
] as const;

export const codingWorkspacePack = (profile: CodingWorkspaceProfile): DomainPack => ({
  id: "coding-workspace",
  version: "1.0.0",
  policyVersion: "repository-reviewed-team-v1",
  coordinatorId: "coordinator",
  capabilities: CODING_WORKSPACE_CAPABILITIES,
  nodes: [codingCoordinatorWorkspaceNode(), codingHumanWorkspaceNode(), ...profile.nodes],
  limits: {
    maxNodes: MAX_CODING_WORKSPACE_SPECIALISTS + 2,
    maxTasks: 16,
    maxParallel: 4,
    maxDepth: 4,
  },
});

export const codingWorkspaceNodesFromState = (
  state: OrchestrationState,
): ReadonlyArray<WorkspaceNode> => {
  const nodes = Object.values(state.nodes)
    .filter((node) => node.status === "active" && node.id !== state.domain?.coordinatorId)
    .map(({ status: _status, updatedAt: _updatedAt, ...node }) => node);
  return nodes;
};

const codingWorkspaceMetadataStrings = (
  value: JsonValue | undefined,
): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;

const codingWorkspacePromptMetadata = (
  metadata: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> => {
  const promptKeys = [
    "role",
    "specialty",
    "givenName",
    "displayRole",
    "group",
    "repositoryReason",
    "specializationSummary",
    "operatingInstructions",
    "specialistSkills",
    "toolRequirements",
    "focusPaths",
    "dependsOnNodeIds",
    "collaborationDependencies",
    "dependencyConflicts",
    "evidenceFingerprint",
    "evolutionEpoch",
    "enrichmentStatus",
  ] as const;
  return Object.fromEntries(promptKeys.flatMap((key) =>
    metadata?.[key] === undefined ? [] : [[key, metadata[key]]])) as Readonly<Record<string, JsonValue>>;
};

/** Content address for exactly the saved identity and profile fields shown to a runtime. */
export const codingWorkspaceNodePromptFingerprint = (node: WorkspaceNode): string => hashCanonical({
  id: node.id,
  name: node.name,
  capabilities: node.capabilities,
  promptProfile: node.promptProfile,
  continuity: node.continuity,
  metadata: codingWorkspacePromptMetadata(node.metadata),
});

const assertCodingWorkspaceProfileCore = (profile: CodingWorkspaceProfile): void => {
  const fail = (reason: string): never => {
    throw new Error(`Coding workspace profile is not publication-ready: ${reason}`);
  };
  const specialists = profile.nodes.filter((node) =>
    node.id.startsWith("workspace.") && node.metadata?.participantKind !== "human");
  const nonSpecialists = profile.nodes.filter((node) => !specialists.includes(node));
  if (nonSpecialists.some((node) => node.id !== CODING_HUMAN_NODE_ID
    || hashCanonical(node) !== hashCanonical(codingHumanWorkspaceNode()))) {
    fail("profile contains a node outside the saved specialist and human participant boundary");
  }
  if (specialists.length < REQUIRED_TEAM_SPECIALISTS
    || specialists.length > MAX_CODING_WORKSPACE_SPECIALISTS) {
    fail(`expected ${REQUIRED_TEAM_SPECIALISTS}-${MAX_CODING_WORKSPACE_SPECIALISTS} specialists`);
  }
  const allNodeIds = profile.nodes.map((node) => node.id);
  if (new Set(allNodeIds).size !== allNodeIds.length) fail("workspace node ids must be unique");
  const nodeIds = specialists.map((node) => node.id);
  const allowedNodeIds = new Set(nodeIds);
  if (!allowedNodeIds.has("workspace.implementation") || !allowedNodeIds.has("workspace.quality")) {
    fail("implementation and quality specialists are required");
  }
  const expectedContinuity = codingWorkspaceSpecialistContinuity();
  for (const node of specialists) {
    const metadata = node.metadata;
    const specialty = typeof metadata?.specialty === "string" ? metadata.specialty : undefined;
    if (!specialty || !CODING_WORKSPACE_SPECIALTIES.has(specialty)) fail(`${node.id} has an invalid specialty`);
    if (node.id !== `workspace.${specialty}`) fail(`${node.id} does not match its specialty`);
    if (node.parentId !== undefined) fail(`${node.id} must remain a peer without parentId`);
    if (metadata?.participantKind === "human") fail(`${node.id} cannot be a human participant`);
    const worker = specialty === "implementation";
    const role = worker ? "worker" : "supervisor";
    const capabilities = worker
      ? ["implement", "investigate", "respond", "remediate", "onboard"]
      : ["investigate", "review", "respond", "certify"];
    if (metadata?.role !== role) fail(`${node.id} has an invalid role`);
    if (hashCanonical(node.capabilities) !== hashCanonical(capabilities)) {
      fail(`${node.id} has capabilities outside its authored role`);
    }
    if (node.promptProfile !== codingWorkspaceSpecialistPromptProfile(specialty as CodingWorkspaceSpecialty)) {
      fail(`${node.id} has an invalid prompt profile`);
    }
    if (node.runtime.kind !== "pi-agent"
      || node.runtime.metadata?.model !== DEFAULT_CODING_WORKSPACE_PI_MODEL
      || node.runtime.metadata?.projectTrust !== "no-approve"
      || hashCanonical(node.runtime.metadata?.tools) !== hashCanonical(CODING_WORKSPACE_DISCOVERY_PI_TOOLS)) {
      fail(`${node.id} has an invalid read-only onboarding runtime`);
    }
    if (hashCanonical(node.continuity) !== hashCanonical(expectedContinuity)) {
      fail(`${node.id} has an invalid workspace continuity policy`);
    }
    const givenName = typeof metadata?.givenName === "string" ? metadata.givenName.trim() : "";
    const displayRole = typeof metadata?.displayRole === "string" ? metadata.displayRole.trim() : "";
    const reason = typeof metadata?.repositoryReason === "string" ? metadata.repositoryReason.trim() : "";
    if (!givenName || !displayRole || !reason || node.name !== `${givenName}, ${displayRole}`) {
      fail(`${node.id} has an incomplete named profile`);
    }
    if (metadata?.persistent !== true || metadata?.displayNameSource !== "profile") {
      fail(`${node.id} is not marked as a persistent profile`);
    }
    if (metadata?.onboardingRuntime !== "pi-agent"
      || metadata?.onboardingEvidence !== "aft-ast"
      || hashCanonical(metadata?.piExtensionPackages) !== hashCanonical(CODING_WORKSPACE_DISCOVERY_PI_EXTENSION_PACKAGES)) {
      fail(`${node.id} has invalid onboarding provenance`);
    }
    const status = metadata?.enrichmentStatus;
    if (status !== undefined && status !== "complete" && status !== "partial" && status !== "conflicted") {
      fail(`${node.id} has an invalid enrichment status`);
    }
    if (status === "complete" || status === "conflicted") {
      if (typeof metadata?.specializationSummary !== "string" || !metadata.specializationSummary.trim()
        || typeof metadata?.operatingInstructions !== "string" || !metadata.operatingInstructions.trim()
        || !Array.isArray(metadata?.specialistSkills)
        || !Array.isArray(metadata?.toolRequirements)
        || !Array.isArray(metadata?.focusPaths) || metadata.focusPaths.length === 0
        || typeof metadata?.evidenceFingerprint !== "string" || !metadata.evidenceFingerprint
        || typeof metadata?.evolutionEpoch !== "number" || metadata.evolutionEpoch < 1) {
        fail(`${node.id} has an incomplete enriched prompt profile`);
      }
    }
  }

  const dependencies = profile.dependencies ?? [];
  const edgeKeys = new Set<string>();
  const adjacency = new Map(nodeIds.map((nodeId) => [nodeId, new Set<string>()]));
  for (const dependency of dependencies) {
    const key = `${dependency.nodeId}\u0000${dependency.dependsOnNodeId}`;
    if (!allowedNodeIds.has(dependency.nodeId) || !allowedNodeIds.has(dependency.dependsOnNodeId)
      || dependency.nodeId === dependency.dependsOnNodeId || !dependency.reason.trim() || edgeKeys.has(key)) {
      fail("accepted dependencies must be unique, grounded links between saved peers");
    }
    edgeKeys.add(key);
    adjacency.get(dependency.nodeId)?.add(dependency.dependsOnNodeId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) fail("accepted dependency graph contains a cycle");
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependencyId of adjacency.get(nodeId) ?? []) visit(dependencyId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of nodeIds) visit(nodeId);
  for (const node of specialists) {
    const expected = dependencies.filter((dependency) => dependency.nodeId === node.id);
    const expectedIds = expected.map((dependency) => dependency.dependsOnNodeId);
    const actualIds = codingWorkspaceMetadataStrings(node.metadata?.dependsOnNodeIds) ?? [];
    const actualDependencies = Array.isArray(node.metadata?.collaborationDependencies)
      ? node.metadata.collaborationDependencies
      : [];
    if (hashCanonical(actualIds) !== hashCanonical(expectedIds)
      || hashCanonical(actualDependencies) !== hashCanonical(expected)) {
      fail(`${node.id} dependency metadata does not match the accepted graph`);
    }
  }
  if (profile.enrichmentStatus === "complete"
    && specialists.some((node) => node.metadata?.enrichmentStatus !== "complete")) {
    fail("complete profile contains an incomplete specialist");
  }
  if (profile.enrichmentStatus === "conflicted" && !(profile.dependencyConflicts?.length)) {
    fail("conflicted profile contains no preserved conflict");
  }
};

const codingWorkspacePublicationFingerprint = (profile: CodingWorkspaceProfile): string => {
  const { nodes: _nodes, publicationFingerprint: _publicationFingerprint, ...review } = profile;
  return hashCanonical({
    review,
    nodes: profile.nodes.filter((node) =>
      node.id.startsWith("workspace.") && node.metadata?.participantKind !== "human").map((node) => ({
      id: node.id,
      promptFingerprint: node.metadata?.promptFingerprint,
    })),
  });
};

/**
 * Normalize legacy prompt/continuity defaults, validate immutable role and
 * runtime boundaries, then content-address the exact profiles to publish.
 */
export const prepareCodingWorkspaceProfileForPublication = (
  profile: CodingWorkspaceProfile,
): CodingWorkspaceProfile => {
  const normalized = {
    ...profile,
    nodes: profile.nodes.map(withCodingWorkspaceSpecialistContinuity),
  };
  assertCodingWorkspaceProfileCore(normalized);
  const nodes = normalized.nodes.map((node) =>
    node.id.startsWith("workspace.") && node.metadata?.participantKind !== "human"
      ? {
          ...node,
          metadata: {
            ...(node.metadata ?? {}),
            promptFingerprint: codingWorkspaceNodePromptFingerprint(node),
          },
        }
      : node);
  const publishable = { ...normalized, nodes };
  return {
    ...publishable,
    publicationFingerprint: codingWorkspacePublicationFingerprint(publishable),
  };
};

/** Verify a replayed publication without silently blessing modified profile content. */
export const assertCodingWorkspaceProfilePublication = (
  profile: CodingWorkspaceProfile,
): void => {
  assertCodingWorkspaceProfileCore(profile);
  for (const node of profile.nodes.filter((candidate) =>
    candidate.id.startsWith("workspace.") && candidate.metadata?.participantKind !== "human")) {
    if (node.metadata?.promptFingerprint !== codingWorkspaceNodePromptFingerprint({
      ...node,
      metadata: Object.fromEntries(Object.entries(node.metadata ?? {})
        .filter(([key]) => key !== "promptFingerprint")),
    })) {
      throw new Error(`Coding workspace profile is not publication-ready: ${node.id} prompt fingerprint does not match`);
    }
  }
  if (profile.publicationFingerprint !== codingWorkspacePublicationFingerprint(profile)) {
    throw new Error("Coding workspace profile is not publication-ready: publication fingerprint does not match");
  }
};

export const parseCodingWorkspaceProfile = (
  value: string | undefined,
  nodes: ReadonlyArray<WorkspaceNode>,
): CodingWorkspaceProfile | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<CodingWorkspaceReview>;
    if (
      parsed.schema !== CODING_WORKSPACE_PROFILE_SCHEMA
      || typeof parsed.repositoryRoot !== "string"
      || typeof parsed.fingerprint !== "string"
      || typeof parsed.fileCount !== "number"
      || typeof parsed.filesTruncated !== "boolean"
      || !Array.isArray(parsed.technologies)
      || !parsed.technologies.every((item) => typeof item === "string")
      || !Array.isArray(parsed.signals)
      || !parsed.signals.every((item) => typeof item === "string")
      || typeof parsed.reviewedAt !== "number"
    ) return undefined;
    const executionProfile = parseRepositoryExecutionProfile(parsed.executionProfile);
    const profile: CodingWorkspaceProfile = {
      schema: CODING_WORKSPACE_PROFILE_SCHEMA,
      repositoryRoot: parsed.repositoryRoot,
      fingerprint: parsed.fingerprint,
      fileCount: parsed.fileCount,
      filesTruncated: parsed.filesTruncated,
      ...(Number.isSafeInteger(parsed.indexedFileCount) && parsed.indexedFileCount! >= 0
        ? { indexedFileCount: parsed.indexedFileCount }
        : {}),
      ...(Number.isSafeInteger(parsed.retainedPathCount)
        && parsed.retainedPathCount! >= 0
        && parsed.retainedPathCount! <= MAX_RETAINED_REPOSITORY_PATHS
        ? { retainedPathCount: parsed.retainedPathCount }
        : {}),
      ...(typeof parsed.pathIndexHash === "string" && /^[a-f0-9]{64}$/.test(parsed.pathIndexHash)
        ? { pathIndexHash: parsed.pathIndexHash }
        : {}),
      technologies: parsed.technologies,
      signals: parsed.signals,
      reviewedAt: parsed.reviewedAt,
      ...(typeof parsed.scanVersion === "number" ? { scanVersion: parsed.scanVersion } : {}),
      ...(typeof parsed.packageManifestCount === "number" ? { packageManifestCount: parsed.packageManifestCount } : {}),
      ...(Array.isArray(parsed.toolchains)
        && parsed.toolchains.length <= 3
        && new Set(parsed.toolchains).size === parsed.toolchains.length
        && parsed.toolchains.every((item) => item === "node-npm" || item === "python-uv" || item === "onboarded")
        ? { toolchains: parsed.toolchains }
        : {}),
      ...(executionProfile ? { executionProfile } : {}),
      ...(Array.isArray(parsed.topLevelAreas)
        ? {
            topLevelAreas: parsed.topLevelAreas
              .slice(0, MAX_REPOSITORY_AREA_SUMMARIES)
              .filter((item): item is string =>
                typeof item === "string" && item.length > 0 && item.length <= 500),
          }
        : {}),
      ...(Array.isArray(parsed.areaSummaries) ? {
        areaSummaries: parsed.areaSummaries
          .slice(0, MAX_REPOSITORY_AREA_SUMMARIES)
          .filter((area): area is CodingWorkspaceAreaSummary =>
            area !== null
            && typeof area === "object"
            && typeof (area as Partial<CodingWorkspaceAreaSummary>).name === "string"
            && ((area as Partial<CodingWorkspaceAreaSummary>).name?.length ?? 0) > 0
            && ((area as Partial<CodingWorkspaceAreaSummary>).name?.length ?? 0) <= 500
            && Number.isSafeInteger((area as Partial<CodingWorkspaceAreaSummary>).sampledFileCount)
            && ((area as Partial<CodingWorkspaceAreaSummary>).sampledFileCount ?? 0) >= 0
            && ((area as Partial<CodingWorkspaceAreaSummary>).sampledFileCount ?? 0) <= Number.MAX_SAFE_INTEGER
            && Array.isArray((area as Partial<CodingWorkspaceAreaSummary>).representativeFiles)
            && ((area as Partial<CodingWorkspaceAreaSummary>).representativeFiles ?? []).length
              <= MAX_REPRESENTATIVE_FILES_PER_AREA
            && ((area as Partial<CodingWorkspaceAreaSummary>).representativeFiles ?? [])
              .every((file) => typeof file === "string" && file.length > 0 && file.length <= 4_096))
          .map((area) => ({
            name: area.name,
            sampledFileCount: area.sampledFileCount,
            representativeFiles: area.representativeFiles,
          })),
      } : {}),
      ...(typeof parsed.enrichmentVersion === "number" ? { enrichmentVersion: parsed.enrichmentVersion } : {}),
      ...(typeof parsed.enrichmentEpoch === "number" ? { enrichmentEpoch: parsed.enrichmentEpoch } : {}),
      ...(parsed.enrichmentStatus === "complete" || parsed.enrichmentStatus === "partial" || parsed.enrichmentStatus === "conflicted"
        ? { enrichmentStatus: parsed.enrichmentStatus }
        : {}),
      ...(typeof parsed.publicationFingerprint === "string"
        ? { publicationFingerprint: parsed.publicationFingerprint }
        : {}),
      ...(Array.isArray(parsed.dependencies) ? {
        dependencies: parsed.dependencies.filter((dependency): dependency is CodingWorkspaceDependency =>
          dependency !== null
          && typeof dependency === "object"
          && typeof (dependency as Partial<CodingWorkspaceDependency>).nodeId === "string"
          && typeof (dependency as Partial<CodingWorkspaceDependency>).dependsOnNodeId === "string"
          && typeof (dependency as Partial<CodingWorkspaceDependency>).reason === "string"),
      } : {}),
      ...(Array.isArray(parsed.dependencyProposals) ? {
        dependencyProposals: parsed.dependencyProposals.filter((proposal): proposal is CodingWorkspaceDependencyProposal =>
          proposal !== null
          && typeof proposal === "object"
          && typeof (proposal as Partial<CodingWorkspaceDependencyProposal>).proposalId === "string"
          && typeof (proposal as Partial<CodingWorkspaceDependencyProposal>).authorNodeId === "string"
          && typeof (proposal as Partial<CodingWorkspaceDependencyProposal>).nodeId === "string"
          && typeof (proposal as Partial<CodingWorkspaceDependencyProposal>).dependsOnNodeId === "string"
          && typeof (proposal as Partial<CodingWorkspaceDependencyProposal>).reason === "string"
          && typeof (proposal as Partial<CodingWorkspaceDependencyProposal>).evidenceFingerprint === "string"),
      } : {}),
      ...(Array.isArray(parsed.dependencyConflicts) ? {
        dependencyConflicts: parsed.dependencyConflicts.filter((conflict): conflict is CodingWorkspaceDependencyConflict =>
          conflict !== null
          && typeof conflict === "object"
          && typeof (conflict as Partial<CodingWorkspaceDependencyConflict>).conflictId === "string"
          && (conflict as Partial<CodingWorkspaceDependencyConflict>).kind === "dependency-cycle"
          && Array.isArray((conflict as Partial<CodingWorkspaceDependencyConflict>).proposalIds)
          && (conflict as Partial<CodingWorkspaceDependencyConflict>).proposalIds!.every((item) => typeof item === "string")
          && Array.isArray((conflict as Partial<CodingWorkspaceDependencyConflict>).nodeIds)
          && (conflict as Partial<CodingWorkspaceDependencyConflict>).nodeIds!.every((item) => typeof item === "string")),
      } : {}),
      // Profiles created before workspace continuity keep their original node
      // identity and runtime, while the current Coding policy is supplied for
      // future episodes and then registered in the durable continuity plane.
      nodes: nodes.map(withCodingWorkspaceSpecialistContinuity),
    };
    if (profile.publicationFingerprint) {
      assertCodingWorkspaceProfilePublication(profile);
      return profile;
    }
    return prepareCodingWorkspaceProfileForPublication(profile);
  } catch {
    return undefined;
  }
};
