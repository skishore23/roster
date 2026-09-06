export const CODING_CLI_API_SCHEMA = "roster.coding.v2" as const;

type JsonRecord = Readonly<Record<string, unknown>>;

export type CodingCliRoom = {
  readonly roomId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly state: string;
  readonly messageCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type CodingCliJob = {
  readonly id: string;
  readonly status: string;
  readonly terminal: boolean;
  readonly objective?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly baselineBranch?: string;
  readonly workerRuntime?: string;
  readonly workerModel?: string;
  readonly noChanges?: boolean;
  readonly error?: string;
  readonly integration?: {
    readonly integrated: boolean;
    readonly canIntegrate: boolean;
    readonly reason?: string;
  };
};

export type CodingCliMessage = {
  readonly messageId: string;
  readonly text: string;
  readonly createdAt: number;
  readonly author: {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
  };
  readonly deliveryState?: string;
};

export type CodingCliTask = {
  readonly taskId: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly status: string;
  readonly objective?: string;
  readonly error?: string;
  readonly dependencies: ReadonlyArray<{ readonly taskId: string; readonly condition?: string }>;
};

export type CodingCliNode = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly specialty?: string;
  readonly runtime?: string;
  readonly model?: string;
};

export type CodingCliRunSnapshot = {
  readonly schema: string;
  readonly realtimeWorkspaceId?: string;
  readonly codingWorkspaceId?: string;
  readonly run: {
    readonly id: string;
    readonly executionId: string;
    readonly repositoryRoot: string;
    readonly objective?: string;
    readonly branch?: string;
    readonly commit?: string;
  };
  readonly conversation: {
    readonly id: string;
    readonly messages: ReadonlyArray<CodingCliMessage>;
    readonly pendingQuestions: ReadonlyArray<string>;
    readonly disposition: string;
  };
  readonly job: CodingCliJob | null;
  readonly tasks: ReadonlyArray<CodingCliTask>;
  readonly nodes: ReadonlyArray<CodingCliNode>;
  readonly acceptedOutputCount: number;
  readonly receiptCount: number;
  readonly frontier?: CodingCliDiff;
  readonly resultSummary?: string;
};

export type CodingCliDiff = {
  readonly summary: string;
  readonly files: ReadonlyArray<{ readonly status: string; readonly path: string }>;
  readonly additions?: number;
  readonly deletions?: number;
  readonly patch?: {
    readonly text: string;
    readonly bytes: number;
    readonly truncated: boolean;
  };
};

export type CodingCliWorkspace = {
  readonly workspaceId: string;
  readonly scanned: boolean;
  readonly repositoryRoot?: string;
  readonly name?: string;
};

export type CodingCliRealtimeSession = {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly conversationId: string;
  readonly executionId: string;
  readonly jobId?: string;
  readonly uri: string;
  readonly database: string;
  readonly confirmedReads: boolean;
  readonly capabilitySecret: string;
  readonly expiresAt: number;
};

export type CodingCliPhase = "idle" | "working" | "attention" | "review" | "done" | "failed";

export type CodingCliClientOptions = {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof fetch;
};

export class CodingCliRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CodingCliRequestError";
  }
}

const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;

const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const boolean = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;
const values = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : [];

const requiredString = (value: unknown, label: string): string => {
  const parsed = string(value)?.trim();
  if (!parsed) throw new Error(`Coding API response is missing ${label}`);
  return parsed;
};

const baseUrl = (raw: string | undefined): URL => {
  const parsed = new URL(raw?.trim() || `http://127.0.0.1:${process.env.PORT ?? "8787"}`);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Roster Coding URL must use http or https");
  }
  if (parsed.username || parsed.password) throw new Error("Roster Coding URL must not contain credentials");
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol === "http:" && !loopback) {
    throw new Error("Roster Coding requires https for non-loopback API URLs");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/u, "");
  return parsed;
};

const roomFrom = (value: unknown): CodingCliRoom => {
  const row = record(value);
  if (!row) throw new Error("Coding room is not an object");
  return {
    roomId: requiredString(row.roomId, "roomId"),
    conversationId: requiredString(row.conversationId, "conversationId"),
    title: requiredString(row.title, "room title"),
    state: string(row.state) ?? "open",
    messageCount: Math.max(0, Math.floor(number(row.messageCount) ?? 0)),
    createdAt: number(row.createdAt) ?? 0,
    updatedAt: number(row.updatedAt) ?? 0,
  };
};

const jobFrom = (value: unknown): CodingCliJob | null => {
  if (value === null || value === undefined) return null;
  const row = record(value);
  if (!row) throw new Error("Coding job is not an object");
  const integration = record(row.integration);
  const error = string(row.error) ?? string(row.canceledReason);
  return {
    id: requiredString(row.id, "job id"),
    status: requiredString(row.status, "job status"),
    terminal: boolean(row.terminal) ?? ["completed", "failed", "canceled"].includes(string(row.status) ?? ""),
    ...(string(row.objective) ? { objective: string(row.objective) } : {}),
    ...(string(row.branch) ? { branch: string(row.branch) } : {}),
    ...(string(row.commit) ? { commit: string(row.commit) } : {}),
    ...(string(row.baselineBranch) ? { baselineBranch: string(row.baselineBranch) } : {}),
    ...(string(row.workerRuntime) ? { workerRuntime: string(row.workerRuntime) } : {}),
    ...(string(row.workerModel) ? { workerModel: string(row.workerModel) } : {}),
    ...(boolean(row.noChanges) !== undefined ? { noChanges: boolean(row.noChanges) } : {}),
    ...(error ? { error } : {}),
    ...(integration ? { integration: {
      integrated: boolean(integration.integrated) ?? false,
      canIntegrate: boolean(integration.canIntegrate) ?? false,
      ...(string(integration.reason) ? { reason: string(integration.reason) } : {}),
    } } : {}),
  };
};

const messageFrom = (value: unknown): CodingCliMessage | undefined => {
  const row = record(value);
  const author = record(row?.author);
  if (!row || !author || !string(row.messageId) || !string(row.text)) return undefined;
  const delivery = record(row.delivery);
  return {
    messageId: requiredString(row.messageId, "message id"),
    text: requiredString(row.text, "message text"),
    createdAt: number(row.createdAt) ?? 0,
    author: {
      id: string(author.id) ?? "unknown",
      name: string(author.name) ?? "Unknown",
      kind: string(author.kind) ?? "agent",
    },
    ...(string(delivery?.state) ? { deliveryState: string(delivery?.state) } : {}),
  };
};

const taskFrom = (value: unknown): CodingCliTask | undefined => {
  const row = record(value);
  if (!row || !string(row.taskId) || !string(row.nodeId) || !string(row.status)) return undefined;
  return {
    taskId: requiredString(row.taskId, "task id"),
    nodeId: requiredString(row.nodeId, "task node"),
    capability: string(row.capability) ?? "work",
    status: requiredString(row.status, "task status"),
    ...(string(row.objective) ? { objective: string(row.objective) } : {}),
    ...(string(row.error) ? { error: string(row.error) } : {}),
    dependencies: values(row.dependencies).flatMap((dependency) => {
      const parsed = record(dependency);
      return parsed && string(parsed.taskId) ? [{
        taskId: requiredString(parsed.taskId, "dependency task id"),
        ...(string(parsed.condition) ? { condition: string(parsed.condition) } : {}),
      }] : [];
    }),
  };
};

const nodeFrom = (value: unknown): CodingCliNode | undefined => {
  const row = record(value);
  if (!row || !string(row.id) || !string(row.name)) return undefined;
  const metadata = record(row.metadata);
  const runtime = record(row.runtime);
  const runtimeMetadata = record(runtime?.metadata);
  return {
    id: requiredString(row.id, "node id"),
    name: requiredString(row.name, "node name"),
    status: string(row.status) ?? "active",
    ...(string(metadata?.specialty) ? { specialty: string(metadata?.specialty) } : {}),
    ...(string(runtime?.kind) ? { runtime: string(runtime?.kind) } : {}),
    ...(string(runtimeMetadata?.model) ? { model: string(runtimeMetadata?.model) } : {}),
  };
};

const diffFrom = (value: unknown): CodingCliDiff => {
  const row = record(value);
  if (!row) throw new Error("Coding diff is not an object");
  const patch = record(row.patch);
  return {
    summary: string(row.summary) ?? "Repository changes",
    files: values(row.files).flatMap((file) => {
      const parsed = record(file);
      return parsed && string(parsed.path) ? [{
        status: string(parsed.status) ?? "M",
        path: requiredString(parsed.path, "changed path"),
      }] : [];
    }),
    ...(number(row.additions) !== undefined ? { additions: number(row.additions) } : {}),
    ...(number(row.deletions) !== undefined ? { deletions: number(row.deletions) } : {}),
    ...(patch ? { patch: {
      text: string(patch.text) ?? "",
      bytes: Math.max(0, number(patch.bytes) ?? 0),
      truncated: boolean(patch.truncated) ?? false,
    } } : {}),
  };
};

const snapshotFrom = (value: unknown): CodingCliRunSnapshot => {
  const row = record(value);
  const run = record(row?.run);
  const conversation = record(row?.conversation);
  if (!row || !run || !conversation) throw new Error("Coding run projection is malformed");
  const taskRows = record(row.tasks) ?? {};
  const nodeRows = record(row.nodes) ?? {};
  const result = record(row.result);
  return {
    schema: string(row.schema) ?? CODING_CLI_API_SCHEMA,
    ...(string(row.realtimeWorkspaceId) ? { realtimeWorkspaceId: string(row.realtimeWorkspaceId) } : {}),
    ...(string(row.codingWorkspaceId) ? { codingWorkspaceId: string(row.codingWorkspaceId) } : {}),
    run: {
      id: requiredString(run.id, "run id"),
      executionId: requiredString(run.executionId, "execution id"),
      repositoryRoot: string(run.repositoryRoot) ?? "",
      ...(string(run.objective) ? { objective: string(run.objective) } : {}),
      ...(string(run.branch) ? { branch: string(run.branch) } : {}),
      ...(string(run.commit) ? { commit: string(run.commit) } : {}),
    },
    conversation: {
      id: requiredString(conversation.id, "conversation id"),
      messages: values(conversation.messages).flatMap((message) => {
        const parsed = messageFrom(message);
        return parsed ? [parsed] : [];
      }),
      pendingQuestions: values(conversation.pendingQuestions).flatMap((question) => string(question) ? [string(question)!] : []),
      disposition: string(conversation.disposition) ?? "unplanned",
    },
    job: jobFrom(row.job),
    tasks: Object.values(taskRows).flatMap((task) => {
      const parsed = taskFrom(task);
      return parsed ? [parsed] : [];
    }),
    nodes: Object.values(nodeRows).flatMap((node) => {
      const parsed = nodeFrom(node);
      return parsed ? [parsed] : [];
    }),
    acceptedOutputCount: Math.max(0, Math.floor(number(row.acceptedOutputCount) ?? 0)),
    receiptCount: Math.max(0, Math.floor(number(row.receiptCount) ?? 0)),
    ...(row.frontier ? { frontier: diffFrom(row.frontier) } : {}),
    ...(string(result?.summary) ? { resultSummary: string(result?.summary) } : {}),
  };
};

export const codingCliPhase = (snapshot: CodingCliRunSnapshot | undefined): CodingCliPhase => {
  if (!snapshot) return "idle";
  if (snapshot.conversation.pendingQuestions.length > 0) return "attention";
  if (!snapshot.job) return snapshot.conversation.disposition === "needs_clarification" ? "attention" : "idle";
  if (snapshot.job.status === "failed" || snapshot.job.status === "canceled") return "failed";
  if (!snapshot.job.terminal) return "working";
  if (snapshot.job.status === "completed" && snapshot.job.commit && !snapshot.job.noChanges
    && !snapshot.job.integration?.integrated) return "review";
  return "done";
};

export class CodingCliClient {
  readonly origin: URL;
  private readonly requestFetch: typeof fetch;
  private readonly token?: string;
  private readonly requestTimeoutMs: number;

  constructor(options: CodingCliClientOptions = {}) {
    this.origin = baseUrl(options.baseUrl ?? process.env.ROSTER_API_URL ?? process.env.ROSTER_URL);
    this.requestFetch = options.fetch ?? fetch;
    this.token = options.token ?? process.env.ROSTER_API_TOKEN;
    const timeout = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
      throw new Error("Roster Coding request timeout must be between 1,000 and 300,000ms");
    }
    this.requestTimeoutMs = timeout;
  }

  private url(pathname: string, query: Readonly<Record<string, string | undefined>> = {}): URL {
    const url = new URL(pathname, this.origin);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
    return url;
  }

  private async request(pathname: string, options: {
    readonly method?: "GET" | "POST";
    readonly query?: Readonly<Record<string, string | undefined>>;
    readonly body?: JsonRecord;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {}): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_800_000) {
      throw new Error("Roster Coding request timeout must be between 1,000 and 1,800,000ms");
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.requestFetch(this.url(pathname, options.query), {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new CodingCliRequestError(
        `Could not reach Roster at ${this.origin.origin}. Run \`roster coding\` to start the local stack, or verify ROSTER_API_URL.`,
        0,
        { origin: this.origin.origin },
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => undefined)
      : await response.text().catch(() => "");
    if (!response.ok) {
      const message = string(record(payload)?.error)
        ?? (typeof payload === "string" && payload.trim() ? payload.trim().slice(0, 2_000) : undefined)
        ?? `Roster Coding request failed (${response.status})`;
      const guidance = response.status === 401
        ? " Verify ROSTER_API_TOKEN, or unset it when the local server was started without API authentication."
        : "";
      throw new CodingCliRequestError(`${message}${guidance}`, response.status, payload);
    }
    return payload;
  }

  async workspace(workspaceId?: string, signal?: AbortSignal): Promise<CodingCliWorkspace> {
    const payload = record(await this.request("/api/v2/coding/workspace", {
      query: { workspace: workspaceId }, signal,
    }));
    const workspace = record(payload?.workspace);
    if (!payload || !workspace) throw new Error("Coding workspace response is malformed");
    return {
      workspaceId: requiredString(payload.workspaceId, "workspace id"),
      scanned: boolean(workspace.scanned) ?? true,
      ...(string(workspace.repositoryRoot) ? { repositoryRoot: string(workspace.repositoryRoot) } : {}),
      ...(string(workspace.name) ? { name: string(workspace.name) } : {}),
    };
  }

  async scanWorkspace(workspaceId?: string, signal?: AbortSignal): Promise<CodingCliWorkspace> {
    const payload = record(await this.request("/api/v2/coding/workspace/scan", {
      method: "POST",
      body: { ...(workspaceId ? { workspaceId } : {}) },
      signal,
      timeoutMs: 20 * 60_000,
    }));
    if (!payload || payload.ok !== true || !record(payload.workspace)) {
      throw new Error("Coding workspace scan response is malformed");
    }
    return this.workspace(workspaceId, signal);
  }

  async rooms(workspaceId?: string, signal?: AbortSignal): Promise<ReadonlyArray<CodingCliRoom>> {
    const payload = record(await this.request("/api/v2/coding/rooms", {
      query: { workspace: workspaceId }, signal,
    }));
    if (!payload) throw new Error("Coding rooms response is malformed");
    return values(payload.rooms).map(roomFrom)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.conversationId.localeCompare(right.conversationId));
  }

  async run(runId: string, jobId?: string, signal?: AbortSignal): Promise<CodingCliRunSnapshot> {
    const snapshot = snapshotFrom(await this.request(`/api/v2/coding/runs/${encodeURIComponent(runId)}`, {
      query: { job: jobId }, signal,
    }));
    if (snapshot.run.id !== runId || snapshot.conversation.id !== runId) {
      throw new Error(`Coding API returned a different conversation for exact selector ${runId}`);
    }
    if (jobId && snapshot.job?.id !== jobId) {
      throw new Error(`Coding API returned ${snapshot.job?.id ?? "no job"} for exact job selector ${jobId}`);
    }
    return snapshot;
  }

  async realtimeSession(
    conversationId: string,
    jobId?: string,
    signal?: AbortSignal,
  ): Promise<CodingCliRealtimeSession> {
    const snapshot = await this.run(conversationId, jobId, signal);
    const exactJobId = jobId ?? snapshot.job?.id;
    if (!exactJobId || snapshot.job?.id !== exactJobId
      || !snapshot.realtimeWorkspaceId || !snapshot.codingWorkspaceId) {
      throw new Error("Coding realtime requires one exact workspace, conversation, job, and execution");
    }
    const payload = record(await this.request("/api/v2/coding/realtime-sessions", {
      method: "POST",
      body: {
        workspaceId: snapshot.codingWorkspaceId,
        conversationId,
        jobId: exactJobId,
        executionId: snapshot.run.executionId,
      },
      signal,
    }));
    if (!payload) throw new Error("Coding realtime session response is malformed");
    const selectedConversationId = requiredString(payload.conversationId, "realtime conversation id");
    const selectedJobId = string(payload.jobId);
    if (selectedConversationId !== conversationId || selectedJobId !== exactJobId
      || payload.workspaceId !== snapshot.codingWorkspaceId
      || payload.controlWorkspaceId !== snapshot.realtimeWorkspaceId
      || payload.executionId !== snapshot.run.executionId) {
      throw new Error("Coding realtime session changed the exact conversation or job selector");
    }
    const expiresAt = number(payload.expiresAt);
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      throw new Error("Coding realtime session is already expired");
    }
    return {
      sessionId: requiredString(payload.sessionId, "realtime session id"),
      workspaceId: requiredString(payload.workspaceId, "realtime workspace id"),
      roomId: requiredString(payload.roomId, "realtime room id"),
      conversationId: selectedConversationId,
      executionId: requiredString(payload.executionId, "realtime execution id"),
      ...(selectedJobId ? { jobId: selectedJobId } : {}),
      uri: requiredString(payload.uri, "realtime uri"),
      database: requiredString(payload.database, "realtime database"),
      confirmedReads: boolean(payload.confirmedReads) ?? false,
      capabilitySecret: requiredString(payload.capabilitySecret, "realtime capability"),
      expiresAt,
    };
  }

  async create(input: {
    readonly objective: string;
    readonly workspaceId?: string;
    readonly reviewPolicy?: "auto" | "fast" | "reviewed";
    readonly workerRuntime?: "claude-code" | "codex-cli" | "pi-agent" | "hermes-agent";
  }, signal?: AbortSignal): Promise<JsonRecord> {
    const payload = record(await this.request("/api/v2/coding/runs", {
      method: "POST",
      body: {
        objective: input.objective,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        reviewPolicy: input.reviewPolicy ?? "auto",
        ...(input.workerRuntime ? { workerRuntime: input.workerRuntime } : {}),
        source: { kind: "api", provider: "roster-cli" },
      },
      signal,
    }));
    if (!payload) throw new Error("Coding run response is malformed");
    return payload;
  }

  async message(input: {
    readonly runId: string;
    readonly message: string;
    readonly workspaceId?: string;
    readonly reviewPolicy?: "auto" | "fast" | "reviewed";
  }, signal?: AbortSignal): Promise<JsonRecord> {
    const payload = record(await this.request(`/api/v2/coding/runs/${encodeURIComponent(input.runId)}/messages`, {
      method: "POST",
      body: {
        message: input.message,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        reviewPolicy: input.reviewPolicy ?? "auto",
        source: { kind: "api", provider: "roster-cli" },
      },
      signal,
    }));
    if (!payload) throw new Error("Coding message response is malformed");
    return payload;
  }

  async diff(runId: string, jobId: string, signal?: AbortSignal): Promise<CodingCliDiff> {
    return diffFrom(await this.request("/api/v2/coding/diff", {
      query: { runId, job: jobId }, signal,
    }));
  }

  async integrate(runId: string, jobId: string, signal?: AbortSignal): Promise<JsonRecord> {
    const payload = record(await this.request(`/api/v2/coding/runs/${encodeURIComponent(runId)}/integrate`, {
      method: "POST", body: { jobId }, signal,
    }));
    if (!payload) throw new Error("Coding integration response is malformed");
    return payload;
  }

  async abort(runId: string, input: { readonly jobId: string; readonly reason: string }, signal?: AbortSignal): Promise<JsonRecord> {
    const payload = record(await this.request(`/api/v2/coding/runs/${encodeURIComponent(runId)}/abort`, {
      method: "POST",
      body: { jobId: input.jobId, reason: input.reason },
      signal,
    }));
    if (!payload) throw new Error("Coding abort response is malformed");
    return payload;
  }

  async retry(runId: string, jobId: string, signal?: AbortSignal): Promise<JsonRecord> {
    const payload = record(await this.request(`/api/v2/coding/runs/${encodeURIComponent(runId)}/retry`, {
      method: "POST", body: { jobId }, signal,
    }));
    if (!payload) throw new Error("Coding retry response is malformed");
    return payload;
  }

  async close(runId: string, jobId: string, signal?: AbortSignal): Promise<JsonRecord> {
    const payload = record(await this.request(`/api/v2/coding/runs/${encodeURIComponent(runId)}/close`, {
      method: "POST", body: { jobId }, signal,
    }));
    if (!payload) throw new Error("Coding close response is malformed");
    return payload;
  }

  async collaborationRecord(runId: string, jobId: string, signal?: AbortSignal): Promise<string> {
    const payload = await this.request(`/api/v2/coding/runs/${encodeURIComponent(runId)}/collaboration.md`, {
      query: { job: jobId }, signal,
    });
    if (typeof payload !== "string") throw new Error("Coding collaboration record is malformed");
    return payload;
  }

  async *watch(input: {
    readonly runId: string;
    readonly jobId?: string;
    readonly intervalMs?: number;
    readonly signal?: AbortSignal;
  }): AsyncGenerator<CodingCliRunSnapshot> {
    const { watchCodingRealtime } = await import("./coding-realtime.js");
    yield* watchCodingRealtime({
      client: this,
      conversationId: input.runId,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      coalesceMs: input.intervalMs,
      signal: input.signal,
    });
  }
}
