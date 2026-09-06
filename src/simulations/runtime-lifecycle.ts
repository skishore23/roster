import {
  RecordingEntropySource,
  ReplayingEntropySource,
  type EntropySource,
} from "determined";

import { hashCanonical } from "../core/canonical.js";
import {
  RosterFunctionDirectory,
  type RosterFunctionDescriptor,
} from "../engine/functions/function-directory.js";
import { RuntimeBindingEpochLifecycleManager } from "../engine/runtime/runtime-binding-lifecycle.js";
import {
  RuntimeEffectCleanupError,
  RuntimeEffectScope,
  activateRuntimeComponent,
} from "../engine/runtime/runtime-effect-scope.js";
import {
  NODE_EXECUTION_SCHEMA_VERSION,
  NodeRuntimeRegistry,
  type NodeRuntimeAdapter,
} from "../engine/runtime/node-runtime.js";
import {
  assertRuntimeEmissionRetryAllowed,
  createRuntimeCompensationEvidence,
  createRuntimeEmissionClassification,
  createRuntimeEmissionIntent,
  validateRuntimeCompensationEvidence,
} from "../engine/runtime/runtime-emission.js";
import {
  defineRuntimeService,
  type RuntimeExtensionDefinition,
} from "../engine/runtime/runtime-extension.js";
import { RuntimeExtensionHost } from "../engine/runtime/runtime-extension-host.js";
import {
  RuntimeExtensionReloadAdapter,
  type RuntimeExtensionReloadScheduler,
} from "../engine/runtime/runtime-extension-reload.js";
import {
  createRuntimeExtensionRolloutProposal,
  projectRuntimeExtensionRollout,
  promoteRuntimeExtensionRollout,
  recordRuntimeExtensionCanary,
  rollbackRuntimeExtensionRolloutForward,
  verifyRuntimeExtensionRollout,
  warmRuntimeExtensionRollout,
  type RuntimeExtensionCanaryEvidence,
  type RuntimeExtensionRolloutRecord,
} from "../engine/runtime/runtime-extension-rollout.js";

export const RUNTIME_LIFECYCLE_SIMULATION_VERSION =
  "roster.runtime-lifecycle-simulation.v1" as const;

export type RuntimeLifecycleSimulationInput = {
  readonly schedules: number;
  readonly injectFaults: boolean;
  readonly seed: number;
};

export type RuntimeLifecycleInvariantId =
  | "effect-ownership-exact"
  | "activation-transactional"
  | "provider-generation-atomic"
  | "provider-drain-contained"
  | "runtime-binding-monotonic"
  | "extension-reconciliation-atomic"
  | "service-authority-attenuated"
  | "reload-failure-contained"
  | "emission-retry-safe"
  | "rollout-governed"
  | "self-improvement-governed"
  | "fault-plan-exercised"
  | "bounded-lifecycle"
  | "semantic-convergence"
  | "exact-replay";

export type RuntimeLifecycleInvariantResult = {
  readonly id: RuntimeLifecycleInvariantId;
  readonly label: string;
  readonly passed: boolean;
  readonly evidence: string;
};

export type RuntimeLifecycleScheduleObservation = {
  readonly effectOwnershipExact: boolean;
  readonly activationTransactional: boolean;
  readonly providerGenerationAtomic: boolean;
  readonly providerDrainContained: boolean;
  readonly runtimeBindingMonotonic: boolean;
  readonly extensionReconciliationAtomic: boolean;
  readonly serviceAuthorityAttenuated: boolean;
  readonly reloadFailureContained: boolean;
  readonly emissionRetrySafe: boolean;
  readonly rolloutGoverned: boolean;
  readonly selfImprovementGoverned: boolean;
  readonly peakEffects: number;
  readonly peakProviderLeases: number;
  readonly peakBindingLeases: number;
  readonly exercisedFaultIds: ReadonlyArray<string>;
  readonly semanticDigest: string;
};

export type RuntimeLifecycleScheduleReport = {
  readonly seed: number;
  readonly seedHex: string;
  readonly entropyDraws: number;
  readonly replayExact: boolean;
  readonly transitionCount: number;
  readonly transitionDigest: string;
  readonly observation: RuntimeLifecycleScheduleObservation;
};

export type RuntimeLifecycleSimulationReport = {
  readonly schemaVersion: typeof RUNTIME_LIFECYCLE_SIMULATION_VERSION;
  readonly simulationId: string;
  readonly input: RuntimeLifecycleSimulationInput;
  readonly schedules: ReadonlyArray<RuntimeLifecycleScheduleReport>;
  readonly representativeTrace: ReadonlyArray<string>;
  readonly invariants: ReadonlyArray<RuntimeLifecycleInvariantResult>;
  readonly summary: {
    readonly passed: boolean;
    readonly converged: boolean;
    readonly exactReplays: number;
    readonly scheduleVariants: number;
    readonly faultRecoveries: number;
    readonly peakEffects: number;
    readonly peakProviderLeases: number;
    readonly peakBindingLeases: number;
  };
};

export const RUNTIME_LIFECYCLE_SIMULATION_FAULT_IDS = Object.freeze([
  "activation-failure",
  "binding-drain-timeout",
  "binding-publish-failure",
  "effect-bound",
  "effect-cleanup-failure",
  "emission-retry-rejected",
  "extension-activation-failure",
  "extension-cycle-rejected",
  "provider-cleanup-failure",
  "provider-drain-timeout",
  "provider-generation-rejected",
  "reload-activation-failure",
  "rollout-authority-rejected",
  "self-improvement-self-verification-rejected",
] as const);

const LIFECYCLE_FUNCTION: RosterFunctionDescriptor = {
  id: "simulation::lifecycle.inspect",
  version: "1",
  capability: "inspect",
  description: "Inspect one simulated runtime lifecycle generation.",
  inputSchema: {
    type: "object",
    properties: { callId: { type: "string" } },
    required: ["callId"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { epoch: { type: "integer" } },
    required: ["epoch"],
    additionalProperties: false,
  },
  effects: ["read"],
};

const LIFECYCLE_NODE = Object.freeze({
  id: "lifecycle-simulation-node",
  name: "Lifecycle Simulation Node",
  capabilities: ["inspect"],
  runtime: { kind: "roster-native" as const },
});

const DATABASE = defineRuntimeService<{ readonly query: () => string }>(
  "simulation.database",
  "1",
);
const REPOSITORY = defineRuntimeService<{ readonly read: () => string }>(
  "simulation.repository",
  "1",
);

class SeededEntropySource implements EntropySource {
  #state: number;

  constructor(seed: number) {
    const mixed = (Math.imul(seed >>> 0, 0x85ebca6b) + 0x9e3779b9) >>> 0;
    this.#state = mixed || 0x6d2b79f5;
  }

  random(_reason: string): number {
    let value = this.#state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.#state = value >>> 0;
    return this.#state / 0x1_0000_0000;
  }
}

class ManualReloadScheduler implements RuntimeExtensionReloadScheduler {
  readonly #callbacks = new Map<number, () => void>();
  #sequence = 0;

  setTimeout(callback: () => void, _delayMs: number): unknown {
    this.#sequence += 1;
    this.#callbacks.set(this.#sequence, callback);
    return this.#sequence;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#callbacks.delete(handle);
  }

  flush(): void {
    const callbacks = [...this.#callbacks.entries()]
      .sort(([left], [right]) => left - right);
    this.#callbacks.clear();
    for (const [, callback] of callbacks) callback();
  }
}

type ScenarioResult = {
  readonly trace: ReadonlyArray<string>;
  readonly observation: RuntimeLifecycleScheduleObservation;
};

const clampInteger = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? Math.floor(value) : minimum));

export const normalizeRuntimeLifecycleSimulationInput = (
  input: Partial<RuntimeLifecycleSimulationInput>,
): RuntimeLifecycleSimulationInput => Object.freeze({
  schedules: clampInteger(input.schedules ?? 6, 1, 20),
  injectFaults: input.injectFaults ?? true,
  seed: clampInteger(input.seed ?? 0xc0d15, 0, 0xffff_ffff),
});

const shuffle = <Value>(
  values: ReadonlyArray<Value>,
  entropy: EntropySource,
  reason: string,
): Value[] => {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(entropy.random(`${reason}:${index}`) * (index + 1));
    [shuffled[index], shuffled[selected]] = [shuffled[selected]!, shuffled[index]!];
  }
  return shuffled;
};

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Runtime lifecycle simulation timed out waiting for ${label}`);
};

const completedEpoch = (value: unknown): number | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const epoch = (value as { readonly epoch?: unknown }).epoch;
  return Number.isSafeInteger(epoch) ? epoch as number : undefined;
};

const faultRecorder = (enabled: boolean, trace: string[]) => {
  const faults = new Set<string>();
  return {
    record: (faultId: string): void => {
      if (!enabled) return;
      faults.add(faultId);
      trace.push(`fault-recovered:${faultId}`);
    },
    ids: (): ReadonlyArray<string> => Object.freeze([...faults].sort()),
  };
};

const databaseExtension = (
  version: string,
  value: string,
  trace: string[],
): RuntimeExtensionDefinition => ({
  id: "database",
  version,
  artifactHash: `sha256:database-${version}`,
  provides: [DATABASE],
  activate: ({ provide, scope }) => {
    trace.push(`extension-activate:database:${version}`);
    provide(DATABASE, { query: () => value });
    scope.defer(() => { trace.push(`extension-dispose:database:${version}`); });
  },
});

const repositoryExtension = (trace: string[]): RuntimeExtensionDefinition => ({
  id: "repository",
  version: "1",
  requires: [DATABASE],
  provides: [REPOSITORY],
  activate: ({ get, provide, scope }) => {
    trace.push("extension-activate:repository");
    const database = get(DATABASE);
    provide(REPOSITORY, { read: () => `repo:${database.query()}` });
    scope.defer(() => { trace.push("extension-dispose:repository"); });
  },
});

const runScenario = async (input: {
  readonly entropy: EntropySource;
  readonly injectFaults: boolean;
}): Promise<ScenarioResult> => {
  const trace: string[] = [];
  const faults = faultRecorder(input.injectFaults, trace);

  const effectRegistration = shuffle(["alpha", "beta", "gamma"], input.entropy, "effect-order");
  const effectCleanup: string[] = [];
  const effectScope = new RuntimeEffectScope({
    owner: { kind: "activation", activationId: "simulation-effects" },
    limits: { maxDisposers: 3, cleanupTimeoutMs: 1_000 },
  });
  for (const effect of effectRegistration) {
    effectScope.defer(() => {
      effectCleanup.push(effect);
      trace.push(`effect-close:${effect}`);
      if (input.injectFaults && effect === "beta") throw new Error("simulated cleanup failure");
    }, effect);
  }
  try {
    await effectScope.close();
  } catch (error) {
    if (!(error instanceof RuntimeEffectCleanupError)) throw error;
    faults.record("effect-cleanup-failure");
  }
  const directEffectOwnershipExact = hashCanonical(effectCleanup)
    === hashCanonical([...effectRegistration].reverse());
  const attemptEvents: string[] = [];
  let effectAuthorityStayedPrivate = false;
  const lifecycleAdapter: NodeRuntimeAdapter = {
    kind: "simulation-lifecycle-runtime",
    executeEnvelope: async (envelope, control) => {
      effectAuthorityStayedPrivate = !("effects" in envelope);
      control.effects.defer(() => { attemptEvents.push("attempt-close:first"); });
      control.effects.defer(() => { attemptEvents.push("attempt-close:second"); });
      attemptEvents.push("attempt-execute");
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "simulation-output",
      };
    },
  };
  const attemptOutput = await new NodeRuntimeRegistry([lifecycleAdapter]).execute({
    runId: "lifecycle-simulation-run",
    node: {
      ...LIFECYCLE_NODE,
      runtime: { kind: lifecycleAdapter.kind },
    },
    task: {
      taskId: "lifecycle-simulation-task",
      nodeId: LIFECYCLE_NODE.id,
      capability: "inspect",
    },
    execute: async () => "native-output",
  });
  trace.push(...attemptEvents);
  const effectOwnershipExact = directEffectOwnershipExact
    && effectAuthorityStayedPrivate
    && attemptOutput === "simulation-output"
    && hashCanonical(attemptEvents) === hashCanonical([
      "attempt-execute",
      "attempt-close:second",
      "attempt-close:first",
    ]);

  if (input.injectFaults) {
    const bounded = new RuntimeEffectScope({
      owner: { kind: "process", processId: "simulation-bound" },
      limits: { maxDisposers: 1 },
    });
    bounded.defer(() => undefined);
    try {
      bounded.defer(() => undefined);
      throw new Error("Runtime lifecycle simulator did not enforce the effect bound");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("maxDisposers")) throw error;
      faults.record("effect-bound");
    }
    await bounded.close();
  }

  let partialActivationClosed = 0;
  if (input.injectFaults) {
    try {
      await activateRuntimeComponent({
        owner: { kind: "activation", activationId: "simulation-partial" },
        activate: (scope) => {
          scope.defer(() => { partialActivationClosed += 1; });
          throw new Error("simulated activation failure");
        },
      });
      throw new Error("Runtime lifecycle simulator accepted a failed activation");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("simulated activation failure")) throw error;
      faults.record("activation-failure");
    }
  } else {
    const activated = await activateRuntimeComponent({
      owner: { kind: "activation", activationId: "simulation-success" },
      activate: (scope) => {
        scope.defer(() => { partialActivationClosed += 1; });
        return "active";
      },
    });
    await activated.close();
  }
  const activationTransactional = partialActivationClosed === 1;

  const directory = new RosterFunctionDirectory([LIFECYCLE_FUNCTION]);
  if (input.injectFaults) {
    try {
      directory.bindProviderGeneration({
        generationId: "invalid-simulation-generation",
        providers: [{
          providerId: "invalid-provider",
          functionId: "simulation::missing",
          epoch: 1,
          invoke: async () => ({}),
        }],
      });
      throw new Error("Runtime lifecycle simulator published an invalid provider generation");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("undeclared function")) throw error;
      faults.record("provider-generation-rejected");
    }
  }

  const providerResolvers = new Map<string, () => void>();
  let oldDisposed = false;
  const oldProvider = directory.bindProviderGeneration({
    generationId: "simulation-provider-v1",
    providers: [{
      providerId: "simulation-provider",
      functionId: LIFECYCLE_FUNCTION.id,
      epoch: 1,
      invoke: async (value) => {
        const callId = (value as { readonly callId: string }).callId;
        await new Promise<void>((resolve) => { providerResolvers.set(callId, resolve); });
        trace.push(`provider-complete:${callId}:1`);
        return { epoch: 1 };
      },
    }],
    dispose: () => {
      oldDisposed = true;
      trace.push("provider-dispose:1");
      if (input.injectFaults) throw new Error("simulated provider cleanup failure");
    },
  });
  const providerAccess = { functionGrants: [LIFECYCLE_FUNCTION.id] };
  const oldCalls = ["call-a", "call-b"].map((callId) => directory.invoke({
    node: LIFECYCLE_NODE,
    functionId: LIFECYCLE_FUNCTION.id,
    value: { callId },
    access: providerAccess,
  }));
  await waitUntil(() => oldProvider.view().activeInvocations === 2, "two provider leases");
  const providerGenerationAtomic = directory.providerBindings().length === 1
    && directory.providerBindings()[0]?.epoch === 1;

  const replacementProvider = directory.bindProviderGeneration({
    generationId: "simulation-provider-v2",
    providers: [{
      providerId: "simulation-provider",
      functionId: LIFECYCLE_FUNCTION.id,
      epoch: 2,
      invoke: async () => ({ epoch: 2 }),
    }],
  });
  const newCall = await directory.invoke({
    node: LIFECYCLE_NODE,
    functionId: LIFECYCLE_FUNCTION.id,
    value: { callId: "call-new" },
    access: providerAccess,
  });
  let drainTimedOut = !input.injectFaults;
  if (input.injectFaults) {
    const timedOut = await oldProvider.withdraw({ timeoutMs: 1 });
    drainTimedOut = timedOut.status === "timed-out" && timedOut.activeInvocations === 2;
    if (drainTimedOut) faults.record("provider-drain-timeout");
  }
  const providerCompletionOrder = shuffle(["call-a", "call-b"], input.entropy, "provider-release");
  for (const callId of providerCompletionOrder) {
    providerResolvers.get(callId)?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const oldResults = await Promise.all(oldCalls);
  const oldWithdrawal = await oldProvider.withdraw();
  if (input.injectFaults && oldWithdrawal.status === "cleanup-uncertain") {
    faults.record("provider-cleanup-failure");
  }
  const providerDrainContained = drainTimedOut
    && oldDisposed
    && oldResults.every((result) =>
      result.status === "completed" && completedEpoch(result.output) === 1)
    && newCall.status === "completed"
    && completedEpoch(newCall.output) === 2
    && oldProvider.view().activeInvocations === 0;
  await replacementProvider.withdraw();

  const bindingEvents = trace;
  const bindingManager = new RuntimeBindingEpochLifecycleManager<{ readonly name: string }>({
    nodeId: LIFECYCLE_NODE.id,
    limits: { maxAttemptLeases: 2, drainTimeoutMs: 2 },
  });
  const publishedEpochs: number[] = [];
  const publishEpoch = async (epoch: number): Promise<void> => {
    await bindingManager.replace({
      epoch,
      activate: (scope) => {
        scope.defer(() => { bindingEvents.push(`binding-close:${epoch}`); });
        return { name: `runtime-${epoch}` };
      },
      validateReady: () => undefined,
      publish: (identity) => { publishedEpochs.push(identity.epoch); },
    });
  };
  await publishEpoch(1);
  const epochOneLease = bindingManager.acquire({ attemptId: "attempt-one" });
  const publishTwo = publishEpoch(2);
  await waitUntil(() => bindingManager.current?.epoch === 2, "binding epoch two");
  epochOneLease.release();
  await publishTwo;
  let bindingDrainContained = true;
  if (input.injectFaults) {
    const stuck = bindingManager.acquire({ attemptId: "attempt-stuck" });
    const transition = await bindingManager.replace({
      epoch: 3,
      activate: () => ({ name: "runtime-3" }),
      validateReady: () => undefined,
      publish: (identity) => { publishedEpochs.push(identity.epoch); },
    });
    bindingDrainContained = stuck.signal.aborted
      && transition.diagnostics.some(({ kind }) => kind === "drain-timeout");
    if (bindingDrainContained) faults.record("binding-drain-timeout");
    stuck.release();
    let candidateClosed = 0;
    try {
      await bindingManager.replace({
        epoch: 4,
        activate: (scope) => {
          scope.defer(() => { candidateClosed += 1; });
          return { name: "runtime-4" };
        },
        validateReady: () => undefined,
        publish: () => { throw new Error("simulated durable publish failure"); },
      });
      throw new Error("Runtime lifecycle simulator accepted a failed binding publication");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("simulated durable publish failure")) throw error;
      if (candidateClosed === 1) faults.record("binding-publish-failure");
    }
  }
  const currentBinding = bindingManager.current;
  const expectedBindingEpoch = input.injectFaults ? 3 : 2;
  const runtimeBindingMonotonic = currentBinding?.nodeId === LIFECYCLE_NODE.id
    && currentBinding.epoch === expectedBindingEpoch
    && publishedEpochs.every((epoch, index) => index === 0 || epoch > publishedEpochs[index - 1]!)
    && bindingDrainContained;
  await bindingManager.close();

  const extensionTrace = trace;
  const extensionHost = new RuntimeExtensionHost();
  const initialExtensions = shuffle([
    databaseExtension("1", "one", extensionTrace),
    repositoryExtension(extensionTrace),
  ], input.entropy, "extension-initial-order");
  await extensionHost.reconcile(initialExtensions);
  const stableGeneration = extensionHost.generation().generationId;
  const stableView = extensionHost.view({ scopeId: "simulation/stable" });
  let extensionFailureContained = true;
  if (input.injectFaults) {
    try {
      await extensionHost.reconcile([{
        id: "database",
        version: "failure",
        provides: [DATABASE],
        activate: ({ provide, scope }) => {
          scope.defer(() => { extensionTrace.push("extension-dispose:failed"); });
          provide(DATABASE, { query: () => "failed" });
          throw new Error("simulated extension activation failure");
        },
      }, repositoryExtension(extensionTrace)]);
      throw new Error("Runtime lifecycle simulator committed a failed extension generation");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("simulated extension activation failure")) throw error;
      extensionFailureContained = extensionHost.generation().generationId === stableGeneration;
      if (extensionFailureContained) faults.record("extension-activation-failure");
    }
    const cycleA = defineRuntimeService("simulation.cycle.a", "1");
    const cycleB = defineRuntimeService("simulation.cycle.b", "1");
    try {
      await extensionHost.reconcile([{
        id: "cycle-a",
        version: "1",
        requires: [cycleB],
        provides: [cycleA],
        activate: () => undefined,
      }, {
        id: "cycle-b",
        version: "1",
        requires: [cycleA],
        provides: [cycleB],
        activate: () => undefined,
      }]);
      throw new Error("Runtime lifecycle simulator accepted an extension cycle");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("dependency cycle")) throw error;
      faults.record("extension-cycle-rejected");
    }
  }
  const nextExtensions = shuffle([
    databaseExtension("2", "two", extensionTrace),
    repositoryExtension(extensionTrace),
  ], input.entropy, "extension-next-order");
  const extensionChange = await extensionHost.reconcile(nextExtensions);
  const currentRepository = extensionHost.view({ scopeId: "simulation/current" }).get(REPOSITORY).read();
  let staleRejected = false;
  try {
    stableView.get(DATABASE);
  } catch (error) {
    staleRejected = error instanceof Error && error.message.includes("stale committed generation");
  }
  const databaseOnly = extensionHost.view({
    scopeId: "simulation/database-only",
    services: [DATABASE],
  });
  const narrowed = databaseOnly.attenuate({
    scopeId: "simulation/database-only/child",
    services: [DATABASE, REPOSITORY],
  });
  let wideningRejected = false;
  try {
    narrowed.get(REPOSITORY);
  } catch (error) {
    wideningRejected = error instanceof Error && error.message.includes("does not grant");
  }
  const extensionReconciliationAtomic = extensionFailureContained
    && extensionChange.activated.join(",") === "database,repository"
    && extensionChange.withdrawn.join(",") === "repository,database"
    && currentRepository === "repo:two"
    && staleRejected;
  const serviceAuthorityAttenuated = narrowed.services.length === 1
    && narrowed.has(DATABASE)
    && wideningRejected;
  const extensionGenerationId = extensionHost.generation().generationId;
  await extensionHost.close();

  const reloadHost = new RuntimeExtensionHost();
  await reloadHost.reconcile([databaseExtension("1", "stable", [])]);
  const reloadStableGeneration = reloadHost.generation().generationId;
  const reloadScheduler = new ManualReloadScheduler();
  const reload = new RuntimeExtensionReloadAdapter(reloadHost, {
    debounceMs: 1,
    maxPendingCandidates: 2,
    scheduler: reloadScheduler,
  });
  let reloadFailureContained = true;
  if (input.injectFaults) {
    const failure = reload.submit([{
      id: "database",
      version: "failure",
      provides: [DATABASE],
      activate: () => { throw new Error("simulated reload activation failure"); },
    }]);
    reloadScheduler.flush();
    const outcome = await failure;
    reloadFailureContained = outcome.status === "failed"
      && reloadHost.generation().generationId === reloadStableGeneration;
    if (reloadFailureContained) faults.record("reload-activation-failure");
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  const superseded = reload.submit([databaseExtension("2", "two", [])]);
  const selected = reload.submit([databaseExtension("3", "three", [])]);
  reloadScheduler.flush();
  const [supersededOutcome, selectedOutcome] = await Promise.all([superseded, selected]);
  reloadFailureContained = reloadFailureContained
    && supersededOutcome.status === "superseded"
    && selectedOutcome.status === "applied"
    && reloadHost.view({ scopeId: "simulation/reload" }).get(DATABASE).query() === "three";
  await reload.close();
  await reloadHost.close();

  const immediate = createRuntimeEmissionClassification({ kind: "immediate-nonrepeatable" });
  const deferred = createRuntimeEmissionClassification({ kind: "deferred-until-acceptance" });
  const compensatable = createRuntimeEmissionClassification({
    kind: "compensatable",
    compensation: {
      handlerId: "simulation.compensate",
      handlerVersion: "1",
      idempotencyKey: "simulation-compensation-key",
      equivalenceId: "simulation.compensated",
      equivalenceVersion: "1",
    },
  });
  const emissionIntent = createRuntimeEmissionIntent({
    runId: "simulation-run",
    taskId: "simulation-task",
    nodeId: LIFECYCLE_NODE.id,
    operationId: "simulation.emit",
    attempt: 1,
    taskDefinitionHash: "sha256:simulation-task",
    payloadHash: "sha256:simulation-payload",
    classification: compensatable,
  });
  const compensation = createRuntimeCompensationEvidence({
    intent: emissionIntent,
    emissionEvidenceHash: "sha256:simulation-emission",
    compensationAttempt: 1,
    outcome: "completed",
    resultHash: "sha256:simulation-compensation",
  });
  let retryRejected = !input.injectFaults;
  if (input.injectFaults) {
    try {
      assertRuntimeEmissionRetryAllowed(immediate, 2);
      throw new Error("Runtime lifecycle simulator retried a non-repeatable emission");
    } catch (error) {
      retryRejected = error instanceof Error && error.message.includes("cannot be retried automatically");
      if (!retryRejected) throw error;
      faults.record("emission-retry-rejected");
    }
  }
  assertRuntimeEmissionRetryAllowed(deferred, 2);
  const emissionRetrySafe = retryRejected
    && validateRuntimeCompensationEvidence({ intent: emissionIntent, evidence: compensation }).evidenceId
      === compensation.evidenceId;

  const rolloutProposal = createRuntimeExtensionRolloutProposal({
    extensionId: "simulation.extension",
    artifactHash: "sha256:simulation-candidate",
    manifestHash: "sha256:simulation-candidate-manifest",
    proposerId: "simulation-proposer",
    baselineEpoch: 1,
    targetEpoch: 2,
    lastKnownGoodArtifactHash: "sha256:simulation-stable",
    lastKnownGoodManifestHash: "sha256:simulation-stable-manifest",
    baselineAuthority: {
      functionGrants: [LIFECYCLE_FUNCTION.id],
      scopes: ["simulation:read"],
      allowedEffects: ["read"],
      workspaceOperations: ["read"],
      allowGraphExpansion: false,
    },
    candidateAuthority: {
      functionGrants: [LIFECYCLE_FUNCTION.id],
      scopes: ["simulation:read"],
      allowedEffects: ["read"],
      workspaceOperations: ["read"],
      allowGraphExpansion: false,
    },
    baselineBudget: {
      maxCanaryRuns: 4,
      maxTasks: 8,
      maxTokens: 10_000,
      maxCostMicros: 1_000_000,
      maxWallTimeMs: 60_000,
    },
    candidateBudget: {
      maxCanaryRuns: 2,
      maxTasks: 4,
      maxTokens: 5_000,
      maxCostMicros: 500_000,
      maxWallTimeMs: 30_000,
    },
    emission: createRuntimeEmissionClassification({ kind: "no-emission" }),
  });
  const rolloutHistory: RuntimeExtensionRolloutRecord[] = [rolloutProposal];
  let selfVerificationRejected = !input.injectFaults;
  if (input.injectFaults) {
    try {
      verifyRuntimeExtensionRollout(rolloutHistory, {
        authority: {
          authorityId: "simulation-proposer",
          kind: "deterministic-policy",
          authorizationHash: "sha256:simulation-proposer",
        },
        evidenceHash: "sha256:simulation-self-verification",
      });
      throw new Error("Runtime lifecycle simulator accepted self-verification");
    } catch (error) {
      selfVerificationRejected = error instanceof Error && error.message.includes("forbids self-promotion");
      if (!selfVerificationRejected) throw error;
      faults.record("self-improvement-self-verification-rejected");
    }
  }
  rolloutHistory.push(verifyRuntimeExtensionRollout(rolloutHistory, {
    authority: {
      authorityId: "simulation-verifier",
      kind: "deterministic-policy",
      authorizationHash: "sha256:simulation-verifier",
    },
    evidenceHash: "sha256:simulation-verification",
  }));
  rolloutHistory.push(warmRuntimeExtensionRollout(rolloutHistory, {
    evidenceHash: "sha256:simulation-warming",
  }));
  const canaries: RuntimeExtensionCanaryEvidence[] = shuffle([{
    canaryId: "simulation-canary-a",
    outcomeHash: "sha256:simulation-canary-a",
    verdict: "passed" as const,
    tasks: 1,
    tokens: 1_000,
    costMicros: 100_000,
    wallTimeMs: 1_000,
  }, {
    canaryId: "simulation-canary-b",
    outcomeHash: "sha256:simulation-canary-b",
    verdict: "passed" as const,
    tasks: 1,
    tokens: 1_000,
    costMicros: 100_000,
    wallTimeMs: 1_000,
  }], input.entropy, "rollout-canary-order");
  rolloutHistory.push(recordRuntimeExtensionCanary(rolloutHistory, {
    authority: {
      authorityId: "simulation-canary-operator",
      kind: "deterministic-policy",
      authorizationHash: "sha256:simulation-canary-operator",
    },
    evidence: canaries,
  }));
  if (input.injectFaults) {
    try {
      promoteRuntimeExtensionRollout(rolloutHistory, {
        authority: {
          authorityId: "simulation-verifier",
          kind: "deterministic-policy",
          authorizationHash: "sha256:simulation-verifier",
        },
        evidenceHash: "sha256:simulation-invalid-promotion",
      });
      throw new Error("Runtime lifecycle simulator accepted dependent rollout authority");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("independent from verification authority")) throw error;
      faults.record("rollout-authority-rejected");
    }
  }
  rolloutHistory.push(promoteRuntimeExtensionRollout(rolloutHistory, {
    authority: {
      authorityId: "simulation-operator",
      kind: "human",
      authorizationHash: "sha256:simulation-operator",
    },
    evidenceHash: "sha256:simulation-promotion",
  }));
  rolloutHistory.push(rollbackRuntimeExtensionRolloutForward(rolloutHistory, {
    authority: {
      authorityId: "simulation-rollback-operator",
      kind: "human",
      authorizationHash: "sha256:simulation-rollback-operator",
    },
    epoch: 3,
    reason: "Simulation rollback-forward exercise.",
    evidenceHash: "sha256:simulation-rollback",
  }));
  const projectedRollout = projectRuntimeExtensionRollout(rolloutHistory);
  const redeliveredRollout = projectRuntimeExtensionRollout(shuffle(
    [...rolloutHistory, rolloutHistory[3]!],
    input.entropy,
    "rollout-delivery-order",
  ));
  const rolloutGoverned = projectedRollout.status === "rollback-forward"
    && projectedRollout.currentEpoch === 3
    && projectedRollout.currentArtifactHash === "sha256:simulation-stable"
    && hashCanonical(redeliveredRollout) === hashCanonical(projectedRollout);
  const selfImprovementGoverned = selfVerificationRejected
    && rolloutGoverned
    && projectedRollout.proposal.proposerId === "simulation-proposer"
    && projectedRollout.verifier?.authorityId === "simulation-verifier"
    && projectedRollout.promotionAuthority?.authorityId === "simulation-operator"
    && projectedRollout.rollback?.authority.authorityId === "simulation-rollback-operator";

  const exercisedFaultIds = faults.ids();
  const semantic = Object.freeze({
    effectOwnershipExact,
    activationTransactional,
    providerGenerationAtomic,
    providerDrainContained,
    providerGenerationHash: oldProvider.generationHash,
    runtimeBindingMonotonic,
    publishedEpochs,
    extensionReconciliationAtomic,
    serviceAuthorityAttenuated,
    extensionGenerationId,
    reloadFailureContained,
    emissionRetrySafe,
    emissionIntentId: emissionIntent.intentId,
    compensationEvidenceId: compensation.evidenceId,
    rolloutGoverned,
    selfImprovementGoverned,
    rolloutRecordIds: projectedRollout.recordIds,
    exercisedFaultIds,
  });
  return Object.freeze({
    trace: Object.freeze([...trace]),
    observation: Object.freeze({
      effectOwnershipExact,
      activationTransactional,
      providerGenerationAtomic,
      providerDrainContained,
      runtimeBindingMonotonic,
      extensionReconciliationAtomic,
      serviceAuthorityAttenuated,
      reloadFailureContained,
      emissionRetrySafe,
      rolloutGoverned,
      selfImprovementGoverned,
      peakEffects: effectRegistration.length,
      peakProviderLeases: 2,
      peakBindingLeases: 1,
      exercisedFaultIds,
      semanticDigest: hashCanonical(semantic),
    }),
  });
};

const everySchedule = (
  observations: ReadonlyArray<RuntimeLifecycleScheduleObservation>,
  select: (observation: RuntimeLifecycleScheduleObservation) => boolean,
): boolean => observations.length > 0 && observations.every(select);

export const evaluateRuntimeLifecycleSimulation = (input: {
  readonly simulationInput: RuntimeLifecycleSimulationInput;
  readonly schedules: ReadonlyArray<RuntimeLifecycleScheduleReport>;
}): ReadonlyArray<RuntimeLifecycleInvariantResult> => {
  const observations = input.schedules.map(({ observation }) => observation);
  const exactReplays = input.schedules.filter(({ replayExact }) => replayExact).length;
  const converged = new Set(observations.map(({ semanticDigest }) => semanticDigest)).size === 1;
  const expectedFaultIds = input.simulationInput.injectFaults
    ? RUNTIME_LIFECYCLE_SIMULATION_FAULT_IDS
    : [];
  const result = (
    id: RuntimeLifecycleInvariantId,
    label: string,
    passed: boolean,
    evidence: string,
  ): RuntimeLifecycleInvariantResult => Object.freeze({ id, label, passed, evidence });
  return Object.freeze([
    result("effect-ownership-exact", "Effect ownership closes exactly once in LIFO order",
      everySchedule(observations, ({ effectOwnershipExact }) => effectOwnershipExact),
      `${observations.filter(({ effectOwnershipExact }) => effectOwnershipExact).length}/${observations.length} schedules`),
    result("activation-transactional", "Failed activation rolls back its partial scope",
      everySchedule(observations, ({ activationTransactional }) => activationTransactional),
      `${observations.filter(({ activationTransactional }) => activationTransactional).length}/${observations.length} schedules`),
    result("provider-generation-atomic", "Provider generations publish atomically",
      everySchedule(observations, ({ providerGenerationAtomic }) => providerGenerationAtomic),
      `${observations.filter(({ providerGenerationAtomic }) => providerGenerationAtomic).length}/${observations.length} schedules`),
    result("provider-drain-contained", "Provider leases drain before disposal",
      everySchedule(observations, ({ providerDrainContained }) => providerDrainContained),
      `${observations.filter(({ providerDrainContained }) => providerDrainContained).length}/${observations.length} schedules`),
    result("runtime-binding-monotonic", "Runtime binding epochs advance without changing node identity",
      everySchedule(observations, ({ runtimeBindingMonotonic }) => runtimeBindingMonotonic),
      `${observations.filter(({ runtimeBindingMonotonic }) => runtimeBindingMonotonic).length}/${observations.length} schedules`),
    result("extension-reconciliation-atomic", "Extension replacement is transactional and dependency ordered",
      everySchedule(observations, ({ extensionReconciliationAtomic }) => extensionReconciliationAtomic),
      `${observations.filter(({ extensionReconciliationAtomic }) => extensionReconciliationAtomic).length}/${observations.length} schedules`),
    result("service-authority-attenuated", "Scoped service views cannot widen authority",
      everySchedule(observations, ({ serviceAuthorityAttenuated }) => serviceAuthorityAttenuated),
      `${observations.filter(({ serviceAuthorityAttenuated }) => serviceAuthorityAttenuated).length}/${observations.length} schedules`),
    result("reload-failure-contained", "Reload failures preserve the committed generation",
      everySchedule(observations, ({ reloadFailureContained }) => reloadFailureContained),
      `${observations.filter(({ reloadFailureContained }) => reloadFailureContained).length}/${observations.length} schedules`),
    result("emission-retry-safe", "Non-repeatable emissions reject retry and compensation stays forward",
      everySchedule(observations, ({ emissionRetrySafe }) => emissionRetrySafe),
      `${observations.filter(({ emissionRetrySafe }) => emissionRetrySafe).length}/${observations.length} schedules`),
    result("rollout-governed", "Verification, promotion, canary, and rollback-forward remain governed",
      everySchedule(observations, ({ rolloutGoverned }) => rolloutGoverned),
      `${observations.filter(({ rolloutGoverned }) => rolloutGoverned).length}/${observations.length} schedules`),
    result("self-improvement-governed", "Generated improvements cannot verify or promote themselves",
      everySchedule(observations, ({ selfImprovementGoverned }) => selfImprovementGoverned),
      `${observations.filter(({ selfImprovementGoverned }) => selfImprovementGoverned).length}/${observations.length} schedules`),
    result("fault-plan-exercised", "Every declared lifecycle fault is exercised",
      everySchedule(observations, ({ exercisedFaultIds }) =>
        hashCanonical(exercisedFaultIds) === hashCanonical(expectedFaultIds)),
      `${observations.reduce((total, observation) => total + observation.exercisedFaultIds.length, 0)} recovered occurrences`),
    result("bounded-lifecycle", "Effect, provider, and binding leases stay within simulation bounds",
      everySchedule(observations, (observation) =>
        observation.peakEffects <= 3
        && observation.peakProviderLeases <= 2
        && observation.peakBindingLeases <= 2),
      `peaks effects=${Math.max(...observations.map(({ peakEffects }) => peakEffects))}, provider=${Math.max(...observations.map(({ peakProviderLeases }) => peakProviderLeases))}, binding=${Math.max(...observations.map(({ peakBindingLeases }) => peakBindingLeases))}`),
    result("semantic-convergence", "Lifecycle schedules converge on one semantic state", converged,
      `${new Set(observations.map(({ semanticDigest }) => semanticDigest)).size} semantic digest(s)`),
    result("exact-replay", "Recorded entropy replays the exact lifecycle trace", exactReplays === input.schedules.length,
      `${exactReplays}/${input.schedules.length} exact replays`),
  ]);
};

export const runRuntimeLifecycleSimulation = async (
  rawInput: Partial<RuntimeLifecycleSimulationInput> = {},
): Promise<RuntimeLifecycleSimulationReport> => {
  const input = normalizeRuntimeLifecycleSimulationInput(rawInput);
  const schedules: RuntimeLifecycleScheduleReport[] = [];
  const transitionDigests = new Set<string>();
  let representativeTrace: ReadonlyArray<string> = Object.freeze([]);

  for (let index = 0; index < input.schedules; index += 1) {
    const seed = (input.seed + Math.imul(index, 0x9e3779b1)) >>> 0;
    const recording = new RecordingEntropySource(new SeededEntropySource(seed));
    const first = await runScenario({ entropy: recording, injectFaults: input.injectFaults });
    const records = recording.getRecords();
    const replaySource = new ReplayingEntropySource(records);
    let replayDraws = 0;
    const replayEntropy: EntropySource = {
      random: (reason) => {
        replayDraws += 1;
        return replaySource.random(reason);
      },
    };
    const replay = await runScenario({ entropy: replayEntropy, injectFaults: input.injectFaults });
    const replayExact = replayDraws === records.length
      && hashCanonical(first) === hashCanonical(replay);
    const transitionDigest = hashCanonical(first.trace).slice(0, 16);
    transitionDigests.add(transitionDigest);
    representativeTrace = representativeTrace.length > 0 ? representativeTrace : first.trace;
    schedules.push(Object.freeze({
      seed,
      seedHex: `0x${seed.toString(16).padStart(8, "0")}`,
      entropyDraws: records.length,
      replayExact,
      transitionCount: first.trace.length,
      transitionDigest,
      observation: first.observation,
    }));
  }

  const invariants = evaluateRuntimeLifecycleSimulation({ simulationInput: input, schedules });
  const observations = schedules.map(({ observation }) => observation);
  const converged = new Set(observations.map(({ semanticDigest }) => semanticDigest)).size === 1;
  const exactReplays = schedules.filter(({ replayExact }) => replayExact).length;
  const summary = Object.freeze({
    passed: invariants.every(({ passed }) => passed),
    converged,
    exactReplays,
    scheduleVariants: transitionDigests.size,
    faultRecoveries: observations.reduce(
      (total, observation) => total + observation.exercisedFaultIds.length,
      0,
    ),
    peakEffects: Math.max(...observations.map(({ peakEffects }) => peakEffects)),
    peakProviderLeases: Math.max(...observations.map(({ peakProviderLeases }) => peakProviderLeases)),
    peakBindingLeases: Math.max(...observations.map(({ peakBindingLeases }) => peakBindingLeases)),
  });
  const content = Object.freeze({
    schemaVersion: RUNTIME_LIFECYCLE_SIMULATION_VERSION,
    input,
    schedules: Object.freeze(schedules),
    representativeTrace,
    invariants,
    summary,
  });
  return Object.freeze({
    ...content,
    simulationId: `runtime_lifecycle_simulation_${hashCanonical(content).slice(0, 24)}`,
  });
};
