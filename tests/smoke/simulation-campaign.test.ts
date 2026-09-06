import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  normalizeSimulationCampaignInput,
  runSimulationCampaign,
  type CoordinationPattern,
} from "../../src/simulations/campaign.ts";

test("simulation campaigns converge with fault recovery and entropy-exact replay", { timeout: 120_000 }, async () => {
  const patterns: ReadonlyArray<CoordinationPattern> = ["collaboration", "adaptive", "fanout", "hierarchy", "pipeline"];
  for (const pattern of patterns) {
    const report = await runSimulationCampaign({
      pattern,
      agents: 12,
      maxParallel: 6,
      schedules: 6,
      injectFaults: true,
    });
    assert.equal(report.summary.converged, true, `${pattern} did not converge`);
    assert.equal(report.summary.exactReplays, 6);
    assert.equal(report.summary.faultRecoveries, 6);
    assert.equal(report.runtimeLifecycle.summary.passed, true);
    assert.equal(report.runtimeLifecycle.summary.converged, true);
    assert.equal(report.runtimeLifecycle.summary.exactReplays, 6);
    assert.equal(report.runtimeLifecycle.schedules.length, 6);
    assert.ok(report.runtimeLifecycle.invariants.every(({ passed }) => passed));
    assert.equal(report.summary.peakParallel, pattern === "collaboration" ? 3 : 6);
    assert.ok(report.schedules.every((schedule) => schedule.transitionCount > 0));
    assert.ok(report.schedules.every((schedule) =>
      /^[a-f0-9]{12}$/.test(schedule.transitionDigest)));
    assert.ok(report.summary.scheduleVariants >= 3, `${pattern} did not search enough schedules`);
    assert.ok(report.schedules.every((schedule) => schedule.replayExact));
    assert.equal(report.replayFrames.length, report.summary.receiptsPerRun);
    assert.equal(report.replayFrames[0]?.position, 1);
    assert.equal(report.replayFrames.at(-1)?.position, report.summary.receiptsPerRun);
    assert.ok(report.replayFrames.some((frame) => frame.kind === "node.spawned"));
    if (pattern === "collaboration") {
      assert.equal(report.terminalProjection?.passed, true);
      assert.equal(report.terminalProjection?.caseCount, 24);
      assert.equal(report.terminalProjection?.scheduleCount, 6);
      assert.equal(report.terminalProjection?.input.injectFaults, true);
      assert.equal(report.terminalProjection?.scheduleVariants, 6);
      assert.ok((report.terminalProjection?.injectedFaults ?? 0) > 0);
      assert.equal(report.terminalProjection?.modeledFaultCases, 17);
      assert.ok((report.terminalProjection?.prefixObservations ?? 0) > 24 * 6);
      assert.ok((report.terminalProjection?.projectionRestarts ?? 0) > 0);
      assert.equal(report.terminalProjection?.sameVersionConflicts, 24 * 6);
      assert.equal(report.terminalProjection?.exhaustiveCombinations, 528);
      assert.equal(report.terminalProjection?.exactReplays, 6);
      assert.ok(report.terminalProjection?.invariants.every((invariant) => invariant.passed));
      assert.equal(report.application?.humanEscalations, 1);
      assert.equal(report.application?.certificationBlocks, 1);
      assert.equal(report.application?.durableResumeExact, true);
      assert.equal(report.application?.graphProjectionExact, true);
      assert.equal(report.application?.replicaConvergenceExact, true);
      assert.ok(report.application?.invariants.every((invariant) => invariant.passed));
      assert.equal(report.application?.taskCount,
        report.stages.reduce((total, stage) => total + stage.tasks, 0));
      assert.ok((report.application?.taskCount ?? 0) <= 32,
        "the topology-derived plan plus emergent discussion must stay within the production task bound");
      assert.equal(report.application?.selectedSpecialists, 3);
      assert.equal(report.summary.requestedAgents, 12);
      assert.equal(report.summary.exercisedAgents, 3);
      assert.equal(report.application?.consultationTurns, 2);
      assert.equal(report.application?.consultationInvocations, 3);
      assert.equal(report.application?.consultationMaxDepth, 2);
      assert.equal(report.application?.consultationReplayExact, true);
      assert.equal(report.application?.consultationAnySelectionExact, true);
      assert.ok((report.application?.consultationTaskCount ?? 0) >= 5);
      assert.ok((report.application?.consultationEvidenceTransfers ?? 0) > 0);
      const announcementTasks = report.taskGraph?.filter((task) => task.capability === "room") ?? [];
      assert.ok(announcementTasks.length > 0);
      assert.ok(announcementTasks.every((task) =>
        task.status === "accepted"
        && task.attempt === 1
        && task.outputKey.startsWith("room_announcement_")));
      assert.equal(report.summary.graphExpansions, 5,
        "consultation, coordination, and final-answer continuations are all durable expansions");
      assert.equal(report.expansions?.length, 2);
      assert.equal(report.taskGraph?.filter((task) =>
        task.taskId.startsWith("consult_") || task.taskId.startsWith("continue_")).length,
      report.application?.consultationTaskCount);
      assert.ok(report.schedules.every((schedule) => schedule.entropyDraws > 0));
    } else {
      assert.equal(report.summary.graphExpansions, 1);
      assert.equal(report.summary.catalogSearches, 1);
      assert.equal(report.summary.catalogInvocations, 1);
      assert.equal(report.expansions?.length, 1);
      assert.equal(report.expansions?.[0]?.parentTaskId, "campaign_root");
      assert.equal(report.taskGraph?.find((task) => task.taskId === "campaign_root")?.status, "skipped");
      assert.equal(report.taskGraph?.find((task) => task.taskId === "campaign_complete")?.status, "accepted");
      const graphFrames = report.replayFrames.filter((frame) =>
        frame.kind === "task.graph.projected");
      assert.ok(graphFrames.length > 0);
      assert.ok(graphFrames.some((frame) => frame.retriedTasks === 1));
      assert.ok(report.taskGraph?.every((task) =>
        task.status === "accepted" || (task.taskId === "campaign_root" && task.status === "skipped")));
      assert.equal(report.taskGraph?.filter((task) => task.attempt === 2).length, 1);
      assert.equal(report.replayFrames.some((frame) => frame.kind.startsWith("plan.")), false);
      assert.deepEqual(report.replayFrames
        .filter((frame) => frame.kind === "function.activity.recorded")
        .map((frame) => frame.functionOperation), ["catalog.search", "function.call"]);
    }
  }
});

test("coding collaboration campaigns are reproducible from the same seed", async () => {
  const input = {
    pattern: "collaboration" as const,
    agents: 12,
    maxParallel: 6,
    schedules: 3,
    injectFaults: true,
    seed: 0xdecafbad,
  };
  const first = await runSimulationCampaign(input);
  const second = await runSimulationCampaign(input);

  assert.equal(first.campaignId, second.campaignId);
  assert.deepEqual(first.schedules, second.schedules);
  assert.deepEqual(first.stages, second.stages);
  assert.deepEqual(first.topologies, second.topologies);
  assert.deepEqual(first.application, second.application);
  assert.deepEqual(first.terminalProjection, second.terminalProjection);
  assert.deepEqual(first.replayFrames, second.replayFrames);
  assert.deepEqual(first.summary, second.summary);
});

test("adversarial Coding campaigns survive serial and saturated schedules at seed boundaries", {
  timeout: 120_000,
}, async () => {
  const cases = [
    { agents: 6, maxParallel: 1, seed: 0 },
    { agents: 6, maxParallel: 6, seed: 0xffff_ffff },
    { agents: 12, maxParallel: 1, seed: 0x8000_0000 },
    { agents: 128, maxParallel: 32, seed: 0x7fff_ffff },
  ] as const;
  for (const input of cases) {
    const report = await runSimulationCampaign({
      pattern: "collaboration",
      ...input,
      schedules: 2,
      injectFaults: true,
    });
    assert.equal(report.summary.converged, true);
    assert.equal(report.summary.exactReplays, 2);
    assert.equal(report.summary.faultRecoveries, 2);
    assert.ok(report.summary.peakParallel <= Math.min(input.maxParallel, 3));
    assert.ok(report.schedules.every((schedule) => schedule.replayExact));
    assert.equal(report.application?.humanEscalations, 1);
    assert.equal(report.terminalProjection?.passed, true);
    assert.equal(report.terminalProjection?.exactReplays, 2);
    assert.equal(report.terminalProjection?.sameVersionConflicts, 24 * 2);
    assert.equal(report.summary.requestedAgents, input.agents);
    assert.equal(report.summary.exercisedAgents, 3);
    assert.equal(report.application?.certificationBlocks, 1);
    assert.equal(report.application?.durableResumeExact, true);
    assert.equal(report.application?.graphProjectionExact, true);
    assert.equal(report.application?.replicaConvergenceExact, true);
    assert.ok(report.application?.invariants.every((invariant) => invariant.passed));
    assert.ok((report.application?.taskCount ?? 0) <= 32);
    assert.ok(report.taskGraph?.every((task) =>
      task.status === "accepted" || task.status === "skipped"));
  }
});

test("fault-free Coding campaigns do not claim injected terminal faults", async () => {
  const report = await runSimulationCampaign({
    pattern: "collaboration",
    agents: 6,
    maxParallel: 3,
    schedules: 2,
    injectFaults: false,
    seed: 91,
  });
  assert.equal(report.summary.converged, true);
  assert.equal(report.terminalProjection?.input.injectFaults, false);
  assert.equal(report.terminalProjection?.injectedFaults, 0);
  assert.equal(report.terminalProjection?.projectionRestarts, 0);
  assert.equal(report.terminalProjection?.sameVersionConflicts, 0);
  assert.equal(report.terminalProjection?.exactReplays, 2);
});

test("every displayed schedule seed reproduces that schedule directly", { timeout: 120_000 }, async () => {
  const patterns: ReadonlyArray<CoordinationPattern> = ["collaboration", "adaptive", "fanout", "hierarchy", "pipeline"];
  for (const pattern of patterns) {
    const campaign = await runSimulationCampaign({
      pattern,
      agents: 6,
      maxParallel: 3,
      schedules: 2,
      injectFaults: true,
      seed: 42,
    });
    const selected = campaign.schedules[1];
    assert.ok(selected);
    const reproduced = await runSimulationCampaign({
      pattern,
      agents: 6,
      maxParallel: 3,
      schedules: 1,
      injectFaults: true,
      seed: selected.seed,
    });
    const replayed = reproduced.schedules[0];
    assert.ok(replayed);
    assert.equal(replayed.seed, selected.seed);
    assert.equal(replayed.seedHex, selected.seedHex);
    assert.equal(replayed.completionDigest, selected.completionDigest);
    assert.equal(replayed.faultRecoveries, selected.faultRecoveries);
    assert.equal(replayed.peakParallel, selected.peakParallel);
    assert.equal(replayed.replayExact, true);
  }
});

test("adaptive simulation receipts traverse associahedra and contract redundant work", async () => {
  const report = await runSimulationCampaign({
    pattern: "adaptive",
    agents: 20,
    maxParallel: 8,
    schedules: 4,
    injectFaults: true,
  });
  assert.deepEqual(report.topologies.map((topology) => topology.operation), ["initialize", "rotate", "contract"]);
  assert.equal(report.topologies[0]?.leaves, 21);
  assert.equal(report.topologies.at(-1)?.leaves, 20);
  assert.equal(report.summary.finalActiveAgents, 20);
});

test("verification hierarchy scopes each review to its four-worker pod and pod owner", async () => {
  const report = await runSimulationCampaign({
    pattern: "hierarchy",
    agents: 10,
    maxParallel: 5,
    schedules: 1,
    injectFaults: false,
    seed: 17,
  });
  const spawnedWorkers = report.replayFrames
    .filter((frame) => frame.kind === "node.spawned")
    .map((frame) => frame.nodeId);
  assert.equal(spawnedWorkers.length, 10);

  const reviews = (report.taskGraph ?? [])
    .filter((task) => task.taskId.startsWith("review_"))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  assert.equal(reviews.length, 3);
  for (const [podIndex, review] of reviews.entries()) {
    const firstWorker = podIndex * 4;
    const workerCount = Math.min(4, 10 - firstWorker);
    const expectedDependencies = Array.from({ length: workerCount }, (_unused, offset) => {
      const workerNumber = firstWorker + offset + 1;
      return `worker_${String(workerNumber).padStart(3, "0")}`;
    });
    assert.deepEqual(review.dependencyTaskIds, expectedDependencies);
    assert.equal(review.nodeId, spawnedWorkers[firstWorker]);
  }

  const gate = report.taskGraph?.find((task) => task.taskId === "gate_001");
  assert.deepEqual(gate?.dependencyTaskIds, [
    "review_001",
    "review_002",
    "review_003",
  ]);
});

test("adaptive replan expands the bounded v3 graph before evidence closure", async () => {
  const report = await runSimulationCampaign({
    pattern: "adaptive",
    agents: 8,
    maxParallel: 4,
    schedules: 1,
    injectFaults: false,
    seed: 23,
  });
  const frames = report.replayFrames;
  const replanIndex = frames.findIndex((frame) =>
    frame.kind === "reflection.recorded"
    && frame.reflectionPolicyId === "simulation-adaptation"
    && frame.reflectionActions?.includes("replan"));
  assert.ok(replanIndex >= 0);
  assert.equal(frames[replanIndex]?.evidenceGaps, 1);

  const remediationProjectionIndex = frames.findIndex((frame, index) =>
    index > replanIndex
    && frame.kind === "task.graph.projected"
    && frame.acceptedTasks === 10);
  assert.ok(remediationProjectionIndex > replanIndex);
  assert.equal(frames.slice(replanIndex + 1, remediationProjectionIndex)
    .some((frame) => frame.kind === "reflection.recorded" && frame.evidenceGaps === 0), false);

  const evidenceClosureIndex = frames.findIndex((frame, index) =>
    index > remediationProjectionIndex
    && frame.kind === "reflection.recorded"
    && frame.evidenceGaps === 0);
  assert.ok(evidenceClosureIndex > remediationProjectionIndex);
  const remediation = report.taskGraph?.find((task) => task.taskId === "evidence_review_001");
  assert.equal(remediation?.status, "accepted");
  assert.equal(remediation?.outputKey, "simulation.adaptive.review.evidence");
  assert.deepEqual(remediation?.dependencyTaskIds, Array.from(
    { length: 8 },
    (_unused, index) => `route_${String(index + 1).padStart(3, "0")}`,
  ));
  assert.deepEqual(report.stages.map((stage) => stage.id), ["frontier", "evidence-remediation"]);
});

test("simulation campaign scales to 64 workers under a bounded frontier", { timeout: 120_000 }, async () => {
  const report = await runSimulationCampaign({
    pattern: "hierarchy",
    agents: 64,
    maxParallel: 12,
    schedules: 5,
    injectFaults: true,
  });
  assert.equal(report.summary.converged, true);
  assert.equal(report.summary.peakParallel, 12);
  assert.equal(report.summary.exactReplays, 5);
  assert.deepEqual(report.stages.map((stage) => stage.tasks), [64, 16, 1]);
});

test("maximum pipeline envelope expands and converges without exhausting data references", {
  timeout: 120_000,
}, async () => {
  const report = await runSimulationCampaign({
    pattern: "pipeline",
    agents: 128,
    maxParallel: 32,
    schedules: 1,
    injectFaults: true,
    seed: 0,
  });
  assert.equal(report.summary.converged, true);
  assert.equal(report.summary.graphExpansions, 1);
  assert.equal(report.stages.reduce((total, stage) => total + stage.tasks, 0), 279);
  assert.equal(report.expansions?.[0]?.childTaskIds.length, 279);
  assert.ok(report.taskGraph?.every((task) =>
    task.status === "accepted" || (task.taskId === "campaign_root" && task.status === "skipped")));
});

test("simulation controls are normalized as resource bounds", () => {
  assert.deepEqual(normalizeSimulationCampaignInput({
    pattern: "fanout",
    agents: 999,
    maxParallel: 999,
    schedules: 999,
    injectFaults: false,
    seed: Number.MAX_SAFE_INTEGER,
  }), {
    pattern: "fanout",
    agents: 128,
    maxParallel: 32,
    schedules: 20,
    injectFaults: false,
    seed: 0xffff_ffff,
  });
  assert.equal(normalizeSimulationCampaignInput({
    pattern: "collaboration",
    agents: 2,
  }).agents, 6);
  assert.equal(normalizeSimulationCampaignInput({
    pattern: "fanout",
    agents: 2,
  }).agents, 2);
  assert.equal(normalizeSimulationCampaignInput({ seed: -1 }).seed, 0);
});

test("simulation CLI rejects mistyped patterns and malformed numeric controls", () => {
  for (const args of [
    ["--pattern", "collabortion"],
    ["--pattern"],
    ["--agents", "many"],
    ["--pattern", "collaboration", "--agents", "2"],
    ["--agents", "2", "--parallel", "3"],
    ["--parallel", "0"],
    ["--schedules"],
    ["--seed", "4294967296"],
    ["--agents", "2", "--agents", "2"],
    ["--faults", "--faults"],
    ["--unknown"],
  ]) {
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "scripts/simulation-campaign.ts",
      ...args,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, `${args.join(" ")} should fail`);
    assert.match(result.stderr, /duplicate|must|requires|unknown/i);
  }
});
