import { performance } from "node:perf_hooks";

import { connectSpacetimeControlPlaneFromEnv } from "../adapters/spacetimedb-control.js";
import { createSpacetimeJobQueue } from "../adapters/spacetimedb-job-queue.js";
import { SpacetimeEventRepository } from "../adapters/spacetimedb-runtime.js";
import { receipt } from "../core/chain.js";

export const SPACETIMEDB_SOAK_EVIDENCE_SCHEMA = "roster.spacetimedb-soak-evidence.v1" as const;

export type SpacetimeSoakConfig = {
  /** Reuse a caller-owned verification workspace when the environment has one. */
  readonly workspaceId?: string;
  readonly eventCount: number;
  readonly providerCallCount?: number;
  readonly eventP95Ms: number;
  readonly reconnectP95Ms: number;
  readonly workerRecoveryP95Ms: number;
  readonly providerP95Ms?: number;
  readonly providerProbe?: (iteration: number) => Promise<void>;
};

export type SpacetimeSoakEvidence = {
  readonly schema: typeof SPACETIMEDB_SOAK_EVIDENCE_SCHEMA;
  readonly passed: boolean;
  readonly workspaceId: string;
  readonly streamId: string;
  readonly eventCount: number;
  readonly recoveredEventCount: number;
  readonly eventLatencyMs: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly reconnectLatencyMs: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly workerRecoveryLatencyMs: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly providerLatencyMs?: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly workerRecovery: {
    readonly firstWorker: string;
    readonly replacementWorker: string;
    readonly firstFence: string;
    readonly replacementFence: string;
    readonly completed: boolean;
  };
  readonly violations: ReadonlyArray<string>;
};

const finiteInteger = (value: number, name: string, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const finiteDuration = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0 || value > 600_000) {
    throw new Error(`${name} must be between 0 and 600000ms`);
  }
  return value;
};

const workspaceIdForSoak = (value: string | undefined, suffix: string): string => {
  const workspaceId = value?.trim() || `verification/soak/${suffix}`;
  if (workspaceId.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(workspaceId)) {
    throw new Error("workspaceId must be a safe SpacetimeDB workspace identifier");
  }
  return workspaceId;
};

const percentile = (values: ReadonlyArray<number>, quantile: number): number => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)] ?? 0;
};

const latency = (values: ReadonlyArray<number>) => ({
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: values.length ? Math.max(...values) : 0,
});

const wait = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export const runSpacetimeSoak = async (
  config: SpacetimeSoakConfig,
): Promise<SpacetimeSoakEvidence> => {
  const eventCount = finiteInteger(config.eventCount, "eventCount", 1, 100_000);
  const providerCallCount = finiteInteger(config.providerCallCount ?? 0, "providerCallCount", 0, 1_000);
  const eventP95Ms = finiteDuration(config.eventP95Ms, "eventP95Ms");
  const reconnectP95Ms = finiteDuration(config.reconnectP95Ms, "reconnectP95Ms");
  const workerRecoveryP95Ms = finiteDuration(config.workerRecoveryP95Ms, "workerRecoveryP95Ms");
  const providerP95Ms = config.providerP95Ms === undefined
    ? undefined
    : finiteDuration(config.providerP95Ms, "providerP95Ms");
  if (providerCallCount > 0 && !config.providerProbe) {
    throw new Error("providerCallCount requires an explicit providerProbe");
  }
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const workspaceId = workspaceIdForSoak(config.workspaceId, suffix);
  const streamId = `verification/soak/events/${suffix}`;
  const jobId = `soak_job_${suffix.replaceAll("-", "_")}`;
  const agentId = `soak-agent-${suffix}`;
  const firstWorker = `soak-worker-a-${suffix}`;
  const replacementWorker = `soak-worker-b-${suffix}`;
  const eventLatencies: number[] = [];
  const providerLatencies: number[] = [];
  const reconnectLatencies: number[] = [];
  const recoveryLatencies: number[] = [];
  let firstFence = "";
  let replacementFence = "";
  let recoveredEventCount = 0;
  let completed = false;
  let firstControl = await connectSpacetimeControlPlaneFromEnv();
  if (!firstControl) throw new Error("SpacetimeDB soak requires SPACETIMEDB_URI and SPACETIMEDB_DATABASE");
  let firstRepository = new SpacetimeEventRepository(firstControl, workspaceId, "Roster scale soak");
  let firstQueue: Awaited<ReturnType<typeof createSpacetimeJobQueue>> | undefined;
  let replacementControl: Awaited<ReturnType<typeof connectSpacetimeControlPlaneFromEnv>> | undefined;
  let replacementRepository: SpacetimeEventRepository | undefined;
  let replacementQueue: Awaited<ReturnType<typeof createSpacetimeJobQueue>> | undefined;
  try {
    await firstRepository.initialize();
    firstQueue = await createSpacetimeJobQueue({ control: firstControl, workspaceId });
    let previousHash: string | undefined;
    for (let index = 0; index < eventCount; index += 1) {
      const event = receipt(streamId, previousHash, {
        type: "soak.event",
        index,
        nonce: suffix,
      }, Date.now() + index, { eventId: `soak:${suffix}:${index}` });
      const startedAt = performance.now();
      await firstRepository.append(event);
      eventLatencies.push(performance.now() - startedAt);
      previousHash = event.hash;
      if (config.providerProbe && providerLatencies.length < providerCallCount) {
        const targetIndex = Math.floor((providerLatencies.length + 1) * eventCount / (providerCallCount + 1));
        if (index >= targetIndex) {
          const providerStartedAt = performance.now();
          await config.providerProbe(providerLatencies.length);
          providerLatencies.push(performance.now() - providerStartedAt);
        }
      }
    }
    while (config.providerProbe && providerLatencies.length < providerCallCount) {
      const providerStartedAt = performance.now();
      await config.providerProbe(providerLatencies.length);
      providerLatencies.push(performance.now() - providerStartedAt);
    }
    await firstQueue.enqueue({
      jobId,
      requestId: `soak_request_${suffix.replaceAll("-", "_")}`,
      agentId,
      payload: { schema: SPACETIMEDB_SOAK_EVIDENCE_SCHEMA, streamId },
      maxAttempts: 3,
    });
    const firstLease = await firstQueue.leaseNext({ workerId: firstWorker, leaseMs: 1_000, agentId });
    if (firstLease?.id !== jobId || !firstLease.leaseFence) {
      throw new Error("Soak worker could not claim its isolated crash probe job");
    }
    firstFence = firstLease.leaseFence;

    // Simulate process loss while the worker owns the lease. No graceful job
    // completion or failure is sent; SpacetimeDB expiry must fence recovery.
    firstQueue.close();
    firstRepository.close();
    firstControl.disconnect();
    const recoveryStartedAt = performance.now();
    await wait(1_100);

    const reconnectStartedAt = performance.now();
    replacementControl = await connectSpacetimeControlPlaneFromEnv();
    if (!replacementControl) throw new Error("SpacetimeDB replacement connection was unavailable");
    replacementRepository = new SpacetimeEventRepository(replacementControl, workspaceId, "Roster scale soak");
    replacementQueue = await createSpacetimeJobQueue({ control: replacementControl, workspaceId });
    await replacementRepository.initialize();
    await replacementRepository.subscribeStream(streamId);
    recoveredEventCount = (await replacementRepository.read(streamId)).length;
    reconnectLatencies.push(performance.now() - reconnectStartedAt);

    const recoveryDeadline = performance.now() + workerRecoveryP95Ms;
    let replacementLease = await replacementQueue.leaseNext({
      workerId: replacementWorker,
      leaseMs: 5_000,
      agentId,
    });
    while (!replacementLease && performance.now() < recoveryDeadline) {
      await wait(100);
      replacementLease = await replacementQueue.leaseNext({
        workerId: replacementWorker,
        leaseMs: 5_000,
        agentId,
      });
    }
    if (replacementLease?.id !== jobId || !replacementLease.leaseFence) {
      throw new Error("Replacement worker did not recover the isolated expired job lease");
    }
    replacementFence = replacementLease.leaseFence;
    const completion = await replacementQueue.complete(
      replacementLease.id,
      replacementWorker,
      { recoveredEventCount },
      replacementFence,
    );
    completed = completion?.status === "completed";
    recoveryLatencies.push(performance.now() - recoveryStartedAt);
  } finally {
    firstQueue?.close();
    firstRepository.close();
    firstControl.disconnect();
    replacementQueue?.close();
    replacementRepository?.close();
    replacementControl?.disconnect();
  }
  const eventLatencyMs = latency(eventLatencies);
  const reconnectLatencyMs = latency(reconnectLatencies);
  const workerRecoveryLatencyMs = latency(recoveryLatencies);
  const providerLatencyMs = providerLatencies.length ? latency(providerLatencies) : undefined;
  const violations: string[] = [];
  if (recoveredEventCount !== eventCount) violations.push(`recovered ${recoveredEventCount}/${eventCount} events`);
  if (!completed) violations.push("replacement worker did not complete the recovered job");
  if (!firstFence || !replacementFence || firstFence === replacementFence) {
    violations.push("worker recovery did not advance the lease fence");
  }
  if (eventLatencyMs.p95 > eventP95Ms) violations.push(`event p95 ${eventLatencyMs.p95.toFixed(2)}ms > ${eventP95Ms}ms`);
  if (reconnectLatencyMs.p95 > reconnectP95Ms) {
    violations.push(`reconnect p95 ${reconnectLatencyMs.p95.toFixed(2)}ms > ${reconnectP95Ms}ms`);
  }
  if (workerRecoveryLatencyMs.p95 > workerRecoveryP95Ms) {
    violations.push(`worker recovery p95 ${workerRecoveryLatencyMs.p95.toFixed(2)}ms > ${workerRecoveryP95Ms}ms`);
  }
  if (providerLatencyMs && providerP95Ms !== undefined && providerLatencyMs.p95 > providerP95Ms) {
    violations.push(`provider p95 ${providerLatencyMs.p95.toFixed(2)}ms > ${providerP95Ms}ms`);
  }
  return {
    schema: SPACETIMEDB_SOAK_EVIDENCE_SCHEMA,
    passed: violations.length === 0,
    workspaceId,
    streamId,
    eventCount,
    recoveredEventCount,
    eventLatencyMs,
    reconnectLatencyMs,
    workerRecoveryLatencyMs,
    ...(providerLatencyMs ? { providerLatencyMs } : {}),
    workerRecovery: {
      firstWorker,
      replacementWorker,
      firstFence,
      replacementFence,
      completed,
    },
    violations,
  };
};
