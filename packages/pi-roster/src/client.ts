import {
  ROSTER_CONTROL_API_VERSION,
  ROSTER_CONTROL_MEDIA_TYPE,
  type RosterCommandReceipt,
  type RosterDiff,
  type RosterReviewPolicy,
  type RosterRunList,
  type RosterRunSummary,
  type RosterTaskSummary,
  type RosterWorkspaceSummary,
  type RosterWorkerRuntime,
} from "./contracts.js";

export type RosterClientOptions = {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
};

export class RosterApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RosterApiError";
    this.status = status;
  }
}

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, "");

const errorMessage = (value: unknown, fallback: string): string => {
  if (typeof value === "object" && value !== null && "error" in value) {
    const error = (value as { readonly error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
};

export class RosterClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: RosterClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (!this.baseUrl) throw new Error("Roster API URL must not be blank");
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private async request<Value>(path: string, init: RequestInit = {}): Promise<Value> {
    const headers = new Headers(init.headers);
    headers.set("accept", ROSTER_CONTROL_MEDIA_TYPE);
    if (init.body !== undefined) headers.set("content-type", ROSTER_CONTROL_MEDIA_TYPE);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    const response = await this.fetcher(`${this.baseUrl}/api/v2/coding${path}`, { ...init, headers });
    const body = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      throw new RosterApiError(response.status, errorMessage(body, `Roster request failed (${response.status})`));
    }
    if (typeof body !== "object" || body === null || !("schema" in body)) {
      throw new RosterApiError(response.status, "Roster returned an unversioned response");
    }
    if ((body as { readonly schema?: unknown }).schema !== ROSTER_CONTROL_API_VERSION) {
      throw new RosterApiError(response.status, `Unsupported Roster API version: ${String((body as { readonly schema?: unknown }).schema)}`);
    }
    return body as Value;
  }

  async startRun(input: {
    readonly objective: string;
    readonly workingDirectory: string;
    readonly reviewPolicy?: RosterReviewPolicy;
    readonly workerRuntime?: RosterWorkerRuntime;
  }): Promise<RosterRunSummary> {
    const result = await this.request<{
      readonly schema: typeof ROSTER_CONTROL_API_VERSION;
      readonly runId: string;
      readonly job: WireJob;
    }>("/runs", {
      method: "POST",
      body: JSON.stringify({
        objective: input.objective,
        workingDirectory: input.workingDirectory,
        ...(input.reviewPolicy ? { reviewPolicy: input.reviewPolicy } : {}),
        ...(input.workerRuntime ? { workerRuntime: input.workerRuntime } : {}),
      }),
    });
    return summaryFromJob(result.runId, result.job);
  }

  async getWorkspace(): Promise<RosterWorkspaceSummary> {
    const result = await this.request<{
      readonly schema: typeof ROSTER_CONTROL_API_VERSION;
      readonly workspace: RosterWorkspaceSummary;
    }>("/workspace");
    return result.workspace;
  }

  async scanWorkspace(): Promise<RosterWorkspaceSummary> {
    const result = await this.request<{
      readonly schema: typeof ROSTER_CONTROL_API_VERSION;
      readonly workspace: RosterWorkspaceSummary;
    }>("/workspace/scan", { method: "POST" });
    return result.workspace;
  }

  async listRuns(limit = 10): Promise<RosterRunList> {
    const result = await this.request<{
      readonly schema: typeof ROSTER_CONTROL_API_VERSION;
      readonly runs: ReadonlyArray<{ readonly id: string; readonly job: WireJob }>;
    }>(`/runs?limit=${encodeURIComponent(String(limit))}`);
    return { apiVersion: ROSTER_CONTROL_API_VERSION, runs: result.runs.map((run) => summaryFromJob(run.id, run.job)) };
  }

  async getRun(runId: string): Promise<RosterRunSummary> {
    const result = await this.request<WireRunProjection>(`/runs/${encodeURIComponent(runId)}`);
    return summaryFromProjection(result);
  }

  getDiff(runId: string): Promise<RosterDiff> {
    return this.request(`/diff?runId=${encodeURIComponent(runId)}`);
  }

  steer(runId: string, message: string): Promise<RosterCommandReceipt> {
    return this.request(`/runs/${encodeURIComponent(runId)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message,
        source: { kind: "agent", provider: "pi" },
        tags: ["intent:steer"],
      }),
    });
  }

  abort(runId: string): Promise<RosterCommandReceipt> {
    return this.request(`/runs/${encodeURIComponent(runId)}/abort`, {
      method: "POST",
      body: JSON.stringify({ reason: "Pi operator requested abort" }),
    });
  }
}

export const rosterClientFromEnvironment = (): RosterClient => new RosterClient({
  baseUrl: process.env.ROSTER_API_URL ?? "http://127.0.0.1:8787",
  token: process.env.ROSTER_API_TOKEN,
});

type WireJob = {
  readonly id: string;
  readonly status: string;
  readonly objective?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly reviewPolicy?: RosterReviewPolicy;
  readonly workerRuntime?: RosterWorkerRuntime;
  readonly branch?: string;
  readonly commit?: string;
  readonly error?: string;
};

type WireRunProjection = {
  readonly schema: typeof ROSTER_CONTROL_API_VERSION;
  readonly run: {
    readonly id: string;
    readonly objective?: string;
    readonly branch?: string;
    readonly commit?: string;
  };
  readonly job: WireJob | null;
  readonly tasks: Readonly<Record<string, { readonly taskId?: string; readonly nodeId: string; readonly status: string }>>;
  readonly nodes: Readonly<Record<string, { readonly id: string; readonly name?: string; readonly runtime?: { readonly kind?: string; readonly metadata?: Readonly<Record<string, unknown>> } }>>;
  readonly events: ReadonlyArray<unknown>;
  readonly receiptCount?: number;
  readonly frontier?: RosterRunSummary["frontier"];
  readonly result?: RosterRunSummary["result"];
};

const normalizedStatus = (status: string): RosterRunSummary["status"] => {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "canceled") return "aborted";
  if (status === "queued") return "queued";
  return "running";
};

const summaryFromJob = (runId: string, job: WireJob): RosterRunSummary => ({
  apiVersion: ROSTER_CONTROL_API_VERSION,
  id: runId,
  objective: job.objective ?? "Roster coding run",
  status: normalizedStatus(job.status),
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  jobId: job.id,
  ...(job.reviewPolicy ? { reviewPolicy: job.reviewPolicy } : {}),
  ...(job.workerRuntime ? { workerRuntime: job.workerRuntime } : {}),
  ...(job.branch ? { branch: job.branch } : {}),
  ...(job.commit ? { commit: job.commit } : {}),
  ...(job.error ? { error: job.error } : {}),
});

const taskStatus = (status: string): RosterTaskSummary["status"] => {
  if (status === "completed" || status === "failed" || status === "blocked" || status === "running") return status;
  return "waiting";
};

const summaryFromProjection = (projection: WireRunProjection): RosterRunSummary => {
  const job = projection.job;
  return {
    apiVersion: ROSTER_CONTROL_API_VERSION,
    id: projection.run.id,
    objective: projection.run.objective ?? job?.objective ?? "Roster coding run",
    status: job ? normalizedStatus(job.status) : "running",
    createdAt: job?.createdAt ?? 0,
    updatedAt: job?.updatedAt ?? 0,
    ...(job ? { jobId: job.id } : {}),
    ...(job?.reviewPolicy ? { reviewPolicy: job.reviewPolicy } : {}),
    ...(job?.workerRuntime ? { workerRuntime: job.workerRuntime } : {}),
    ...(projection.run.branch ?? job?.branch ? { branch: projection.run.branch ?? job?.branch } : {}),
    ...(projection.run.commit ?? job?.commit ? { commit: projection.run.commit ?? job?.commit } : {}),
    ...(job?.error ? { error: job.error } : {}),
    ...(projection.frontier ? { frontier: projection.frontier } : {}),
    ...(projection.result ? { result: projection.result } : {}),
    receiptCount: projection.receiptCount ?? projection.events.length,
    tasks: Object.values(projection.tasks).map((task) => {
      const node = projection.nodes[task.nodeId];
      const model = node?.runtime?.metadata?.model;
      return {
        id: task.taskId ?? "task",
        nodeId: task.nodeId,
        ...(node?.name ? { nodeName: node.name } : {}),
        ...(node?.runtime?.kind ? { runtime: node.runtime.kind } : {}),
        ...(typeof model === "string" ? { model } : {}),
        status: taskStatus(task.status),
      };
    }),
  };
};
