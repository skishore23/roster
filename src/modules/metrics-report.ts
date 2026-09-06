import type {
  RosterModelReservation,
  RosterParticipantProfileProjection,
  RosterTaskOutcome,
  RosterTaskProjection,
} from "../spacetimedb-bindings/types.js";

export type MetricsHistorySelector =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "since-until"; readonly since?: number; readonly until?: number }
  | { readonly kind: "terminal-limit"; readonly limit: number };

type MetricTask = Pick<RosterTaskProjection, "runId" | "taskId" | "nodeId" | "status" | "createdAt" | "updatedAt" | "attempt" | "leaseFence">;
type MetricOutcome = Pick<RosterTaskOutcome, "runId" | "taskKey" | "outcomeId">;
type MetricReservation = Pick<RosterModelReservation, "runId" | "taskId" | "nodeId" | "fence" | "status" | "actualCostMicros">;

export type MetricsReportInput = {
  readonly workspaceId: string;
  readonly selector: MetricsHistorySelector;
  readonly generatedAt?: number;
  readonly tasks: ReadonlyArray<MetricTask>;
  readonly outcomes?: ReadonlyArray<MetricOutcome>;
  readonly reservations?: ReadonlyArray<MetricReservation>;
  readonly profiles?: ReadonlyArray<Pick<RosterParticipantProfileProjection, "nodeId" | "displayName">>;
};

export type MetricsReport = {
  readonly schemaVersion: "roster.metrics-report.v1";
  readonly workspaceId: string;
  readonly selector: MetricsHistorySelector;
  readonly generatedAt: number;
  readonly runCount: number;
  readonly metricDefinitions: {
    readonly completionRate: string;
    readonly successRate: string;
    readonly latency: string;
    readonly cost: string;
    readonly quality: string;
  };
  readonly totals: NodeMetrics;
  readonly nodes: ReadonlyArray<NodeMetrics & { readonly displayName?: string }>;
  readonly warnings: ReadonlyArray<string>;
};

type NodeMetrics = {
  readonly nodeId: string;
  readonly assignedCount: number;
  readonly terminalCount: number;
  readonly acceptedCount: number;
  readonly failedCount: number;
  readonly canceledCount: number;
  readonly skippedCount: number;
  readonly delegatedCount: number;
  readonly activeCount: number;
  readonly completionRate: Rate;
  readonly successRate: Rate;
  readonly latencyMs: Latency;
  readonly costMicros: Cost;
  readonly quality: null;
};
type Rate = { readonly numerator: number; readonly denominator: number; readonly value: number | null };
type Latency = { readonly samples: number; readonly p50Ms: number | null; readonly p95Ms: number | null };
type Cost = { readonly settledMicros: number; readonly settledCount: number; readonly uncertainCount: number; readonly missingCount: number };

const TERMINAL = new Set(["accepted", "failed", "canceled", "skipped"]);
const micros = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "microsSinceUnixEpoch" in value) return Number((value as { microsSinceUnixEpoch: bigint }).microsSinceUnixEpoch);
  return 0;
};
const rate = (numerator: number, denominator: number): Rate => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
};

export const buildMetricsReport = (input: MetricsReportInput): MetricsReport => {
  if (!input.workspaceId.trim()) throw new Error("workspaceId is required");
  if (input.selector.kind === "terminal-limit" && (!Number.isSafeInteger(input.selector.limit) || input.selector.limit < 0)) throw new Error("terminal-limit must be a non-negative integer");
  let filtered = input.tasks.filter((task) => {
    if (input.selector.kind === "run") return task.runId === input.selector.runId;
    const time = micros(task.createdAt);
    if (input.selector.kind === "since-until") return (input.selector.since === undefined || time >= input.selector.since) && (input.selector.until === undefined || time <= input.selector.until);
    return TERMINAL.has(task.status);
  });
  if (input.selector.kind === "terminal-limit") {
    filtered = [...filtered].sort((a, b) => micros(b.updatedAt) - micros(a.updatedAt) || a.runId.localeCompare(b.runId) || a.taskId.localeCompare(b.taskId)).slice(0, input.selector.limit);
  }
  const runs = new Set(filtered.map((task) => task.runId));
  const profiles = new Map((input.profiles ?? []).map((profile) => [profile.nodeId, profile.displayName]));
  const reservations = new Map<string, MetricReservation>();
  for (const reservation of input.reservations ?? []) {
    const key = `${reservation.runId}:${reservation.taskId}:${reservation.fence}`;
    if (!reservations.has(key)) reservations.set(key, reservation);
  }
  const byNode = new Map<string, MetricTask[]>();
  for (const task of filtered) (byNode.get(task.nodeId) ?? (byNode.set(task.nodeId, []), byNode.get(task.nodeId)!)).push(task);
  const make = (nodeId: string, tasks: MetricTask[]): NodeMetrics & { readonly displayName?: string } => {
    const acceptedCount = tasks.filter((task) => task.status === "accepted").length;
    const failedCount = tasks.filter((task) => task.status === "failed").length;
    const canceledCount = tasks.filter((task) => task.status === "canceled").length;
    const skippedCount = tasks.filter((task) => task.status === "skipped").length;
    const terminalCount = acceptedCount + failedCount + canceledCount + skippedCount;
    const latencyValues = tasks.filter((task) => TERMINAL.has(task.status)).map((task) => Math.max(0, (micros(task.updatedAt) - micros(task.createdAt)) / 1_000));
    let settledMicros = 0, settledCount = 0, uncertainCount = 0, missingCount = 0;
    const selectedTasks = new Set(tasks.map((task) => `${task.runId}:${task.taskId}`));
    for (const reservation of reservations.values()) if ((nodeId === "__total__" || reservation.nodeId === nodeId) && selectedTasks.has(`${reservation.runId}:${reservation.taskId}`)) {
      if (reservation.status === "settled") { settledMicros += Number(reservation.actualCostMicros); settledCount++; }
      else if (reservation.status === "uncertain") uncertainCount++;
    }
    for (const task of tasks) if (![...reservations.values()].some((r) => r.runId === task.runId && r.taskId === task.taskId && r.nodeId === task.nodeId)) missingCount++;
    const result = { nodeId, assignedCount: tasks.length, terminalCount, acceptedCount, failedCount, canceledCount, skippedCount, delegatedCount: tasks.filter((task) => task.status === "delegated").length, activeCount: tasks.filter((task) => !TERMINAL.has(task.status)).length, completionRate: rate(terminalCount, tasks.length), successRate: rate(acceptedCount, acceptedCount + failedCount), latencyMs: { samples: latencyValues.length, p50Ms: percentile(latencyValues, .5), p95Ms: percentile(latencyValues, .95) }, costMicros: { settledMicros, settledCount, uncertainCount, missingCount }, quality: null } as NodeMetrics & { readonly displayName?: string };
    const displayName = profiles.get(nodeId); return displayName ? { ...result, displayName } : result;
  };
  const nodes = [...byNode.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([nodeId, tasks]) => make(nodeId, tasks));
  const all = make("__total__", filtered);
  return { schemaVersion: "roster.metrics-report.v1", workspaceId: input.workspaceId, selector: input.selector, generatedAt: input.generatedAt ?? Date.now(), runCount: runs.size, metricDefinitions: { completionRate: "terminal task dispositions / assigned tasks", successRate: "accepted / (accepted + failed)", latency: "terminal updatedAt - createdAt, including queueing and retries", cost: "settled actual reservation cost counted once per attempt/fence", quality: "null until authoritative comparable review evidence exists" }, totals: { ...all, nodeId: "total" }, nodes, warnings: ["Quality is unavailable: no authoritative comparable quality signal is persisted.", ...(input.reservations === undefined ? ["Cost coverage is unavailable because reservation data was not provided."] : [])] };
};

export const formatMetricsReport = (report: MetricsReport): string => report.nodes.map((node) => `${node.nodeId}: completion ${(node.completionRate.value === null ? "n/a" : `${(node.completionRate.value * 100).toFixed(1)}%`)} success ${(node.successRate.value === null ? "n/a" : `${(node.successRate.value * 100).toFixed(1)}%`)} latency p50 ${node.latencyMs.p50Ms ?? "n/a"}ms cost ${node.costMicros.settledMicros}µ`).join("\n");

