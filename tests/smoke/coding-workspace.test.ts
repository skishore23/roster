import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL,
  DEFAULT_CODING_WORKSPACE_HERMES_MODEL,
  DEFAULT_CODING_WORKSPACE_PI_MODEL,
  buildCodingRepositoryPathIndex,
  CODING_WORKSPACE_DISCOVERY_PI_TOOLS,
  CODING_HUMAN_NODE_ID,
  CODING_WORKSPACE_SETTINGS_SCHEMA,
  codingRepositoryWorkspace,
  codingRepositoryWorkspaceRevision,
  codingRepositoryWorkspaceId,
  codingRepositoryArea,
  codingWorkspaceSettings,
  codingWorkspaceSettingsOutputKey,
  codingWorkspaceNodePreference,
  codingWorkspaceNodeSelectedModel,
  codingWorkspaceSelectedModel,
  parseCodingRepositoryWorkspace,
  parseCodingWorkspaceProfile,
  parseCodingWorkspaceSettings,
  prepareCodingWorkspaceProfileForPublication,
  codingHumanWorkspaceNode,
  codingWorkspacePack,
  discoverCodingRepositorySkills,
  inspectCodingWorkspace,
  reviewCodingWorkspaceSnapshot,
} from "../../src/domains/coding-workspace.ts";
import {
  codingWorkspaceNodeDependencyIds,
  enrichCodingWorkspaceProfile,
  modelCodingWorkspaceAgentReviewer,
  piCodingWorkspaceAgentReviewer,
  type CodingWorkspaceAgentReviewer,
} from "../../src/domains/coding-workspace-enrichment.ts";
import { createCodingWorkerExecution } from "../../src/domains/coding-execution.ts";
import {
  deriveCodingNodeDemands,
  materializeCodingNode,
} from "../../src/domains/coding.ts";
import {
  NODE_EXECUTION_SCHEMA_VERSION,
  NodeRuntimeRegistry,
  type NodeExecutionEnvelope,
} from "../../src/engine/runtime/node-runtime.ts";
import { compileNodeExecutionPrompt } from "../../src/engine/runtime/node-execution-prompt.ts";
import {
  assertRepositoryExecutionProfileEvidence,
  compileRepositoryExecutionProfile,
  parseRepositoryExecutionProfile,
  repositoryExecutionProfileEvidenceHash,
} from "../../src/engine/runtime/repository-toolchain.ts";

const execFileAsync = promisify(execFile);

test("repository skills are bounded, Git-backed, and provider scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-repository-skills-"));
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    const manifests = [
      [".agents/skills/shared/SKILL.md", "shared-review", "Shared repository review guidance."],
      [".codex/skills/codex-only/SKILL.md", "codex-only", "Codex-specific repository guidance."],
      [".claude/skills/claude-only/SKILL.md", "claude-only", "Claude-specific repository guidance."],
      [".pi/skills/pi-only/SKILL.md", "pi-only", "Pi-specific repository guidance."],
    ] as const;
    for (const [path, name, description] of manifests) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
    }
    await mkdir(join(root, ".agents/skills/untracked"), { recursive: true });
    await writeFile(join(root, ".agents/skills/untracked/SKILL.md"), "---\nname: untracked\ndescription: Ignore me.\n---\n");
    await execFileAsync("git", ["add", ...manifests.map(([path]) => path)], { cwd: root });

    const skills = await discoverCodingRepositorySkills(root);

    assert.deepEqual(skills.map((skill) => skill.name), ["shared-review", "claude-only", "codex-only", "pi-only"]);
    assert.deepEqual(skills.find((skill) => skill.name === "shared-review")?.providers, [
      "codex-cli",
      "claude-code",
      "pi-agent",
      "hermes-agent",
    ]);
    assert.deepEqual(skills.find((skill) => skill.name === "codex-only")?.providers, ["codex-cli"]);
    assert.deepEqual(skills.find((skill) => skill.name === "claude-only")?.providers, ["claude-code"]);
    assert.deepEqual(skills.find((skill) => skill.name === "pi-only")?.providers, ["pi-agent"]);
    assert.equal(skills.some((skill) => skill.name === "untracked"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository review creates a small stable specialist team independent of file arrival order", () => {
  const input = {
    repositoryRoot: "/repo",
    files: [
      "src/server.ts",
      "src/views/app.tsx",
      "spacetimedb/src/lib.ts",
      "docs/README.md",
      "package.json",
    ],
    manifests: [{
      path: "package.json",
      content: JSON.stringify({ dependencies: { react: "1.0.0" } }),
    }],
    reviewedAt: 10,
  };
  const forward = reviewCodingWorkspaceSnapshot(input);
  const reverse = reviewCodingWorkspaceSnapshot({ ...input, files: [...input.files].reverse(), reviewedAt: 20 });

  assert.equal(forward.fingerprint, reverse.fingerprint);
  assert.deepEqual(forward.nodes.map((node) => node.id), reverse.nodes.map((node) => node.id));
  assert.deepEqual(forward.nodes.slice(0, 2).map((node) => node.id), [
    "workspace.implementation",
    "workspace.quality",
  ]);
  assert.ok(forward.nodes.some((node) => node.id === "workspace.ui"));
  assert.ok(forward.nodes.some((node) => node.id === "workspace.data"));
  assert.ok(forward.nodes.length >= 2 && forward.nodes.length <= 10);
  assert.equal(forward.nodes[0]?.name, "Kai, Implementation Engineer");
  assert.equal(forward.nodes[0]?.metadata?.givenName, "Kai");
  assert.equal(forward.nodes[0]?.metadata?.displayRole, "Implementation Engineer");
  assert.ok(forward.nodes.every((node) => node.runtime?.kind === "pi-agent"));
  assert.ok(forward.nodes.every((node) => node.runtime?.metadata?.model === DEFAULT_CODING_WORKSPACE_PI_MODEL));
  assert.ok(forward.nodes.every((node) => node.promptProfile === `coding.workspace.${node.metadata?.specialty}`));
  assert.ok(forward.nodes.every((node) => node.continuity?.mode === "workspace"));
  assert.ok(forward.nodes.every((node) => node.continuity?.wakeAgentId === "coding-agent"));
  assert.ok(forward.nodes.every((node) => node.continuity?.memory === "private"));
  assert.ok(forward.nodes.every((node) => node.metadata?.onboardingEvidence === "aft-ast"));
  assert.ok(forward.nodes.every((node) =>
    (node.runtime?.metadata?.tools as ReadonlyArray<string>).includes("ast_grep_search")));
  assert.ok(forward.nodes.every((node) => node.parentId === undefined), "saved specialists form a peer graph, not a coordinator tree");

  const pack = codingWorkspacePack(forward);
  assert.equal(pack.coordinatorId, "coordinator");
  assert.equal(pack.nodes.length, forward.nodes.length + 2);
  const human = pack.nodes.find((node) => node.id === CODING_HUMAN_NODE_ID);
  assert.deepEqual(human, codingHumanWorkspaceNode());
  assert.deepEqual(human?.capabilities, ["clarify", "decide", "authorize"]);
  assert.equal(human?.metadata?.participantKind, "human");
  assert.ok(pack.nodes.every((node) => node.parentId === undefined));
});

test("repository evidence expands the saved team within a bounded adaptive ceiling", () => {
  const minimal = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo/minimal",
    files: ["src/index.ts"],
    manifests: [],
    reviewedAt: 10,
  });
  const broad = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo/broad",
    files: [
      "src/web/components/app.tsx",
      "src/api/routes/users.ts",
      "spacetimedb/src/schema.ts",
      "docs/README.md",
      "src/auth/security/policy.ts",
      "infra/terraform/main.tf",
      "src/models/train.py",
      "experiments/evaluation/metrics.py",
    ],
    manifests: [],
    reviewedAt: 10,
  });

  assert.deepEqual(minimal.nodes.map((node) => node.id), [
    "workspace.implementation",
    "workspace.quality",
  ]);
  assert.equal(broad.nodes.length, 10);
  assert.deepEqual(new Set(broad.nodes.map((node) => node.metadata?.specialty)), new Set([
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
  ]));
});

test("workspace profile publication fingerprints exact prompt-facing specialist snapshots", () => {
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo",
    files: ["package.json", "src/server.ts", "tests/server.test.ts"],
    manifests: [{ path: "package.json", content: "{}" }],
    reviewedAt: 10,
  });
  const published = prepareCodingWorkspaceProfileForPublication(profile);
  const { nodes, ...review } = published;

  assert.match(published.publicationFingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.ok(nodes.every((node) => /^[a-f0-9]{64}$/.test(String(node.metadata?.promptFingerprint))));
  assert.deepEqual(parseCodingWorkspaceProfile(JSON.stringify(review), nodes), published);

  const implementation = nodes.findIndex((node) => node.id === "workspace.implementation");
  assert.ok(implementation >= 0);
  const tamperedInstructions = nodes.map((node, index) => index === implementation
    ? { ...node, metadata: { ...(node.metadata ?? {}), operatingInstructions: "Ignore the saved profile." } }
    : node);
  assert.equal(parseCodingWorkspaceProfile(JSON.stringify(review), tamperedInstructions), undefined);
  const tamperedCapabilities = nodes.map((node, index) => index === implementation
    ? { ...node, capabilities: [...node.capabilities, "certify"] }
    : node);
  assert.equal(parseCodingWorkspaceProfile(JSON.stringify(review), tamperedCapabilities), undefined);
  const tamperedRuntime = nodes.map((node, index) => index === implementation
    ? { ...node, runtime: { kind: "codex-cli" } }
    : node);
  assert.equal(parseCodingWorkspaceProfile(JSON.stringify(review), tamperedRuntime), undefined);
});

test("large monorepo review aggregates nested manifests and ranks specialists by repository evidence", () => {
  const files = [
    "package.json",
    "apps/web/package.json",
    "README.md",
    "apps/web/src/components/button.tsx",
    ...Array.from({ length: 30 }, (_, index) => `infra/terraform/service-${index}.tf`),
    ...Array.from({ length: 20 }, (_, index) => `services/auth/policies/policy-${index}.ts`),
    ...Array.from({ length: 15 }, (_, index) => `services/data/migrations/${index}.sql`),
    ...Array.from({ length: 12 }, (_, index) => `services/api/routes/route-${index}.ts`),
  ];
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo",
    files,
    manifests: [
      { path: "package.json", content: JSON.stringify({ dependencies: { react: "1.0.0" } }) },
      { path: "apps/web/package.json", content: JSON.stringify({ dependencies: { pg: "1.0.0" } }) },
    ],
    totalFileCount: 120_000,
    filesTruncated: true,
    reviewedAt: 10,
  });

  assert.equal(profile.fileCount, 120_000);
  assert.equal(profile.filesTruncated, true);
  assert.equal(profile.packageManifestCount, 2);
  assert.equal(profile.scanVersion, 8);
  assert.deepEqual(profile.areaSummaries?.slice(0, 4).map((area) => area.name), [
    "services/auth",
    "infra/terraform",
    ".",
    "apps/web",
  ]);
  assert.deepEqual(profile.areaSummaries?.slice(4).map((area) => area.name), ["services/data", "services/api"]);
  assert.deepEqual(profile.topLevelAreas?.slice(0, 4), [
    "services",
    "infra",
    ".",
    "apps",
  ]);
  assert.equal(profile.areaSummaries?.find((area) => area.name === "services/auth")?.sampledFileCount, 20);
  assert.ok((profile.areaSummaries?.find((area) => area.name === "services/auth")?.representativeFiles.length ?? 0) <= 6);
  assert.ok(profile.technologies.includes("React"));
  assert.ok(profile.technologies.includes("Terraform"));
  assert.deepEqual(profile.signals, ["runtime", "security", "data", "api", "ui", "documentation"]);
  assert.ok(profile.nodes.some((node) => node.id === "workspace.runtime"));
  assert.ok(profile.nodes.some((node) => node.id === "workspace.security"));
  assert.ok(profile.nodes.some((node) => node.id === "workspace.documentation"));
});

test("complete Git path indexing retains late monorepo signals beyond the former 100k cutoff", () => {
  function* paths(): Iterable<string> {
    yield "package.json";
    yield "package-lock.json";
    for (let index = 0; index < 120_000; index += 1) {
      yield `src/generated/file-${String(index).padStart(6, "0")}.ts`;
    }
    yield "apps/late-ui/browser/components/after-cutoff.tsx";
  }
  const pathIndex = buildCodingRepositoryPathIndex(paths());
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo",
    files: pathIndex.retainedFiles,
    manifests: [{ path: "package.json", content: "{}" }],
    pathIndex,
    reviewedAt: 10,
  });

  assert.equal(pathIndex.totalFileCount, 120_003);
  assert.ok(pathIndex.retainedFiles.length <= 20_000);
  assert.match(pathIndex.hash, /^[a-f0-9]{64}$/);
  assert.equal(profile.fileCount, 120_003);
  assert.equal(profile.indexedFileCount, 120_003);
  assert.equal(profile.filesTruncated, false);
  assert.equal(profile.pathIndexHash, pathIndex.hash);
  assert.equal(profile.scanVersion, 8);
  assert.ok(profile.nodes.some((node) => node.id === "workspace.ui"));
  assert.ok(profile.areaSummaries?.some((area) => area.name === "apps/late-ui"));
});

test("persisted monorepo area context is validated only within its public bounds", () => {
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo",
    files: ["package.json", "apps/web/src/index.ts"],
    manifests: [{ path: "package.json", content: "{}" }],
    reviewedAt: 10,
  });
  const parsed = parseCodingWorkspaceProfile(JSON.stringify({
    ...profile,
    topLevelAreas: Array.from({ length: 1_000 }, (_, index) => `area-${index}`),
    areaSummaries: Array.from({ length: 1_000 }, (_, index) => ({
      name: `packages/package-${index}`,
      sampledFileCount: 1,
      representativeFiles: [`packages/package-${index}/src/index.ts`],
    })),
  }), profile.nodes);

  assert.equal(parsed?.topLevelAreas?.length, 32);
  assert.equal(parsed?.areaSummaries?.length, 32);
  assert.equal(parsed?.areaSummaries?.at(-1)?.name, "packages/package-31");
});

test("persisted pre-continuity Coding specialists upgrade without changing identity or runtime", () => {
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo",
    files: ["package.json", "src/index.ts"],
    manifests: [{ path: "package.json", content: "{}" }],
    reviewedAt: 10,
  });
  const historicalNodes = profile.nodes.map(({ continuity: _continuity, ...node }) => node);
  const parsed = parseCodingWorkspaceProfile(JSON.stringify(profile), historicalNodes);

  assert.deepEqual(parsed?.nodes.map((node) => node.id), historicalNodes.map((node) => node.id));
  assert.deepEqual(parsed?.nodes.map((node) => node.runtime), historicalNodes.map((node) => node.runtime));
  assert.ok(parsed?.nodes.every((node) => node.continuity?.mode === "workspace"));
  assert.ok(parsed?.nodes.every((node) => node.continuity?.wakeAgentId === "coding-agent"));
});

test("Python ML repositories expose uv verification and model, data, and experiment specialists", () => {
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo/duet",
    files: [
      "README.md",
      "pyproject.toml",
      "uv.lock",
      "src/duet/data/manifest.py",
      "src/duet/fusion.py",
      "src/duet/models/sfx_unet.py",
      "src/duet/train.py",
      "src/duet/evaluate.py",
      "configs/quality.yaml",
      "runpod/bootstrap.sh",
      "tests/test_model.py",
    ],
    manifests: [{
      path: "pyproject.toml",
      content: [
        "[project]",
        "name = \"duet-sfx\"",
        "dependencies = [\"torch>=2.8\", \"diffusers>=0.32\"]",
        "[tool.ruff]",
        "[tool.mypy]",
        "[tool.pytest.ini_options]",
      ].join("\n"),
    }],
    reviewedAt: 10,
  });

  assert.deepEqual(profile.toolchains, ["python-uv"]);
  assert.equal(profile.executionProfile?.source, "detected");
  assert.ok(profile.executionProfile?.verifyCommands.length);
  assert.equal(profile.packageManifestCount, 1);
  assert.ok(profile.technologies.includes("Python"));
  assert.ok(profile.technologies.includes("PyTorch"));
  assert.ok(profile.technologies.includes("Diffusers"));
  assert.ok(profile.technologies.includes("uv"));
  assert.ok(profile.nodes.some((node) => node.id === "workspace.machine-learning"));
  assert.ok(profile.nodes.some((node) => node.id === "workspace.experiment"));
  assert.ok(profile.nodes.some((node) => node.id === "workspace.data"));
});

test("lockfile-backed npm repositories derive bounded gates from declared fallback scripts", () => {
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo/web",
    files: ["package.json", "package-lock.json", "src/app.ts", "tests/app.test.ts"],
    manifests: [{
      path: "package.json",
      content: JSON.stringify({
        scripts: {
          dev: "next dev",
          lint: "next lint",
          typecheck: "tsc --noEmit",
          test: "node --test",
          build: "next build",
          deploy: "unsafe-network-command",
        },
      }),
    }],
    reviewedAt: 10,
  });

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  assert.equal(profile.executionProfile?.source, "detected");
  assert.deepEqual(profile.executionProfile?.verifyCommands, [
    { command: npm, args: ["run", "lint"] },
    { command: npm, args: ["run", "typecheck"] },
    { command: npm, args: ["run", "test"] },
    { command: npm, args: ["run", "build"] },
  ]);
});

test("repository execution profiles are bounded, replayable, and stale-evidence safe", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-toolchain-profile-"));
  const packageJson = JSON.stringify({ scripts: { test: "node --test" } });
  try {
    await writeFile(join(repositoryRoot, "package.json"), packageJson);
    const profile = compileRepositoryExecutionProfile({
      source: "onboarded",
      repositoryFingerprint: "a".repeat(64),
      evidenceFiles: ["package.json"],
      evidenceHash: repositoryExecutionProfileEvidenceHash([{ path: "package.json", content: packageJson }]),
      installCommands: [],
      verifyCommands: [{ command: "npm", args: ["test"] }],
    });
    assert.deepEqual(parseRepositoryExecutionProfile(JSON.parse(JSON.stringify(profile))), profile);
    await assertRepositoryExecutionProfileEvidence(repositoryRoot, profile);
    await writeFile(join(repositoryRoot, "package.json"), JSON.stringify({ scripts: { test: "node --test --watch" } }));
    await assert.rejects(
      assertRepositoryExecutionProfileEvidence(repositoryRoot, profile),
      /execution profile is stale/,
    );
    assert.throws(() => compileRepositoryExecutionProfile({
      ...profile,
      verifyCommands: [{ command: "sh", args: ["-c", "npm test"] }],
    }), /not allowlisted/);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("workspace scans derive execution evidence from the committed run baseline", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-committed-toolchain-"));
  const checkoutRoot = await mkdtemp(join(tmpdir(), "roster-committed-toolchain-checkout-"));
  const committedPackageJson = JSON.stringify({
    name: "committed-toolchain",
    scripts: { verify: "node --test" },
  });
  try {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.name", "Roster Test"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.email", "roster@example.invalid"], { cwd: repositoryRoot });
    await writeFile(join(repositoryRoot, "package.json"), committedPackageJson);
    await writeFile(join(repositoryRoot, "package-lock.json"), JSON.stringify({
      name: "committed-toolchain",
      lockfileVersion: 3,
      packages: {},
    }));
    await execFileAsync("git", ["add", "package.json", "package-lock.json"], { cwd: repositoryRoot });
    await execFileAsync("git", ["commit", "-m", "initial toolchain"], { cwd: repositoryRoot });
    await writeFile(join(repositoryRoot, "package.json"), JSON.stringify({
      name: "dirty-toolchain",
      scripts: { verify: "node --test --watch" },
    }));

    const profile = await inspectCodingWorkspace(repositoryRoot);
    assert.equal(profile.executionProfile?.evidenceHash, repositoryExecutionProfileEvidenceHash([
      { path: "package.json", content: committedPackageJson },
    ]));
    await execFileAsync("git", ["worktree", "add", "--detach", checkoutRoot, "HEAD"], { cwd: repositoryRoot });
    await assertRepositoryExecutionProfileEvidence(checkoutRoot, profile.executionProfile!);
    await assert.rejects(
      assertRepositoryExecutionProfileEvidence(repositoryRoot, profile.executionProfile!),
      /execution profile is stale/,
    );
  } finally {
    await execFileAsync("git", ["worktree", "remove", "--force", checkoutRoot], { cwd: repositoryRoot }).catch(() => undefined);
    await rm(checkoutRoot, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("repository workspaces have stable independent profile streams and versioned revisions", () => {
  const first = codingRepositoryWorkspace("/repo/alpha");
  const same = codingRepositoryWorkspace("/repo/alpha/../alpha");
  const second = codingRepositoryWorkspace("/repo/beta");
  const revised = codingRepositoryWorkspaceRevision(first, "a".repeat(64));

  assert.equal(first.id, codingRepositoryWorkspaceId("/repo/alpha"));
  assert.deepEqual(first, same);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.profileStream, second.profileStream);
  assert.deepEqual(parseCodingRepositoryWorkspace(JSON.stringify(first)), first);
  assert.deepEqual(parseCodingRepositoryWorkspace(JSON.stringify(revised)), revised);
});

test("workspace implementation settings are versioned, bounded, and keyed independently from workspace identity", () => {
  const workspace = codingRepositoryWorkspace("/repo/alpha");
  const settings = codingWorkspaceSettings(workspace.id, "pi-agent", 2, {
    codexModel: "gpt-5.6-terra",
    piModel: "openai-codex/gpt-5.6-sol",
    claudeModel: "opus",
    hermesModel: "default",
    nodePreferences: [{
      nodeId: "workspace.api",
      workerRuntime: "claude-code",
      codexModel: "gpt-5.6-luna",
      piModel: "openai-codex/gpt-5.6-terra",
      claudeModel: "haiku",
      hermesModel: "default",
    }],
  });

  assert.equal(settings.schema, CODING_WORKSPACE_SETTINGS_SCHEMA);
  assert.equal(codingWorkspaceSettingsOutputKey(workspace.id), `workspace-settings:${workspace.id}`);
  assert.deepEqual(parseCodingWorkspaceSettings(JSON.stringify(settings), workspace.id), settings);
  assert.equal(codingWorkspaceSelectedModel(settings), "openai-codex/gpt-5.6-sol");
  assert.equal(codingWorkspaceNodeSelectedModel(settings, "workspace.api"), "haiku");
  assert.equal(codingWorkspaceNodePreference(settings, "workspace.quality").workerRuntime, "pi-agent");
  assert.equal(parseCodingWorkspaceSettings(JSON.stringify(settings), codingRepositoryWorkspace("/repo/beta").id), undefined);
  assert.equal(codingWorkspaceSelectedModel({ ...settings, workerRuntime: "claude-code" }), "opus");
  assert.equal(codingWorkspaceSelectedModel({ ...settings, workerRuntime: "hermes-agent" }), "default");
  assert.equal(parseCodingWorkspaceSettings(JSON.stringify({ ...settings, workerRuntime: "unknown-runtime" })), undefined);
  assert.equal(parseCodingWorkspaceSettings(JSON.stringify({ ...settings, codexModel: "unknown" })), undefined);
  assert.equal(parseCodingWorkspaceSettings(JSON.stringify({ ...settings, piModel: "unknown" })), undefined);
  assert.equal(parseCodingWorkspaceSettings(JSON.stringify({ ...settings, claudeModel: "unknown" })), undefined);
  assert.equal(parseCodingWorkspaceSettings(JSON.stringify({ ...settings, hermesModel: "unknown" })), undefined);
  assert.equal(parseCodingWorkspaceSettings(JSON.stringify({ ...settings, revision: 0 })), undefined);
  assert.equal(parseCodingWorkspaceSettings(JSON.stringify({
    ...settings,
    nodePreferences: [...settings.nodePreferences, settings.nodePreferences[0]],
  })), undefined);
  assert.equal(parseCodingWorkspaceSettings(JSON.stringify({
    ...settings,
    nodePreferences: [{ ...settings.nodePreferences[0], nodeId: "runtime.binding" }],
  })), undefined);
  assert.equal(parseCodingWorkspaceSettings(JSON.stringify({
    ...settings,
    schema: "roster.coding-workspace-settings.v1",
  })), undefined);
  const { codexModel: _codexModel, ...withoutCodexModel } = settings;
  const { piModel: _piModel, ...withoutPiModel } = settings;
  const { nodePreferences: _nodePreferences, ...withoutNodePreferences } = settings;
  assert.equal(parseCodingWorkspaceSettings(JSON.stringify(withoutCodexModel)), undefined);
  assert.equal(parseCodingWorkspaceSettings(JSON.stringify(withoutPiModel)), undefined);
  assert.equal(parseCodingWorkspaceSettings(JSON.stringify(withoutNodePreferences)), undefined);
  const legacyProjection = parseCodingWorkspaceSettings(JSON.stringify({
    ...settings,
    claudeModel: undefined,
    hermesModel: undefined,
    nodePreferences: settings.nodePreferences.map(({ claudeModel: _claude, hermesModel: _hermes, ...preference }) => preference),
  }));
  assert.equal(legacyProjection?.claudeModel, DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL);
  assert.equal(legacyProjection?.hermesModel, DEFAULT_CODING_WORKSPACE_HERMES_MODEL);
  assert.equal(legacyProjection?.nodePreferences[0]?.claudeModel, DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL);
  assert.equal(legacyProjection?.nodePreferences[0]?.hermesModel, DEFAULT_CODING_WORKSPACE_HERMES_MODEL);
  assert.equal(parseCodingWorkspaceSettings("not-json"), undefined);
});

test("later coding runs reuse the saved logical node identity with a replaceable runtime", () => {
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: "/repo",
    files: ["package.json", "src/server.ts"],
    manifests: [{ path: "package.json", content: "{}" }],
    reviewedAt: 10,
  });
  const workerDemand = deriveCodingNodeDemands({
    reviewPolicy: "reviewed",
    coordination: { reviewMode: "reviewed", validationScope: "focused" },
    workspaceNodes: profile.nodes,
    selectedNodeIds: ["workspace.implementation", "workspace.quality"],
    primaryNodeId: "workspace.implementation",
  })
    .find((demand) => demand.specialty === "implementation");
  const savedWorker = profile.nodes.find((node) => node.id === "workspace.implementation");
  assert.ok(workerDemand);
  assert.ok(savedWorker);

  const runNode = materializeCodingNode({
    runId: "coding-run",
    reflectionId: "reflection-test",
    index: 0,
    demand: workerDemand,
    profileNode: savedWorker,
    options: {
      workingDirectory: "/repo/.roster/run",
      workerRuntime: "pi-agent",
      piSkills: ["/configured/global-skill"],
      repositorySkills: [{
        id: "repository-skill-shared",
        name: "shared-review",
        description: "Shared repository review guidance.",
        relativePath: ".agents/skills/shared/SKILL.md",
        providers: ["codex-cli", "claude-code", "pi-agent", "hermes-agent"],
      }, {
        id: "repository-skill-codex-only",
        name: "codex-only",
        description: "Codex-only repository guidance.",
        relativePath: ".codex/skills/codex-only/SKILL.md",
        providers: ["codex-cli"],
      }],
    },
  });

  assert.equal(runNode.id, "workspace.implementation");
  assert.equal(runNode.name, "Kai, Implementation Engineer");
  assert.equal(runNode.promptProfile, "coding.workspace.implementation");
  assert.equal(runNode.runtime?.kind, "pi-agent");
  assert.equal(runNode.runtime?.metadata?.workingDirectory, "/repo/.roster/run");

  const reviewerDemand = deriveCodingNodeDemands({
    reviewPolicy: "reviewed",
    coordination: { reviewMode: "reviewed", validationScope: "focused" },
    workspaceNodes: profile.nodes,
    selectedNodeIds: ["workspace.implementation", "workspace.quality"],
    primaryNodeId: "workspace.implementation",
  }).find((demand) => demand.specialty === "quality");
  const savedReviewer = profile.nodes.find((node) => node.id === "workspace.quality");
  assert.ok(reviewerDemand);
  assert.ok(savedReviewer);
  const reviewerNode = materializeCodingNode({
    runId: "coding-run",
    reflectionId: "reflection-test",
    index: 1,
    demand: reviewerDemand,
    profileNode: savedReviewer,
    options: {
      workerRuntime: "codex-cli",
      reviewerRuntime: "codex-cli",
      codexModel: "gpt-5.6-luna",
      workingDirectory: "/repo/.roster/run",
    },
  });
  assert.equal(reviewerNode.runtime.kind, "codex-cli");
  assert.equal(reviewerNode.runtime.metadata?.model, "gpt-5.6-sol");
  assert.deepEqual(runNode.runtime?.metadata?.skills, [
    "/configured/global-skill",
    "/repo/.roster/run/.agents/skills/shared/SKILL.md",
  ]);
  assert.deepEqual(runNode.metadata?.repositorySkills, [{
    id: "repository-skill-shared",
    name: "shared-review",
    description: "Shared repository review guidance.",
    relativePath: ".agents/skills/shared/SKILL.md",
  }]);
  assert.equal(runNode.metadata?.workspaceProfile, true);
});

test("autonomous specialist enrichment learns bounded skills and preserves cyclic proposals outside the executable DAG", async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-workspace-enrichment-"));
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    const files = [
      "package.json",
      "src/api/routes/users.ts",
      "src/components/user-list.tsx",
      "tests/users.test.ts",
    ];
    for (const path of files) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), path === "package.json"
        ? JSON.stringify({ dependencies: { react: "1", hono: "1" } })
        : `// ${path}\nexport const marker = true;\n`);
    }
    await execFileAsync("git", ["add", ...files], { cwd: root });
    const profile = reviewCodingWorkspaceSnapshot({
      repositoryRoot: root,
      files,
      manifests: [{
        path: "package.json",
        content: JSON.stringify({ dependencies: { react: "1", hono: "1" } }),
      }],
      reviewedAt: 10,
    });
    const reviewedNodes: string[] = [];
    const reviewer: CodingWorkspaceAgentReviewer = async ({ node, files: evidence }) => {
      reviewedNodes.push(node.id);
      const dependency = node.id === "workspace.api"
        ? [{ nodeId: "workspace.ui", reason: "The API contract feeds the browser client." }]
        : node.id === "workspace.ui"
          ? [{ nodeId: "workspace.api", reason: "The UI consumes the API contract." }]
          : node.id === "workspace.quality"
            ? [{ nodeId: "workspace.api", reason: "Quality consumes the API specialist report." }]
            : [];
      return {
        summary: `Own ${node.id} using ${evidence.length} bounded files.`,
        operatingInstructions: `Inspect the supplied ${node.id} evidence before reporting.`,
        skills: [{ name: `${node.id} navigation`, description: "Navigate the bounded specialty surface." }],
        toolRequirements: ["lsp", "diagnostics"],
        dependencies: dependency,
      };
    };

    const enriched = await enrichCodingWorkspaceProfile({ profile, reviewer });

    assert.deepEqual(reviewedNodes.sort(), profile.nodes.map((node) => node.id).sort());
    assert.equal(enriched.enrichmentEpoch, 1);
    assert.equal(enriched.enrichmentStatus, "conflicted");
    assert.equal(enriched.dependencies?.some((edge) =>
      edge.nodeId === "workspace.api" && edge.dependsOnNodeId === "workspace.ui"), false);
    assert.equal(enriched.dependencies?.some((edge) =>
      edge.nodeId === "workspace.ui" && edge.dependsOnNodeId === "workspace.api"), false);
    assert.ok(enriched.dependencyProposals?.some((edge) =>
      edge.nodeId === "workspace.api" && edge.dependsOnNodeId === "workspace.ui"));
    assert.ok(enriched.dependencyProposals?.some((edge) =>
      edge.nodeId === "workspace.ui" && edge.dependsOnNodeId === "workspace.api"));
    assert.deepEqual(enriched.dependencyConflicts?.map((conflict) => conflict.nodeIds), [["workspace.api", "workspace.ui"]]);
    const quality = enriched.nodes.find((node) => node.id === "workspace.quality");
    assert.deepEqual(codingWorkspaceNodeDependencyIds(quality!), ["workspace.api"]);
    assert.deepEqual(quality?.metadata?.toolRequirements, ["diagnostics", "lsp"]);
    assert.deepEqual(quality?.metadata?.piExtensionPackages, ["@cortexkit/aft-pi"]);
    assert.equal(Array.isArray(quality?.metadata?.specialistSkills), true);

    let executionEnvelope: NodeExecutionEnvelope | undefined;
    const profileRuntime = new NodeRuntimeRegistry([{
      kind: "pi-agent",
      executeEnvelope: async (envelope) => {
        executionEnvelope = envelope;
        return { schemaVersion: NODE_EXECUTION_SCHEMA_VERSION, status: "completed", output: "reviewed" };
      },
    }]);
    await profileRuntime.execute({
      runId: "profile-prompt-test",
      node: quality!,
      task: { taskId: "quality-review", nodeId: quality!.id, capability: "review" },
      resultContract: { mode: "text", outputKey: "quality_report" },
      execute: async () => "native",
    });
    const compiledPrompt = compileNodeExecutionPrompt(executionEnvelope!);
    assert.match(compiledPrompt, /coding\.workspace\.quality/);
    assert.match(compiledPrompt, /Inspect the supplied workspace\.quality evidence before reporting\./);
    assert.match(compiledPrompt, /workspace\.quality navigation/);
    assert.match(compiledPrompt, /tests\/users\.test\.ts/);

    const evolved = await enrichCodingWorkspaceProfile({ profile, reviewer, previousProfile: enriched });
    const evolvedQuality = evolved.nodes.find((node) => node.id === "workspace.quality");
    assert.equal(evolved.enrichmentEpoch, 2);
    assert.equal(evolvedQuality?.metadata?.evolutionEpoch, 2);
    assert.equal((evolvedQuality?.metadata?.specialistSkills as ReadonlyArray<unknown>).length, 1);

    const partial = await enrichCodingWorkspaceProfile({
      profile,
      previousProfile: enriched,
      reviewer: async (input) => {
        if (input.node.id === "workspace.quality") throw new Error("review unavailable");
        return reviewer(input);
      },
    });
    assert.equal(partial.enrichmentStatus, "conflicted");
    assert.equal(partial.nodes.find((node) => node.id === "workspace.quality")?.metadata?.enrichmentStatus, "partial");
    assert.ok(partial.dependencies?.some((edge) => edge.nodeId === "workspace.quality" && edge.dependsOnNodeId === "workspace.api"));
    assert.equal(partial.nodes.find((node) => node.id === "workspace.implementation")?.metadata?.enrichmentStatus, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("monorepo specialist enrichment samples relevant evidence across top-level areas", async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-monorepo-enrichment-"));
  const files = [
    "package.json",
    ...Array.from({ length: 8 }, (_, index) => `apps/web/src/component-${index}.tsx`),
    ...Array.from({ length: 8 }, (_, index) => `apps/admin/src/component-${index}.tsx`),
    ...Array.from({ length: 8 }, (_, index) => `packages/shared/src/value-${index}.ts`),
    ...Array.from({ length: 8 }, (_, index) => `packages/config/src/value-${index}.ts`),
    ...Array.from({ length: 8 }, (_, index) => `services/api/src/route-${index}.ts`),
    ...Array.from({ length: 8 }, (_, index) => `infra/runtime/service-${index}.ts`),
  ];
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    for (const path of files) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), path === "package.json"
        ? JSON.stringify({ scripts: { test: "node --test" } })
        : `export const marker = ${JSON.stringify(path)};\n`);
    }
    await execFileAsync("git", ["add", ...files], { cwd: root });
    const profile = reviewCodingWorkspaceSnapshot({
      repositoryRoot: root,
      files,
      manifests: [{
        path: "package.json",
        content: JSON.stringify({ scripts: { test: "node --test" } }),
      }],
      reviewedAt: 10,
    });
    let implementationEvidence: ReadonlyArray<string> = [];
    await enrichCodingWorkspaceProfile({
      profile,
      reviewer: async ({ node, files: evidence }) => {
        if (node.id === "workspace.implementation") {
          implementationEvidence = evidence.map((entry) => entry.path);
        }
        return {
          summary: `Reviewed ${node.id}.`,
          operatingInstructions: "Use the bounded repository evidence.",
          skills: [],
          toolRequirements: [],
          dependencies: [],
        };
      },
    });

    assert.ok(implementationEvidence.length <= 10);
    assert.deepEqual(
      [...new Set(implementationEvidence.map(codingRepositoryArea))].sort(),
      [".", "apps/admin", "apps/web", "infra/runtime", "packages/config", "packages/shared", "services/api"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model specialist reviewer receives one bounded role context and cannot invent its output shape", async () => {
  let schemaName = "";
  const reviewer = modelCodingWorkspaceAgentReviewer(async (input) => {
    schemaName = input.schemaName;
    return {
      parsed: {
        summary: "Own API compatibility and validation.",
        operatingInstructions: "Read route contracts before reporting compatibility risks.",
        skills: [{ name: "Contract tracing", description: "Trace public route inputs and outputs." }],
        toolRequirements: ["lsp"],
        dependencies: [{ nodeId: "workspace.data", reason: "Schema changes shape API contracts." }],
      },
      raw: "{}",
    } as never;
  });
  const review = await reviewer({
    repositoryRoot: "/repo",
    repositoryFingerprint: "fingerprint",
    technologies: ["TypeScript"],
    node: { id: "workspace.api", name: "Theo", capabilities: ["review"] },
    roster: [{ id: "workspace.data", name: "Iris", specialty: "data" }],
    files: [{ path: "src/api.ts", content: "export const api = true;", truncated: false }],
  });

  assert.equal(schemaName, "coding_workspace_agent_review");
  assert.equal(review.skills[0]?.name, "Contract tracing");
  assert.deepEqual(review.dependencies.map((dependency) => dependency.nodeId), ["workspace.data"]);
});

test("Pi specialist discovery loads AFT with a read-only AST tool surface", async () => {
  let captured: NodeExecutionEnvelope | undefined;
  const runtimes = new NodeRuntimeRegistry([{
    kind: "pi-agent",
    executeEnvelope: async (envelope) => {
      captured = envelope;
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: {
          summary: "Own API contracts discovered from structural evidence.",
          operatingInstructions: "Trace route symbols and their callers before reporting.",
          skills: [{ name: "AST route tracing", description: "Follow route declarations and call sites." }],
          toolRequirements: ["structural-search", "lsp"],
          dependencies: [{ nodeId: "workspace.data", reason: "Schema symbols shape route contracts." }],
        },
      };
    },
  }]);
  const reviewer = piCodingWorkspaceAgentReviewer(runtimes, {
    execution: createCodingWorkerExecution({
      runtime: "pi-agent",
      source: "product-default",
      env: {
        ROSTER_CODING_PI_EXTENSIONS: "/tmp/untrusted-mutation-extension.js",
        ROSTER_CODING_PI_TOOLS: "write,bash",
      },
    }),
    runId: "workspace-onboarding-test",
  });

  const review = await reviewer({
    repositoryRoot: process.cwd(),
    repositoryFingerprint: "repository-fingerprint",
    technologies: ["TypeScript"],
    node: { id: "workspace.api", name: "Theo", capabilities: ["review"] },
    roster: [{ id: "workspace.data", name: "Iris", specialty: "data" }],
    files: [{ path: "src/server.ts", content: "export const api = true;", truncated: false }],
  });

  assert.equal(captured?.runtime.kind, "pi-agent");
  assert.equal(captured?.runtime.metadata?.projectTrust, "no-approve");
  assert.deepEqual(captured?.runtime.metadata?.tools, [...CODING_WORKSPACE_DISCOVERY_PI_TOOLS]);
  assert.equal((captured?.runtime.metadata?.tools as ReadonlyArray<string>).includes("write"), false);
  assert.equal((captured?.runtime.metadata?.tools as ReadonlyArray<string>).includes("edit"), false);
  assert.equal((captured?.runtime.metadata?.tools as ReadonlyArray<string>).includes("bash"), false);
  assert.equal((captured?.runtime.metadata?.extensions as ReadonlyArray<string>)
    .includes("/tmp/untrusted-mutation-extension.js"), false);
  assert.ok((captured?.runtime.metadata?.extensions as ReadonlyArray<string>).some((extension) =>
    normalize(extension).endsWith(normalize("node_modules/@cortexkit/aft-pi/dist/index.js"))));
  assert.match(captured?.task.objective ?? "", /read-only onboarding/);
  assert.match(captured?.task.objective ?? "", /AST-grep/);
  assert.equal(review.skills[0]?.name, "AST route tracing");
});
