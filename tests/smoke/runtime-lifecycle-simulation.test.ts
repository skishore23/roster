import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_LIFECYCLE_SIMULATION_FAULT_IDS,
  evaluateRuntimeLifecycleSimulation,
  normalizeRuntimeLifecycleSimulationInput,
  runRuntimeLifecycleSimulation,
  type RuntimeLifecycleInvariantId,
  type RuntimeLifecycleScheduleObservation,
  type RuntimeLifecycleScheduleReport,
} from "../../src/simulations/runtime-lifecycle.ts";

test("runtime lifecycle simulator searches schedules, recovers every fault, and replays exactly", async () => {
  const report = await runRuntimeLifecycleSimulation({
    schedules: 6,
    injectFaults: true,
    seed: 42,
  });

  assert.equal(report.summary.passed, true);
  assert.equal(report.summary.converged, true);
  assert.equal(report.summary.exactReplays, 6);
  assert.ok(report.summary.scheduleVariants >= 2);
  assert.equal(
    report.summary.faultRecoveries,
    RUNTIME_LIFECYCLE_SIMULATION_FAULT_IDS.length * 6,
  );
  assert.ok(report.schedules.every(({ replayExact }) => replayExact));
  for (const { observation } of report.schedules) {
    assert.deepEqual(observation.exercisedFaultIds, RUNTIME_LIFECYCLE_SIMULATION_FAULT_IDS);
  }
  assert.ok(report.invariants.every(({ passed }) => passed));
  assert.match(report.simulationId, /^runtime_lifecycle_simulation_[a-f0-9]{24}$/u);
  assert.ok(report.representativeTrace.some((event) => event.startsWith("provider-dispose:")));
  assert.ok(report.representativeTrace.some((event) => event.startsWith("extension-dispose:")));
});

test("runtime lifecycle simulation is reproducible and its no-fault schedule remains valid", async () => {
  const input = { schedules: 3, injectFaults: true, seed: 0xdecafbad };
  const first = await runRuntimeLifecycleSimulation(input);
  const second = await runRuntimeLifecycleSimulation(input);
  assert.deepEqual(second, first);

  const noFaults = await runRuntimeLifecycleSimulation({
    schedules: 2,
    injectFaults: false,
    seed: 17,
  });
  assert.equal(noFaults.summary.passed, true);
  assert.equal(noFaults.summary.faultRecoveries, 0);
  assert.ok(noFaults.schedules.every(({ observation }) =>
    observation.exercisedFaultIds.length === 0));
});

test("runtime lifecycle invariant evaluation independently detects mutated evidence", async () => {
  const report = await runRuntimeLifecycleSimulation({
    schedules: 2,
    injectFaults: true,
    seed: 99,
  });
  const mutations: ReadonlyArray<{
    readonly invariant: RuntimeLifecycleInvariantId;
    readonly mutate: (
      observation: RuntimeLifecycleScheduleObservation,
    ) => RuntimeLifecycleScheduleObservation;
  }> = [
    { invariant: "effect-ownership-exact", mutate: (value) => ({ ...value, effectOwnershipExact: false }) },
    { invariant: "activation-transactional", mutate: (value) => ({ ...value, activationTransactional: false }) },
    { invariant: "provider-generation-atomic", mutate: (value) => ({ ...value, providerGenerationAtomic: false }) },
    { invariant: "provider-drain-contained", mutate: (value) => ({ ...value, providerDrainContained: false }) },
    { invariant: "runtime-binding-monotonic", mutate: (value) => ({ ...value, runtimeBindingMonotonic: false }) },
    { invariant: "extension-reconciliation-atomic", mutate: (value) => ({ ...value, extensionReconciliationAtomic: false }) },
    { invariant: "service-authority-attenuated", mutate: (value) => ({ ...value, serviceAuthorityAttenuated: false }) },
    { invariant: "reload-failure-contained", mutate: (value) => ({ ...value, reloadFailureContained: false }) },
    { invariant: "emission-retry-safe", mutate: (value) => ({ ...value, emissionRetrySafe: false }) },
    { invariant: "rollout-governed", mutate: (value) => ({ ...value, rolloutGoverned: false }) },
    { invariant: "self-improvement-governed", mutate: (value) => ({ ...value, selfImprovementGoverned: false }) },
    { invariant: "fault-plan-exercised", mutate: (value) => ({ ...value, exercisedFaultIds: [] }) },
    { invariant: "bounded-lifecycle", mutate: (value) => ({ ...value, peakEffects: 4 }) },
    { invariant: "semantic-convergence", mutate: (value) => ({ ...value, semanticDigest: "mutated" }) },
  ];
  const first = report.schedules[0]!;
  for (const mutation of mutations) {
    const schedules: RuntimeLifecycleScheduleReport[] = [
      { ...first, observation: mutation.mutate(first.observation) },
      ...report.schedules.slice(1),
    ];
    const invariants = evaluateRuntimeLifecycleSimulation({
      simulationInput: report.input,
      schedules,
    });
    assert.equal(
      invariants.find(({ id }) => id === mutation.invariant)?.passed,
      false,
      `${mutation.invariant} did not detect mutated evidence`,
    );
  }

  const replayMutation: RuntimeLifecycleScheduleReport[] = [
    { ...first, replayExact: false },
    ...report.schedules.slice(1),
  ];
  assert.equal(evaluateRuntimeLifecycleSimulation({
    simulationInput: report.input,
    schedules: replayMutation,
  }).find(({ id }) => id === "exact-replay")?.passed, false);
});

test("runtime lifecycle simulation inputs remain bounded", () => {
  assert.deepEqual(normalizeRuntimeLifecycleSimulationInput({
    schedules: 999,
    injectFaults: false,
    seed: Number.MAX_SAFE_INTEGER,
  }), {
    schedules: 20,
    injectFaults: false,
    seed: 0xffff_ffff,
  });
  assert.equal(normalizeRuntimeLifecycleSimulationInput({ schedules: 0 }).schedules, 1);
});
