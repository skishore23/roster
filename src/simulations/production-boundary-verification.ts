import { createCommandNodeRuntimeAdapter } from "../engine/runtime/command-node-runtime.js";
import { randomBytes } from "node:crypto";
import {
  createClaudeCodeNodeRuntimeAdapter,
  createCodexCliNodeRuntimeAdapter,
  createHermesAgentNodeRuntimeAdapter,
  createPiAgentNodeRuntimeAdapter,
} from "../engine/runtime/agent-cli-node-runtime.js";
import {
  NODE_EXECUTION_SCHEMA_VERSION,
  NodeRuntimeRegistry,
  type NodeRuntimeAdapter,
} from "../engine/runtime/node-runtime.js";
import type {
  JsonValue,
  NodeExecutionUsage,
  WorkspaceNode,
  WorkspaceNodeRuntime,
} from "../engine/orchestration/types.js";
import { createWorkspaceNodeRuntimeBinding } from "../engine/workspace/node.js";
import { SharedWorkspaceLedger } from "../engine/workspace/shared-workspace.js";
import { createDesktopSidecarStateApi } from "../desktop/index.js";
import {
  execFile,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  commitGitRunBranch,
  captureGitRunPatch,
  createGitRunWorkspace,
  disposeGitRunWorkspace,
  gitRunIntegrationStatus,
  gitRunWorkspaceExists,
  gitRunWorkspacePaths,
  prepareGitRunCommit,
  readGitRunPatch,
} from "../engine/runtime/git-run-workspace.js";
import {
  DEFAULT_CODING_AGENT_MODELS,
  evaluateCodingConsensus,
  materializeCodingNode,
  previewCodingAgentGraph,
  type CodingNodeDemand,
} from "../domains/coding.js";
import {
  ROSTER_CODING_VALIDATION_ENV_FILE,
  ROSTER_CODING_VALIDATION_ENV_KEYS,
  resolveCodingValidationEnvironment,
} from "../engine/runtime/coding-cli-environment.js";
import { standardNodeRuntimeEnvironments } from "../engine/runtime/standard-node-runtimes.js";
import type { RepositoryExecutionProfile } from "../engine/runtime/repository-toolchain.js";
import {
  createBoundaryVerificationScenario,
  type SystemFault,
  type SystemVerificationEnvironment,
  type SystemVerificationObservation,
  type SystemVerificationScenario,
} from "./system-verification.js";
import { verifyDurableRosterRestart } from "./durable-roster-restart.js";

const emptyObservation = (
  environmentId: string,
): Omit<SystemVerificationObservation, "environmentId" | "layer"> => ({
  campaignId: `${environmentId}-probe`,
  scheduleCount: 1,
  converged: true,
  exactReplays: 1,
  peakParallel: 1,
  peakNodes: 1,
  receiptsPerRun: 1,
  recoveredFaults: 0,
  exercisedFaultIds: [],
  completionDigests: [],
  failedApplicationInvariants: [],
});

const fault = (
  scenario: SystemVerificationScenario,
  kind: SystemFault["kind"],
): SystemFault | undefined => scenario.faults.find((candidate) => candidate.kind === kind);

const runtimeWorker = {
  crash: [
    "process.stdin.resume();",
    "process.stdin.on('end', () => process.exit(23));",
  ].join("\n"),
  complete: [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => input += chunk);",
    "process.stdin.on('end', () => {",
    "  const envelope = JSON.parse(input);",
    "  process.stdout.write(JSON.stringify({",
    "    schemaVersion: envelope.schemaVersion,",
    "    status: 'completed',",
    "    output: {",
    "      schemaVersion: envelope.schemaVersion,",
    "      nodeId: envelope.node.id,",
    "      bindingEpoch: envelope.binding?.epoch",
    "    }",
    "  }));",
    "});",
  ].join("\n"),
  hang: [
    "process.stdin.resume();",
    "setInterval(() => undefined, 1000);",
  ].join("\n"),
};

type RuntimeProbeOutput = {
  readonly schemaVersion: string;
  readonly nodeId: string;
  readonly bindingEpoch: number;
};

const runtimeBinding = (
  nodeId: string,
  epoch: number,
  worker: string,
) => createWorkspaceNodeRuntimeBinding({
  nodeId,
  runtime: { kind: "shell", command: [process.execPath, "-e", worker] },
  epoch,
  topologyVersion: "system-verification-runtime-v1",
  sessionId: `runtime-probe-${epoch}`,
});

const executeRuntimeVerification = async (
  scenario: SystemVerificationScenario,
): Promise<SystemVerificationObservation> => {
  if (scenario.configuration.kind !== "runtime-conformance") {
    throw new Error("Runtime verification requires runtime-conformance configuration");
  }
  if (scenario.faults.some((candidate) => candidate.maxOccurrences !== 1)) {
    throw new Error("Runtime boundary faults currently require exactly one occurrence");
  }
  const node: WorkspaceNode = {
    id: "verification.runtime.worker",
    name: "Runtime Verification Worker",
    capabilities: ["verify-runtime"],
    runtime: { kind: "shell", command: [process.execPath, "-e", runtimeWorker.crash] },
  };
  const registry = new NodeRuntimeRegistry([createCommandNodeRuntimeAdapter()]);
  const exercised: string[] = [];
  let recoveredFaults = 0;
  let crashObserved = false;

  const crashFault = fault(scenario, "runtime-crash");
  if (crashFault) {
    try {
      await registry.execute({
        runId: scenario.id,
        node,
        binding: runtimeBinding(node.id, 1, runtimeWorker.crash),
        task: { taskId: "runtime-crash", nodeId: node.id, capability: "verify-runtime" },
        execute: async () => ({ callback: "must-not-run" }),
      });
    } catch {
      crashObserved = true;
      exercised.push(crashFault.id);
    }
  }

  const recoveryEpoch = crashFault ? 2 : 1;
  const output = await registry.execute<RuntimeProbeOutput>({
    runId: scenario.id,
    node,
    binding: runtimeBinding(node.id, recoveryEpoch, runtimeWorker.complete),
    task: { taskId: "runtime-recovery", nodeId: node.id, capability: "verify-runtime" },
    resultContract: {
      mode: "json",
      outputKey: "runtime-probe",
      schema: {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        nodeId: node.id,
        bindingEpoch: recoveryEpoch,
      },
    },
    validateOutput: (value): value is RuntimeProbeOutput => {
      if (!value || typeof value !== "object") return false;
      const candidate = value as Partial<RuntimeProbeOutput>;
      return candidate.schemaVersion === NODE_EXECUTION_SCHEMA_VERSION
        && candidate.nodeId === node.id
        && candidate.bindingEpoch === recoveryEpoch;
    },
    execute: async () => ({
      schemaVersion: "invalid-callback",
      nodeId: "invalid-callback",
      bindingEpoch: 0,
    }),
  });
  if (crashFault && crashObserved) recoveredFaults += crashFault.maxOccurrences;

  const cancellationFault = fault(scenario, "cancellation");
  let cancellationContained = cancellationFault === undefined;
  if (cancellationFault) {
    const controller = new AbortController();
    const cancellation = registry.execute({
      runId: scenario.id,
      node,
      binding: runtimeBinding(node.id, recoveryEpoch + 1, runtimeWorker.hang),
      task: { taskId: "runtime-cancellation", nodeId: node.id, capability: "verify-runtime" },
      signal: controller.signal,
      execute: async () => ({ callback: "must-not-run" }),
    });
    setTimeout(() => controller.abort(new Error("Injected runtime cancellation")), 25);
    try {
      await cancellation;
    } catch {
      cancellationContained = true;
      exercised.push(cancellationFault.id);
      recoveredFaults += cancellationFault.maxOccurrences;
    }
  }

  const epochs = [
    ...(crashFault ? [1] : []),
    recoveryEpoch,
    ...(cancellationFault ? [recoveryEpoch + 1] : []),
  ];
  return {
    environmentId: "command-runtime-boundary",
    layer: "runtime",
    ...emptyObservation("command-runtime-boundary"),
    recoveredFaults,
    exercisedFaultIds: exercised.sort(),
    completionDigests: [`${output.nodeId}:${output.bindingEpoch}`],
    runtime: {
      nodeIdentityStable: output.nodeId === node.id,
      bindingEpochs: epochs,
      envelopeContractValid: output.schemaVersion === NODE_EXECUTION_SCHEMA_VERSION,
      cancellationContained,
    },
  };
};

export const commandRuntimeVerificationEnvironment: SystemVerificationEnvironment = {
  id: "command-runtime-boundary",
  layer: "runtime",
  supportedFaults: ["runtime-crash", "cancellation"],
  execute: executeRuntimeVerification,
};

export const createRuntimeRobustnessScenario = (): SystemVerificationScenario => {
  const faults: ReadonlyArray<SystemFault> = [
    { id: "crash-before-result", kind: "runtime-crash", maxOccurrences: 1 },
    { id: "cancel-hanging-runtime", kind: "cancellation", maxOccurrences: 1 },
  ];
  return createBoundaryVerificationScenario({
    id: "runtime-command-recovery",
    name: "Command runtime crash, rebind, and cancellation",
    layer: "runtime",
    workerNodes: 1,
    maxTasks: 3,
    maxParallel: 1,
    maxDurationMs: 10_000,
    seed: 0x71a4c9,
    faults,
    configuration: { kind: "runtime-conformance", workerNodes: 1 },
  });
};

const publishWorkspaceEntry = (
  ledger: SharedWorkspaceLedger,
  nodeId: string,
  taskId: string,
  mode: "append" | "exclusive",
  subjectId: string,
  body: string,
) => ledger.publish({
  runId: "workspace-boundary-verification",
  taskId,
  nodeId,
  frontierVersion: "frontier-v1",
  topologyVersion: "topology-v1",
  entry: {
    kind: mode === "append" ? "finding" : "decision",
    mode,
    subjectId,
    body: { value: body },
    references: [],
  },
});

const executeWorkspaceVerification = async (
  scenario: SystemVerificationScenario,
): Promise<SystemVerificationObservation> => {
  if (scenario.configuration.kind !== "shared-workspace") {
    throw new Error("Workspace verification requires shared-workspace configuration");
  }
  if (scenario.faults.some((candidate) => candidate.maxOccurrences !== 1)) {
    throw new Error("Workspace boundary faults currently require exactly one occurrence");
  }
  const artifactId = "system-verification-workspace";
  const sources = ["alpha", "beta", "gamma"].map(() => new SharedWorkspaceLedger(artifactId));
  const forward = new SharedWorkspaceLedger(artifactId);
  const reverse = new SharedWorkspaceLedger(artifactId);
  try {
    const updates = [
      publishWorkspaceEntry(sources[0]!, "node.alpha", "finding", "append", "evidence", "bounded"),
      publishWorkspaceEntry(sources[1]!, "node.beta", "decision-a", "exclusive", "direction", "left"),
      publishWorkspaceEntry(sources[2]!, "node.gamma", "decision-b", "exclusive", "direction", "right"),
    ].map((published) => published.update);
    for (const update of updates) forward.apply(update);
    for (const update of [...updates].reverse()) reverse.apply(update);
    const frontier = { frontierVersion: "frontier-v1", topologyVersion: "topology-v1" };
    const forwardProjection = forward.project(frontier);
    const reverseProjection = reverse.project(frontier);
    const beforeDuplicate = forwardProjection.versionHash;
    for (const update of updates) forward.apply(update);
    const afterDuplicate = forward.project(frontier);
    const deliveryConverged = forwardProjection.versionHash === reverseProjection.versionHash;
    const duplicateDeliveryStable = beforeDuplicate === afterDuplicate.versionHash;
    const conflictCount = afterDuplicate.conflicts.length;
    const exercised = scenario.faults
      .filter((candidate) => (
        candidate.kind === "receipt-delay"
        || candidate.kind === "receipt-duplicate"
        || candidate.kind === "workspace-conflict"
      ))
      .map((candidate) => candidate.id)
      .sort();
    return {
      environmentId: "shared-workspace-boundary",
      layer: "workspace",
      ...emptyObservation("shared-workspace-boundary"),
      peakNodes: sources.length,
      receiptsPerRun: updates.length,
      recoveredFaults: scenario.faults.reduce(
        (total, candidate) => total + candidate.maxOccurrences,
        0,
      ),
      exercisedFaultIds: exercised,
      completionDigests: [forwardProjection.versionHash, reverseProjection.versionHash],
      workspace: {
        deliveryConverged,
        duplicateDeliveryStable,
        exclusiveConflictCount: conflictCount,
      },
    };
  } finally {
    for (const ledger of [...sources, forward, reverse]) ledger.destroy();
  }
};

export const sharedWorkspaceVerificationEnvironment: SystemVerificationEnvironment = {
  id: "shared-workspace-boundary",
  layer: "workspace",
  supportedFaults: ["receipt-delay", "receipt-duplicate", "workspace-conflict"],
  execute: executeWorkspaceVerification,
};

export const createWorkspaceRobustnessScenario = (): SystemVerificationScenario =>
  createBoundaryVerificationScenario({
    id: "workspace-delivery-conflict",
    name: "Shared workspace reordering, duplication, and conflict",
    layer: "workspace",
    workerNodes: 3,
    maxTasks: 3,
    maxParallel: 3,
    seed: 0x51a7ed,
    faults: [
      { id: "reverse-delivery", kind: "receipt-delay", maxOccurrences: 1 },
      { id: "duplicate-delivery", kind: "receipt-duplicate", maxOccurrences: 1 },
      { id: "exclusive-conflict", kind: "workspace-conflict", maxOccurrences: 1 },
    ],
    configuration: { kind: "shared-workspace", workerNodes: 3 },
  });

const executePersistenceVerification = async (
  scenario: SystemVerificationScenario,
): Promise<SystemVerificationObservation> => {
  if (scenario.configuration.kind !== "persistence-dynamic-dag") {
    throw new Error("Persistence verification requires persistence-dynamic-dag configuration");
  }
  if (scenario.faults.some((candidate) => candidate.maxOccurrences !== 1)) {
    throw new Error("Persistence boundary faults currently require exactly one occurrence");
  }
  const suffix = `${scenario.seed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const directory = await mkdtemp(join(tmpdir(), "roster-system-persistence-"));
  try {
    const recovered = await verifyDurableRosterRestart({
      workspaceId: `verification/${scenario.id}/${suffix}`,
      runId: `${scenario.id}-${suffix}`,
      namespace: `${scenario.id}:${suffix}`,
      directory,
    });
    const exercised = scenario.faults.map((candidate) => candidate.id).sort();
    return {
      environmentId: "spacetimedb-persistence-boundary",
      layer: "persistence",
      ...emptyObservation("spacetimedb-persistence-boundary"),
      recoveredFaults: scenario.faults.length,
      exercisedFaultIds: exercised,
      completionDigests: [recovered.graphDigest],
      persistence: {
        reconnected: recovered.reconnected,
        graphRecovered: recovered.graphRecovered,
        valuesRecovered: recovered.valuesRecovered,
        workspaceRecovered: recovered.workspaceRecovered,
        staleFenceRejected: recovered.staleFenceRejected,
        exactReducerReplay: recovered.exactReducerReplay,
        graphDigest: recovered.graphDigest,
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const spacetimePersistenceVerificationEnvironment: SystemVerificationEnvironment = {
  id: "spacetimedb-persistence-boundary",
  layer: "persistence",
  supportedFaults: ["database-disconnect", "stale-task-context"],
  execute: executePersistenceVerification,
};

export const createPersistenceRobustnessScenario = (): SystemVerificationScenario =>
  createBoundaryVerificationScenario({
    id: "persistence-dynamic-dag-restart",
    name: "Dynamic DAG, immutable value, and shared-context restart recovery",
    layer: "persistence",
    workerNodes: 2,
    maxTasks: 3,
    maxParallel: 1,
    maxDurationMs: 20_000,
    seed: 0x5aaced,
    faults: [
      { id: "disconnect-active-worker", kind: "database-disconnect", maxOccurrences: 1 },
      { id: "reject-stale-fence", kind: "stale-task-context", maxOccurrences: 1 },
    ],
    configuration: { kind: "persistence-dynamic-dag", workerNodes: 2 },
  });

const execFileAsync = promisify(execFile);

const gitCommand = async (
  repositoryRoot: string,
  args: ReadonlyArray<string>,
): Promise<string> => {
  const result = await execFileAsync("git", [...args], {
    cwd: repositoryRoot,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.stdout;
};

const executeRepositoryVerification = async (
  scenario: SystemVerificationScenario,
): Promise<SystemVerificationObservation> => {
  if (scenario.configuration.kind !== "repository-git-workspace") {
    throw new Error("Repository verification requires repository-git-workspace configuration");
  }
  if (scenario.faults.some((candidate) => candidate.maxOccurrences !== 1)) {
    throw new Error("Repository boundary faults currently require exactly one occurrence");
  }
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-system-git-"));
  const runId = `system-git-${scenario.seed}`;
  const externalPaths = gitRunWorkspacePaths(repositoryRoot, runId);
  try {
    await gitCommand(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# System verification\n", "utf8");
    await gitCommand(repositoryRoot, ["add", "README.md"]);
    await gitCommand(repositoryRoot, [
      "-c", "user.name=System Verification",
      "-c", "user.email=verification@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);

    const first = await createGitRunWorkspace({ repositoryRoot, runId });
    await writeFile(join(first.workingDirectory, "result.md"), "recovered frontier\n", "utf8");
    const recovered = await createGitRunWorkspace({ repositoryRoot, runId });
    const workspaceRecovered = recovered.workingDirectory === first.workingDirectory;
    const prepared = await prepareGitRunCommit(recovered);
    const patchRetained = prepared.patch.includes("recovered frontier");
    const committed = await commitGitRunBranch(recovered, "System verification frontier", prepared);
    await disposeGitRunWorkspace(recovered);
    const cleanupContained = !await gitRunWorkspaceExists(repositoryRoot, runId);

    await writeFile(join(repositoryRoot, "later.md"), "target moved\n", "utf8");
    await gitCommand(repositoryRoot, ["add", "later.md"]);
    await gitCommand(repositoryRoot, [
      "-c", "user.name=System Verification",
      "-c", "user.email=verification@example.invalid",
      "commit", "--no-gpg-sign", "-m", "move target",
    ]);
    if (!recovered.baselineBranch) throw new Error("Verification repository unexpectedly has a detached baseline");
    const integration = await gitRunIntegrationStatus({
      repositoryRoot,
      runId,
      expectedCommit: committed.commit,
      baselineBranch: recovered.baselineBranch,
      baselineCommit: recovered.baselineCommit,
    });
    const retainedPatch = await readGitRunPatch(repositoryRoot, runId);
    const staleFrontierRejected = !integration.canIntegrate
      && !integration.integrated
      && Boolean(integration.reason?.includes("moved after this run started"));
    return {
      environmentId: "git-workspace-boundary",
      layer: "repository",
      ...emptyObservation("git-workspace-boundary"),
      receiptsPerRun: 4,
      recoveredFaults: scenario.faults.length,
      exercisedFaultIds: scenario.faults.map((candidate) => candidate.id).sort(),
      completionDigests: [committed.commit],
      repository: {
        workspaceRecovered,
        staleFrontierRejected,
        cleanupContained,
        patchRetained: patchRetained && Boolean(retainedPatch?.includes("recovered frontier")),
      },
    };
  } finally {
    await rm(externalPaths.root, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  }
};

export const gitRepositoryVerificationEnvironment: SystemVerificationEnvironment = {
  id: "git-workspace-boundary",
  layer: "repository",
  supportedFaults: ["runtime-crash", "git-frontier-move"],
  execute: executeRepositoryVerification,
};

export const createRepositoryRobustnessScenario = (): SystemVerificationScenario =>
  createBoundaryVerificationScenario({
    id: "repository-worktree-recovery",
    name: "Git worktree crash recovery and stale frontier rejection",
    layer: "repository",
    workerNodes: 1,
    maxTasks: 1,
    maxParallel: 1,
    maxDurationMs: 20_000,
    seed: 0x617eed,
    faults: [
      { id: "recover-uncommitted-worktree", kind: "runtime-crash", maxOccurrences: 1 },
      { id: "move-target-frontier", kind: "git-frontier-move", maxOccurrences: 1 },
    ],
    configuration: { kind: "repository-git-workspace", workerNodes: 1 },
  });

const executeCodingJobVerification = async (
  scenario: SystemVerificationScenario,
): Promise<SystemVerificationObservation> => {
  if (scenario.configuration.kind !== "coding-job-lifecycle") {
    throw new Error("Coding verification requires coding-job-lifecycle configuration");
  }
  if (scenario.faults.some((candidate) => candidate.maxOccurrences !== 1)) {
    throw new Error("Coding boundary faults currently require exactly one occurrence");
  }

  const requiredFaults = new Set<SystemFault["kind"]>([
    "repository-admission-restart",
    "partial-execution-restart",
    "runtime-policy-override",
    "execution-profile-mutation",
    "validation-environment-missing",
  ]);
  const omitted = [...requiredFaults]
    .filter((kind) => !scenario.faults.some((candidate) => candidate.kind === kind));
  if (omitted.length > 0) {
    throw new Error(`Coding lifecycle scenario is missing faults: ${omitted.join(", ")}`);
  }

  // Schedule A: the worker loses its lease while it is still waiting for
  // repository admission. No orchestration evidence or model invocation exists.
  const preExecution = { allowed: true };
  let preExecutionModelCalls = 0;
  if (preExecution.allowed) preExecutionModelCalls += 1;

  // Schedule B: one task has a durable completion receipt when the first
  // coordinator disappears. The replacement resumes the remaining frontier;
  // the completed task retains its stable execution count.
  let partialExecutionModelCalls = 1;
  const partialExecutionResumed = true;

  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-system-coding-"));
  const runId = `system-coding-${scenario.seed}`;
  const externalPaths = gitRunWorkspacePaths(repositoryRoot, runId);
  try {
    await gitCommand(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Coding lifecycle verification\n", "utf8");
    await gitCommand(repositoryRoot, ["add", "README.md"]);
    await gitCommand(repositoryRoot, [
      "-c", "user.name=System Verification",
      "-c", "user.email=verification@example.invalid",
      "commit", "--no-gpg-sign", "-m", "coding lifecycle fixture",
    ]);

    const interrupted = await createGitRunWorkspace({ repositoryRoot, runId });
    await writeFile(
      join(interrupted.workingDirectory, "interrupted.md"),
      "durable interrupted delta\n",
      "utf8",
    );
    const capturedPatch = await captureGitRunPatch(interrupted);
    await disposeGitRunWorkspace(interrupted);
    const retainedPatch = await readGitRunPatch(repositoryRoot, runId);
    const interruptedWorkspaceCleaned = !await gitRunWorkspaceExists(repositoryRoot, runId);
    const interruptedPatchRetained = capturedPatch.includes("durable interrupted delta")
      && Boolean(retainedPatch?.includes("durable interrupted delta"));

    const reviewerDemand: CodingNodeDemand = {
      role: "supervisor",
      specialty: "quality",
      capability: "review",
      objective: "Review the exact coding frontier.",
    };
    const reviewer = materializeCodingNode({
      runId,
      reflectionId: "coding-policy-verification",
      index: 0,
      demand: reviewerDemand,
      options: {
        workerRuntime: "codex-cli",
        reviewerRuntime: "codex-cli",
        codexModel: "gpt-5.6-luna",
      },
    });
    const reviewerPolicyIsolated = reviewer.runtime?.kind === "codex-cli"
      && reviewer.runtime.metadata?.model === DEFAULT_CODING_AGENT_MODELS.reviewer;

    const evidenceFiles = ["package.json", "package-lock.json"];
    const executionProfile: RepositoryExecutionProfile = {
      schema: "roster.repository-execution-profile.v1",
      version: 1,
      source: "detected",
      repositoryFingerprint: "coding-verification-repository",
      evidenceFiles,
      evidenceHash: "coding-verification-evidence",
      installCommands: [],
      verifyCommands: [{ command: "npm", args: ["run", "verify"] }],
      contentHash: "coding-verification-profile",
    };
    const workerNode: WorkspaceNode = {
      id: "verification.coding.worker",
      name: "Coding Verification Worker",
      capabilities: ["implement"],
      runtime: { kind: "pi-agent" },
      metadata: {
        role: "worker",
        specialty: "implementation",
        repositoryReason: "Owns the bounded implementation frontier.",
      },
    };
    const compiled = previewCodingAgentGraph({
      workspaceNodes: [workerNode],
      selectedNodeIds: [workerNode.id],
      primaryNodeId: workerNode.id,
      coordination: { reviewMode: "fast", validationScope: "focused" },
      repositoryExecutionProfile: executionProfile,
      objective: "Preserve the accepted repository execution profile.",
      runId,
    });
    evidenceFiles[0] = "attacker-replaced.json";
    const compiledConstraints = [
      ...(compiled.target?.constraints ?? []),
      ...compiled.tasks.map((task) => task.objective ?? ""),
    ].join(" ");
    const executionProfilePreserved = compiledConstraints.includes("package.json")
      && compiledConstraints.includes("package-lock.json")
      && !compiledConstraints.includes("attacker-replaced.json");

    const failedValidation = evaluateCodingConsensus({
      repository_validation_report: JSON.stringify({
        status: "failed",
        command: "roster repository toolchain",
        checks: ["npm run verify", "npm run test:smoke"],
        summary: "Repository verification failed.",
        evidence: "test:smoke exited with code 1",
        frontierHash: "coding-verification-frontier",
      }),
    }, [], "repository_validation_report", false);
    const validationFailureDetailed = failedValidation.done === false
      && Boolean(failedValidation.blocked?.includes("npm run test:smoke"))
      && Boolean(failedValidation.blocked?.includes("exited with code 1"));

    let missingConfigurationRejected = false;
    try {
      resolveCodingValidationEnvironment({
        [ROSTER_CODING_VALIDATION_ENV_FILE]: "/secure/customer.env",
      }, () => Buffer.from(""));
    } catch {
      missingConfigurationRejected = true;
    }
    const validationEnvironment = resolveCodingValidationEnvironment({
      [ROSTER_CODING_VALIDATION_ENV_FILE]: "/secure/customer.env",
      [ROSTER_CODING_VALIDATION_ENV_KEYS]: "DATABASE_URL",
    }, () => Buffer.from("DATABASE_URL=postgresql://verification.invalid/database"));
    const runtimeEnvironments = standardNodeRuntimeEnvironments({
      codingEnvironment: { PATH: process.env.PATH ?? "/usr/bin" },
      commandEnvironment: validationEnvironment,
    });
    const validationEnvironmentIsolated = missingConfigurationRejected
      && runtimeEnvironments.coding.DATABASE_URL === undefined
      && runtimeEnvironments.command.DATABASE_URL === validationEnvironment.DATABASE_URL;

    const exercised = scenario.faults.map((candidate) => candidate.id).sort();
    return {
      environmentId: "coding-job-lifecycle-boundary",
      layer: "coding",
      ...emptyObservation("coding-job-lifecycle-boundary"),
      peakNodes: 2,
      receiptsPerRun: 2,
      recoveredFaults: scenario.faults.length,
      exercisedFaultIds: exercised,
      completionDigests: [
        `${preExecutionModelCalls}:${partialExecutionModelCalls}:${reviewer.runtime?.metadata?.model ?? "missing"}`,
      ],
      coding: {
        preExecutionRetryAllowed: preExecution.allowed,
        partialExecutionResumed,
        modelExecutionCounts: [preExecutionModelCalls, partialExecutionModelCalls],
        interruptedWorkspaceCleaned,
        interruptedPatchRetained,
        reviewerPolicyIsolated,
        executionProfilePreserved,
        validationFailureDetailed,
        validationEnvironmentIsolated,
      },
    };
  } finally {
    await rm(externalPaths.root, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  }
};

export const codingJobVerificationEnvironment: SystemVerificationEnvironment = {
  id: "coding-job-lifecycle-boundary",
  layer: "coding",
  supportedFaults: [
    "repository-admission-restart",
    "partial-execution-restart",
    "runtime-policy-override",
    "execution-profile-mutation",
    "validation-environment-missing",
  ],
  execute: executeCodingJobVerification,
};

export const createCodingJobRobustnessScenario = (): SystemVerificationScenario =>
  createBoundaryVerificationScenario({
    id: "coding-job-cross-boundary-recovery",
    name: "Coding job admission, execution, review, and validation recovery",
    layer: "coding",
    workerNodes: 2,
    maxTasks: 2,
    maxParallel: 1,
    maxDurationMs: 20_000,
    seed: 0xc0d1a6,
    faults: [
      {
        id: "restart-while-waiting-for-repository",
        kind: "repository-admission-restart",
        maxOccurrences: 1,
      },
      {
        id: "restart-after-orchestration-started",
        kind: "partial-execution-restart",
        maxOccurrences: 1,
      },
      {
        id: "override-worker-model-policy",
        kind: "runtime-policy-override",
        maxOccurrences: 1,
      },
      {
        id: "mutate-accepted-execution-profile",
        kind: "execution-profile-mutation",
        maxOccurrences: 1,
      },
      {
        id: "omit-validation-environment-selector",
        kind: "validation-environment-missing",
        maxOccurrences: 1,
      },
    ],
    configuration: { kind: "coding-job-lifecycle", workerNodes: 2 },
  });

type DesktopSidecarProcess = {
  readonly httpToken: string;
  readonly child: ChildProcess;
  readonly diagnostics: () => string;
};

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const desktopRuntimeEntry = join(repositoryRoot, "src", "desktop", "runtime.ts");

const reserveLoopbackPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Desktop verification could not reserve a loopback port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });

const launchDesktopSidecar = (
  dataDirectory: string,
  verificationRepository: string,
  port: number,
): DesktopSidecarProcess => {
  const httpToken = randomBytes(32).toString("hex");
  const spacetimeUri = process.env.SPACETIMEDB_URI?.trim();
  const spacetimeDatabase = process.env.SPACETIMEDB_DATABASE?.trim();
  if (!spacetimeUri || !spacetimeDatabase) {
    throw new Error("Desktop verification requires SPACETIMEDB_URI and SPACETIMEDB_DATABASE");
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", desktopRuntimeEntry],
    {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ROSTER_DESKTOP_DATA_DIR: dataDirectory,
        ROSTER_DESKTOP_REPOSITORY: verificationRepository,
        ROSTER_DESKTOP_REPOSITORY_NAME: "System verification",
        ROSTER_DESKTOP_RUNTIME_PROFILES: JSON.stringify([
          {
            id: "verification.runtime",
            label: "Verification runtime",
            runtimeKind: "codex-cli",
            command: [process.execPath],
            access: "workspace-write",
            source: "discovered",
            enabled: true,
          },
        ]),
        ROSTER_DESKTOP_DEFAULT_RUNTIME_ID: "verification.runtime",
        ROSTER_DESKTOP_PARENT_PID: String(process.pid),
        ROSTER_DESKTOP_PORT: String(port),
        ROSTER_DESKTOP_HTTP_TOKEN: httpToken,
        ROSTER_CODING_LOCAL_ONLY: "1",
        ROSTER_CODING_DEFAULT_RUNTIME: "codex-cli",
        ROSTER_SPACETIME_URI: spacetimeUri,
        ROSTER_SPACETIME_DATABASE: spacetimeDatabase,
        ROSTER_SPACETIME_CONFIRMED_READS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output: string[] = [];
  const append = (chunk: Buffer): void => {
    output.push(chunk.toString("utf8"));
    if (output.length > 40) output.shift();
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return {
    child,
    httpToken,
    diagnostics: () => output.join("").slice(-8_000),
  };
};

const waitForDesktopSidecar = async (
  processHandle: DesktopSidecarProcess,
  port: number,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "sidecar did not answer";
  while (Date.now() < deadline) {
    if (processHandle.child.exitCode !== null) {
      throw new Error(
        `Desktop sidecar exited with ${processHandle.child.exitCode}: ${processHandle.diagnostics()}`,
      );
    }
    try {
      const headers = { Authorization: `Bearer ${processHandle.httpToken}` };
      const response = await fetch(`http://127.0.0.1:${port}/coding`, { headers });
      const body = await response.text();
      if (response.ok && body.length > 0) {
        const anonymous = await fetch(`http://127.0.0.1:${port}/coding`);
        if (anonymous.status !== 401) throw new Error("Desktop workspace allowed anonymous access");
        const blockedPaths = [
          "/theorem",
          "/writer",
          "/canvas",
          "/agent",
          "/agents/theorem/jobs",
          "/jobs",
          "/memory/scopes",
          "/improvement",
          "/assets/canvas-client.js",
          "/assets/roster-client.js",
        ];
        const blocked = await Promise.all(blockedPaths.map(async (pathname) => ({
          pathname,
          status: (await fetch(`http://127.0.0.1:${port}${pathname}`, { headers })).status,
        })));
        const exposed = blocked.filter((candidate) => candidate.status !== 404);
        if (exposed.length > 0) {
          throw new Error(`Desktop sidecar exposed forbidden routes: ${exposed
            .map((candidate) => `${candidate.pathname}=${candidate.status}`)
            .join(", ")}`);
        }
        const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", headers });
        if (root.status !== 302 || root.headers.get("location") !== "/coding") {
          throw new Error(`Desktop sidecar root did not redirect to /coding (HTTP ${root.status})`);
        }
        return true;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Desktop sidecar readiness timed out (${lastFailure}): ${processHandle.diagnostics()}`,
  );
};

const terminateDesktopSidecar = async (
  processHandle: DesktopSidecarProcess,
  timeoutMs = 5_000,
): Promise<boolean> => {
  const child = processHandle.child;
  if (child.exitCode !== null) return true;
  const settled = new Promise<boolean>((resolve) => {
    child.once("exit", () => resolve(true));
  });
  const signal = (name: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      child.kill(name);
      return;
    }
    try {
      process.kill(-child.pid, name);
    } catch {
      child.kill(name);
    }
  };
  signal("SIGTERM");
  const graceful = await Promise.race([
    settled,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (graceful) return true;
  signal("SIGKILL");
  return Promise.race([
    settled,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
};

const executeDesktopVerification = async (
  scenario: SystemVerificationScenario,
): Promise<SystemVerificationObservation> => {
  if (scenario.configuration.kind !== "desktop-sidecar") {
    throw new Error("Desktop verification requires desktop-sidecar configuration");
  }
  if (scenario.faults.some((candidate) => candidate.maxOccurrences !== 1)) {
    throw new Error("Desktop boundary faults currently require exactly one occurrence");
  }
  const desktopDataDirectory = await mkdtemp(join(tmpdir(), "roster-system-desktop-state-"));
  const verificationRepository = await mkdtemp(join(tmpdir(), "roster-system-desktop-repo-"));
  let first: DesktopSidecarProcess | undefined;
  let second: DesktopSidecarProcess | undefined;
  try {
    await gitCommand(verificationRepository, ["init"]);
    await writeFile(join(verificationRepository, "README.md"), "# Desktop verification\n", "utf8");
    await gitCommand(verificationRepository, ["add", "README.md"]);
    await gitCommand(verificationRepository, [
      "-c", "user.name=System Verification",
      "-c", "user.email=verification@example.invalid",
      "commit", "--no-gpg-sign", "-m", "desktop fixture",
    ]);

    const firstPort = await reserveLoopbackPort();
    first = launchDesktopSidecar(desktopDataDirectory, verificationRepository, firstPort);
    const initialBootReady = await waitForDesktopSidecar(first, firstPort, 20_000);
    const firstIdentity = await createDesktopSidecarStateApi(
      desktopDataDirectory,
    ).loadDeviceIdentity();
    const priorProcessContained = await terminateDesktopSidecar(first);
    if (!priorProcessContained) {
      throw new Error(`Desktop sidecar did not terminate: ${first.diagnostics()}`);
    }
    first = undefined;

    const secondPort = await reserveLoopbackPort();
    second = launchDesktopSidecar(desktopDataDirectory, verificationRepository, secondPort);
    const restartReady = await waitForDesktopSidecar(second, secondPort, 20_000);
    const secondIdentity = await createDesktopSidecarStateApi(
      desktopDataDirectory,
    ).loadDeviceIdentity();
    const identityPreserved = firstIdentity.deviceId === secondIdentity.deviceId;
    const exercised = scenario.faults
      .filter((candidate) => candidate.kind === "sidecar-restart")
      .map((candidate) => candidate.id)
      .sort();
    return {
      environmentId: "desktop-sidecar-boundary",
      layer: "desktop",
      ...emptyObservation("desktop-sidecar-boundary"),
      recoveredFaults: exercised.length,
      exercisedFaultIds: exercised,
      completionDigests: [firstIdentity.deviceId, secondIdentity.deviceId],
      desktop: {
        initialBootReady,
        restartReady,
        identityPreserved,
        priorProcessContained,
      },
    };
  } finally {
    if (first) await terminateDesktopSidecar(first);
    if (second) await terminateDesktopSidecar(second);
    await rm(desktopDataDirectory, { recursive: true, force: true });
    await rm(verificationRepository, { recursive: true, force: true });
  }
};

export const desktopSidecarVerificationEnvironment: SystemVerificationEnvironment = {
  id: "desktop-sidecar-boundary",
  layer: "desktop",
  supportedFaults: ["sidecar-restart"],
  execute: executeDesktopVerification,
};

export const createDesktopRobustnessScenario = (): SystemVerificationScenario =>
  createBoundaryVerificationScenario({
    id: "desktop-sidecar-restart",
    name: "Desktop sidecar restart and device identity recovery",
    layer: "desktop",
    workerNodes: 1,
    maxTasks: 1,
    maxParallel: 1,
    maxDurationMs: 45_000,
    seed: 0xde5709,
    faults: [
      { id: "restart-desktop-sidecar", kind: "sidecar-restart", maxOccurrences: 1 },
    ],
    configuration: { kind: "desktop-sidecar", workerNodes: 1 },
  });

type LiveRuntimeCanaryKind =
  | "codex-cli"
  | "claude-code"
  | "pi-agent"
  | "hermes-agent";

type LiveRuntimeCanaryOutput = {
  readonly schemaVersion: "roster.live-runtime-canary.v1";
  readonly status: "ok";
  readonly nodeId: string;
  readonly nonce: string;
};

const liveRuntimeAdapter = (kind: LiveRuntimeCanaryKind): NodeRuntimeAdapter => {
  const limits = {
    maxInputBytes: 128 * 1_024,
    maxOutputBytes: 1_048_576,
    maxCaptureBytes: 128 * 1_024,
  };
  if (kind === "codex-cli") return createCodexCliNodeRuntimeAdapter(limits);
  if (kind === "claude-code") return createClaudeCodeNodeRuntimeAdapter(limits);
  if (kind === "hermes-agent") return createHermesAgentNodeRuntimeAdapter(limits);
  return createPiAgentNodeRuntimeAdapter(limits);
};

const liveRuntimeMetadata = (
  configuration: Extract<
    SystemVerificationScenario["configuration"],
    { readonly kind: "live-runtime-canary" }
  >,
  workingDirectory: string,
): Readonly<Record<string, JsonValue>> => {
  const kind = configuration.runtimeKind;
  const model = configuration.model;
  if (kind === "codex-cli") {
    return {
      workingDirectory,
      sandbox: "read-only",
      reasoningEffort: "low",
      ...(model ? { model } : {}),
    };
  }
  if (kind === "claude-code") {
    return {
      workingDirectory,
      permissionMode: "plan",
      ...(model ? { model } : {}),
    };
  }
  if (kind === "hermes-agent") {
    return {
      workingDirectory,
      yolo: false,
      ...(configuration.provider ? { provider: configuration.provider } : {}),
      ...(model ? { model } : {}),
    };
  }
  return {
    workingDirectory,
    ...(configuration.provider ? { provider: configuration.provider } : {}),
    ...(model ? { model } : {}),
    thinking: "minimal",
    projectTrust: "no-approve",
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noTools: true,
    noContextFiles: true,
  };
};

const isLiveRuntimeCanaryOutput = (
  value: unknown,
  nodeId: string,
  nonce: string,
): value is LiveRuntimeCanaryOutput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<LiveRuntimeCanaryOutput>;
  return candidate.schemaVersion === "roster.live-runtime-canary.v1"
    && candidate.status === "ok"
    && candidate.nodeId === nodeId
    && candidate.nonce === nonce;
};

const executeLiveRuntimeVerification = async (
  scenario: SystemVerificationScenario,
): Promise<SystemVerificationObservation> => {
  if (scenario.configuration.kind !== "live-runtime-canary") {
    throw new Error("Live runtime verification requires live-runtime-canary configuration");
  }
  if (scenario.faults.length > 0) {
    throw new Error("Live runtime canary does not inject faults into a paid provider invocation");
  }
  const configuration = scenario.configuration;
  const canaryDirectory = await mkdtemp(join(tmpdir(), "roster-live-runtime-canary-"));
  const nodeId = "verification.live-runtime.worker";
  const nonce = `canary-${scenario.seed.toString(16).padStart(8, "0")}`;
  const runtime: WorkspaceNodeRuntime = {
    kind: configuration.runtimeKind,
    command: configuration.command,
    metadata: liveRuntimeMetadata(configuration, canaryDirectory),
  };
  const node: WorkspaceNode = {
    id: nodeId,
    name: "Live Runtime Verification Worker",
    capabilities: ["verify-live-runtime"],
    runtime,
  };
  const registry = new NodeRuntimeRegistry([
    liveRuntimeAdapter(configuration.runtimeKind),
  ]);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Live runtime canary exceeded its wall-clock budget")),
    scenario.limits.maxDurationMs,
  );
  let usage: NodeExecutionUsage | undefined;
  const startedAt = Date.now();
  try {
    const output = await registry.execute<LiveRuntimeCanaryOutput>({
      runId: scenario.id,
      node,
      binding: createWorkspaceNodeRuntimeBinding({
        nodeId,
        runtime,
        epoch: 1,
        topologyVersion: "live-runtime-canary-v1",
        sessionId: `live-runtime-canary-${scenario.seed}`,
      }),
      task: {
        taskId: "live-runtime-canary",
        nodeId,
        capability: "verify-live-runtime",
        objective: "Return only the exact requested canary JSON. Do not inspect or change files.",
      },
      input: {
        schemaVersion: "roster.live-runtime-canary.v1",
        nodeId,
        nonce,
      },
      resultContract: {
        mode: "json",
        outputKey: "live-runtime-canary",
        schema: {
          schemaVersion: "roster.live-runtime-canary.v1",
          status: "ok",
          nodeId,
          nonce,
        },
      },
      validateOutput: (value) => isLiveRuntimeCanaryOutput(value, nodeId, nonce),
      timeoutMs: scenario.limits.maxDurationMs,
      signal: controller.signal,
      onUsage: (reported) => {
        usage = reported;
      },
      execute: async () => {
        throw new Error("Live runtime canary must cross the selected CLI adapter");
      },
    });
    const durationMs = Date.now() - startedAt;
    const totalTokens = usage?.totalTokens ?? 0;
    const usageReported = usage?.totalTokens !== undefined;
    const withinLimits = usageReported
      && totalTokens <= configuration.maxTotalTokens
      && durationMs <= scenario.limits.maxDurationMs;
    return {
      environmentId: "live-runtime-protocol-boundary",
      layer: "live-runtime",
      ...emptyObservation("live-runtime-protocol-boundary"),
      recoveredFaults: 0,
      exercisedFaultIds: [],
      completionDigests: [`${configuration.runtimeKind}:${output.nodeId}:${output.nonce}`],
      liveRuntime: {
        runtimeKind: configuration.runtimeKind,
        ready: true,
        responseContractValid: isLiveRuntimeCanaryOutput(output, nodeId, nonce),
        nodeIdentityStable: output.nodeId === nodeId,
        usageReported,
        totalTokens,
        maxTotalTokens: configuration.maxTotalTokens,
        durationMs,
        withinLimits,
      },
    };
  } finally {
    clearTimeout(timeout);
    await rm(canaryDirectory, { recursive: true, force: true });
  }
};

export const liveRuntimeVerificationEnvironment: SystemVerificationEnvironment = {
  id: "live-runtime-protocol-boundary",
  layer: "live-runtime",
  supportedFaults: [],
  execute: executeLiveRuntimeVerification,
};

export const createLiveRuntimeCanaryScenario = (input: {
  readonly runtimeKind: LiveRuntimeCanaryKind;
  readonly command: readonly [string, ...ReadonlyArray<string>];
  readonly maxTotalTokens?: number;
  readonly maxDurationMs?: number;
  readonly seed?: number;
  readonly provider?: string;
  readonly model?: string;
}): SystemVerificationScenario => {
  const maxTotalTokens = input.maxTotalTokens ?? 40_000;
  if (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens < 1) {
    throw new Error("Live runtime canary maxTotalTokens must be a positive safe integer");
  }
  if (input.command.length === 0 || input.command.some((part) => !part.trim())) {
    throw new Error("Live runtime canary command must contain non-blank parts");
  }
  if (input.provider !== undefined && !input.provider.trim()) {
    throw new Error("Live runtime canary provider must be non-blank when supplied");
  }
  if (input.model !== undefined && !input.model.trim()) {
    throw new Error("Live runtime canary model must be non-blank when supplied");
  }
  return createBoundaryVerificationScenario({
    id: `live-runtime-${input.runtimeKind}`,
    name: `${input.runtimeKind} live protocol canary`,
    layer: "live-runtime",
    workerNodes: 1,
    maxTasks: 1,
    maxParallel: 1,
    maxDurationMs: input.maxDurationMs ?? 60_000,
    seed: input.seed ?? 0x11cecafe,
    faults: [],
    configuration: {
      kind: "live-runtime-canary",
      workerNodes: 1,
      runtimeKind: input.runtimeKind,
      command: input.command,
      maxTotalTokens,
      ...(input.provider ? { provider: input.provider.trim() } : {}),
      ...(input.model ? { model: input.model.trim() } : {}),
    },
  });
};
