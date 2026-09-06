import assert from "node:assert/strict";
import test from "node:test";

import {
  campaignVerificationEnvironment,
  createKernelRobustnessScenario,
  createSystemVerificationScenario,
  evaluateSystemVerification,
  runSystemVerification,
  type SystemVerificationObservation,
} from "../../src/simulations/system-verification.ts";
import type { CoordinationPattern } from "../../src/simulations/campaign.ts";
import {
  commandRuntimeVerificationEnvironment,
  codingJobVerificationEnvironment,
  createCodingJobRobustnessScenario,
  createDesktopRobustnessScenario,
  createLiveRuntimeCanaryScenario,
  createPersistenceRobustnessScenario,
  createRepositoryRobustnessScenario,
  createRuntimeRobustnessScenario,
  createWorkspaceRobustnessScenario,
  desktopSidecarVerificationEnvironment,
  liveRuntimeVerificationEnvironment,
  sharedWorkspaceVerificationEnvironment,
  spacetimePersistenceVerificationEnvironment,
  gitRepositoryVerificationEnvironment,
} from "../../src/simulations/production-boundary-verification.ts";

const patterns: ReadonlyArray<CoordinationPattern> = [
  "collaboration",
  "adaptive",
  "fanout",
  "hierarchy",
  "pipeline",
];

test("system verification runs every coordination pattern through the v5 platform kernel", {
  timeout: 120_000,
}, async () => {
  for (const pattern of patterns) {
    const scenario = createKernelRobustnessScenario({
      pattern,
      workerNodes: 8,
      maxParallel: 4,
      schedules: 2,
      seed: 42,
    });
    const evidence = await runSystemVerification(scenario, campaignVerificationEnvironment);
    assert.equal(evidence.passed, true, `${pattern} failed system verification`);
    assert.equal(evidence.observation.environmentId, "roster-platform-kernel");
    assert.equal(evidence.invariants.length, scenario.requiredInvariants.length);
    assert.ok(evidence.invariants.every((invariant) => invariant.passed));
    assert.match(evidence.evidenceId, /^verification_[a-f0-9]{24}$/);
    assert.deepEqual(evidence.observation.exercisedFaultIds, ["recover-task-boundary"]);
  }
});

test("system verification rejects unsupported and silently unexercised faults", async () => {
  const unsupported = createSystemVerificationScenario({
    id: "kernel-sidecar-restart",
    name: "Unsupported sidecar restart",
    pattern: "fanout",
    workerNodes: 4,
    maxParallel: 2,
    schedules: 1,
    seed: 17,
    faults: [{
      id: "restart-sidecar",
      kind: "sidecar-restart",
      maxOccurrences: 1,
    }],
  });
  await assert.rejects(
    runSystemVerification(unsupported, campaignVerificationEnvironment),
    /does not support faults: sidecar-restart/,
  );

  const scenario = createKernelRobustnessScenario({
    pattern: "fanout",
    workerNodes: 4,
    maxParallel: 2,
    schedules: 1,
    seed: 17,
  });
  const observation = await campaignVerificationEnvironment.execute(scenario);
  const evidence = evaluateSystemVerification(scenario, {
    ...observation,
    exercisedFaultIds: [],
  });
  assert.equal(evidence.passed, false);
  assert.equal(
    evidence.invariants.find((invariant) => invariant.id === "fault-plan-exercised")?.passed,
    false,
  );
});

test("system verification cannot disable mandatory robustness invariants", () => {
  const scenario = createSystemVerificationScenario({
    id: "mandatory-invariants",
    name: "Mandatory invariants",
    pattern: "fanout",
    workerNodes: 2,
    maxParallel: 1,
    schedules: 1,
    seed: 1,
    requiredInvariants: [],
  });
  assert.deepEqual(scenario.requiredInvariants, [
    "application-acceptance",
    "bounded-node-population",
    "bounded-parallelism",
    "durable-receipt-trace",
    "exact-replay",
    "fault-plan-exercised",
    "fault-recovery",
    "semantic-convergence",
  ]);
});

test("independent verification invariants detect mutated production evidence", async () => {
  const scenario = createKernelRobustnessScenario({
    pattern: "collaboration",
    workerNodes: 8,
    maxParallel: 4,
    schedules: 2,
    seed: 99,
  });
  const baseline = await campaignVerificationEnvironment.execute(scenario);
  const mutations: ReadonlyArray<{
    readonly invariant: string;
    readonly apply: (observation: SystemVerificationObservation) => SystemVerificationObservation;
  }> = [
    {
      invariant: "semantic-convergence",
      apply: (observation) => ({ ...observation, converged: false }),
    },
    {
      invariant: "exact-replay",
      apply: (observation) => ({ ...observation, exactReplays: 0 }),
    },
    {
      invariant: "bounded-parallelism",
      apply: (observation) => ({
        ...observation,
        peakParallel: scenario.limits.maxParallel + 1,
      }),
    },
    {
      invariant: "bounded-node-population",
      apply: (observation) => ({
        ...observation,
        peakNodes: scenario.limits.maxNodes + 1,
      }),
    },
    {
      invariant: "durable-receipt-trace",
      apply: (observation) => ({ ...observation, receiptsPerRun: 0 }),
    },
    {
      invariant: "fault-recovery",
      apply: (observation) => ({ ...observation, recoveredFaults: 0 }),
    },
    {
      invariant: "application-acceptance",
      apply: (observation) => ({
        ...observation,
        failedApplicationInvariants: ["stale-frontier-accepted"],
      }),
    },
  ];

  for (const mutation of mutations) {
    const evidence = evaluateSystemVerification(scenario, mutation.apply(baseline));
    assert.equal(evidence.passed, false, `${mutation.invariant} mutation escaped verification`);
    assert.equal(
      evidence.invariants.find((invariant) => invariant.id === mutation.invariant)?.passed,
      false,
    );
  }
});

test("system verification evidence is reproducible from the same scenario", async () => {
  const scenario = createKernelRobustnessScenario({
    pattern: "hierarchy",
    workerNodes: 6,
    maxParallel: 3,
    schedules: 2,
    seed: 0xdecafbad,
  });
  const first = await runSystemVerification(scenario, campaignVerificationEnvironment);
  const second = await runSystemVerification(scenario, campaignVerificationEnvironment);
  assert.deepEqual(first, second);
});

test("runtime boundary verification crashes, rebinds, and contains a real child process", {
  timeout: 20_000,
}, async () => {
  const evidence = await runSystemVerification(
    createRuntimeRobustnessScenario(),
    commandRuntimeVerificationEnvironment,
  );
  assert.equal(evidence.passed, true);
  assert.deepEqual(evidence.observation.exercisedFaultIds, [
    "cancel-hanging-runtime",
    "crash-before-result",
  ]);
  assert.deepEqual(evidence.observation.runtime?.bindingEpochs, [1, 2, 3]);
  assert.equal(evidence.observation.runtime?.nodeIdentityStable, true);
  assert.equal(evidence.observation.runtime?.envelopeContractValid, true);
  assert.equal(evidence.observation.runtime?.cancellationContained, true);
});

test("shared workspace boundary converges reorder and duplicate delivery while preserving conflict", () => {
  return runSystemVerification(
    createWorkspaceRobustnessScenario(),
    sharedWorkspaceVerificationEnvironment,
  ).then((evidence) => {
    assert.equal(evidence.passed, true);
    assert.equal(evidence.observation.workspace?.deliveryConverged, true);
    assert.equal(evidence.observation.workspace?.duplicateDeliveryStable, true);
    assert.equal(evidence.observation.workspace?.exclusiveConflictCount, 1);
  });
});

test("independent boundary invariants detect mutated runtime and workspace evidence", async () => {
  const runtimeScenario = createRuntimeRobustnessScenario();
  const runtime = await commandRuntimeVerificationEnvironment.execute(runtimeScenario);
  for (const mutation of [
    { ...runtime, runtime: { ...runtime.runtime!, nodeIdentityStable: false } },
    { ...runtime, runtime: { ...runtime.runtime!, bindingEpochs: [2, 1] } },
    { ...runtime, runtime: { ...runtime.runtime!, envelopeContractValid: false } },
    { ...runtime, runtime: { ...runtime.runtime!, cancellationContained: false } },
  ]) {
    assert.equal(evaluateSystemVerification(runtimeScenario, mutation).passed, false);
  }

  const workspaceScenario = createWorkspaceRobustnessScenario();
  const workspace = await sharedWorkspaceVerificationEnvironment.execute(workspaceScenario);
  for (const mutation of [
    { ...workspace, workspace: { ...workspace.workspace!, deliveryConverged: false } },
    { ...workspace, workspace: { ...workspace.workspace!, duplicateDeliveryStable: false } },
    { ...workspace, workspace: { ...workspace.workspace!, exclusiveConflictCount: 0 } },
  ]) {
    assert.equal(evaluateSystemVerification(workspaceScenario, mutation).passed, false);
  }
});

test("SpacetimeDB boundary recovers the dynamic DAG, values, and shared agent context", {
  timeout: 30_000,
  skip: !process.env.SPACETIMEDB_URI || !process.env.SPACETIMEDB_DATABASE,
}, async () => {
  const scenario = createPersistenceRobustnessScenario();
  const evidence = await runSystemVerification(
    scenario,
    spacetimePersistenceVerificationEnvironment,
  );
  assert.equal(evidence.passed, true);
  assert.equal(evidence.observation.persistence?.reconnected, true);
  assert.equal(evidence.observation.persistence?.graphRecovered, true);
  assert.equal(evidence.observation.persistence?.valuesRecovered, true);
  assert.equal(evidence.observation.persistence?.workspaceRecovered, true);
  assert.equal(evidence.observation.persistence?.staleFenceRejected, true);
  assert.equal(evidence.observation.persistence?.exactReducerReplay, true);

  const mutation = evaluateSystemVerification(scenario, {
    ...evidence.observation,
    persistence: {
      ...evidence.observation.persistence!,
      staleFenceRejected: false,
    },
  });
  assert.equal(mutation.passed, false);
});

test("desktop sidecar restarts through its production entry and preserves private identity", {
  timeout: 60_000,
  skip: !process.env.SPACETIMEDB_URI || !process.env.SPACETIMEDB_DATABASE,
}, async () => {
  const scenario = createDesktopRobustnessScenario();
  const evidence = await runSystemVerification(
    scenario,
    desktopSidecarVerificationEnvironment,
  );
  assert.equal(evidence.passed, true);
  assert.equal(evidence.observation.desktop?.initialBootReady, true);
  assert.equal(evidence.observation.desktop?.restartReady, true);
  assert.equal(evidence.observation.desktop?.identityPreserved, true);
  assert.equal(evidence.observation.desktop?.priorProcessContained, true);

  const mutation = evaluateSystemVerification(scenario, {
    ...evidence.observation,
    desktop: {
      ...evidence.observation.desktop!,
      identityPreserved: false,
    },
  });
  assert.equal(mutation.passed, false);
});

test("live runtime canary crosses the CLI protocol and independently enforces usage bounds", {
  timeout: 20_000,
}, async () => {
  const output = {
    schemaVersion: "roster.live-runtime-canary.v1",
    status: "ok",
    nodeId: "verification.live-runtime.worker",
    nonce: "canary-11cecafe",
  };
  const protocolEvents = [
    { type: "thread.started", thread_id: "canary-protocol-fixture" },
    {
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(output) },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 },
    },
  ].map((event) => JSON.stringify(event)).join("\n");
  const scenario = createLiveRuntimeCanaryScenario({
    runtimeKind: "codex-cli",
    command: [
      process.execPath,
      "-e",
      `process.stdout.write(${JSON.stringify(`${protocolEvents}\n`)})`,
    ],
    maxTotalTokens: 500,
  });
  const evidence = await runSystemVerification(
    scenario,
    liveRuntimeVerificationEnvironment,
  );
  assert.equal(evidence.passed, true);
  assert.equal(evidence.observation.liveRuntime?.ready, true);
  assert.equal(evidence.observation.liveRuntime?.responseContractValid, true);
  assert.equal(evidence.observation.liveRuntime?.nodeIdentityStable, true);
  assert.equal(evidence.observation.liveRuntime?.usageReported, true);
  assert.equal(evidence.observation.liveRuntime?.totalTokens, 120);
  assert.equal(evidence.observation.liveRuntime?.withinLimits, true);

  const mutation = evaluateSystemVerification(scenario, {
    ...evidence.observation,
    liveRuntime: {
      ...evidence.observation.liveRuntime!,
      withinLimits: false,
    },
  });
  assert.equal(mutation.passed, false);
});

test("Hermes live runtime canary normalizes exported session usage", {
  timeout: 20_000,
}, async () => {
  const output = {
    schemaVersion: "roster.live-runtime-canary.v1",
    status: "ok",
    nodeId: "verification.live-runtime.worker",
    nonce: "canary-11cecafe",
  };
  const script = [
    "const args = process.argv.slice(1);",
    "if (args.includes('sessions')) {",
    `  process.stdout.write(${JSON.stringify(`${JSON.stringify({
      id: "hermes-canary-session",
      input_tokens: 80,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      output_tokens: 25,
      reasoning_tokens: 4,
      actual_cost_usd: 0.02,
      messages: [],
    })}\n`)});`,
    "} else {",
    `  process.stdout.write(${JSON.stringify(`${JSON.stringify(output)}\nsession_id: hermes-canary-session\n`)});`,
    "}",
  ].join("\n");
  const scenario = createLiveRuntimeCanaryScenario({
    runtimeKind: "hermes-agent",
    command: [process.execPath, "-e", script, "--"],
    maxTotalTokens: 500,
  });
  const evidence = await runSystemVerification(
    scenario,
    liveRuntimeVerificationEnvironment,
  );

  assert.equal(evidence.passed, true);
  assert.equal(evidence.observation.liveRuntime?.runtimeKind, "hermes-agent");
  assert.equal(evidence.observation.liveRuntime?.usageReported, true);
  assert.equal(evidence.observation.liveRuntime?.totalTokens, 120);
  assert.equal(evidence.observation.liveRuntime?.withinLimits, true);
});

test("Git boundary recovers an uncommitted worktree and rejects a moved target frontier", {
  timeout: 30_000,
}, async () => {
  const scenario = createRepositoryRobustnessScenario();
  const evidence = await runSystemVerification(
    scenario,
    gitRepositoryVerificationEnvironment,
  );
  assert.equal(evidence.passed, true);
  assert.equal(evidence.observation.repository?.workspaceRecovered, true);
  assert.equal(evidence.observation.repository?.staleFrontierRejected, true);
  assert.equal(evidence.observation.repository?.cleanupContained, true);
  assert.equal(evidence.observation.repository?.patchRetained, true);

  const mutation = evaluateSystemVerification(scenario, {
    ...evidence.observation,
    repository: {
      ...evidence.observation.repository!,
      staleFrontierRejected: false,
    },
  });
  assert.equal(mutation.passed, false);
});

test("Coding boundary composes admission, durable execution, policy, profile, and validation faults", {
  timeout: 30_000,
}, async () => {
  const scenario = createCodingJobRobustnessScenario();
  const evidence = await runSystemVerification(
    scenario,
    codingJobVerificationEnvironment,
  );
  assert.equal(evidence.passed, true);
  assert.equal(evidence.observation.coding?.preExecutionRetryAllowed, true);
  assert.equal(evidence.observation.coding?.partialExecutionResumed, true);
  assert.deepEqual(evidence.observation.coding?.modelExecutionCounts, [1, 1]);
  assert.equal(evidence.observation.coding?.interruptedWorkspaceCleaned, true);
  assert.equal(evidence.observation.coding?.interruptedPatchRetained, true);
  assert.equal(evidence.observation.coding?.reviewerPolicyIsolated, true);
  assert.equal(evidence.observation.coding?.executionProfilePreserved, true);
  assert.equal(evidence.observation.coding?.validationFailureDetailed, true);
  assert.equal(evidence.observation.coding?.validationEnvironmentIsolated, true);
  assert.deepEqual(evidence.observation.exercisedFaultIds, [
    "mutate-accepted-execution-profile",
    "omit-validation-environment-selector",
    "override-worker-model-policy",
    "restart-after-orchestration-started",
    "restart-while-waiting-for-repository",
  ]);
});

test("Coding boundary invariants reject every corrupted UAT evidence class", {
  timeout: 30_000,
}, async () => {
  const scenario = createCodingJobRobustnessScenario();
  const baseline = await codingJobVerificationEnvironment.execute(scenario);
  const mutations: ReadonlyArray<{
    readonly invariant: string;
    readonly coding: NonNullable<SystemVerificationObservation["coding"]>;
  }> = [
    {
      invariant: "coding-preexecution-retry",
      coding: { ...baseline.coding!, preExecutionRetryAllowed: false },
    },
    {
      invariant: "coding-partial-execution-resumed",
      coding: { ...baseline.coding!, partialExecutionResumed: false },
    },
    {
      invariant: "coding-duplicate-execution-prevented",
      coding: { ...baseline.coding!, modelExecutionCounts: [1, 2] },
    },
    {
      invariant: "coding-interrupted-workspace-contained",
      coding: { ...baseline.coding!, interruptedPatchRetained: false },
    },
    {
      invariant: "coding-review-policy-isolated",
      coding: { ...baseline.coding!, reviewerPolicyIsolated: false },
    },
    {
      invariant: "coding-execution-profile-preserved",
      coding: { ...baseline.coding!, executionProfilePreserved: false },
    },
    {
      invariant: "coding-validation-diagnostics-preserved",
      coding: { ...baseline.coding!, validationFailureDetailed: false },
    },
    {
      invariant: "coding-validation-environment-isolated",
      coding: { ...baseline.coding!, validationEnvironmentIsolated: false },
    },
  ];
  for (const mutation of mutations) {
    const result = evaluateSystemVerification(scenario, {
      ...baseline,
      coding: mutation.coding,
    });
    assert.equal(result.passed, false, `${mutation.invariant} mutation escaped verification`);
    assert.equal(
      result.invariants.find((invariant) => invariant.id === mutation.invariant)?.passed,
      false,
    );
  }
});
