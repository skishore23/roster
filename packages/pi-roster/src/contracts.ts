export const ROSTER_CONTROL_API_VERSION = "roster.coding.v2" as const;
export const ROSTER_CONTROL_MEDIA_TYPE = "application/json";

export type RosterRunStatus =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "aborted";

export type RosterReviewPolicy = "auto" | "fast" | "reviewed";
export type RosterWorkerRuntime = "claude-code" | "codex-cli" | "pi-agent" | "hermes-agent";

export type RosterWorkspaceSummary = {
  readonly scanned: boolean;
  readonly repositoryRoot: string;
  readonly fingerprint?: string;
  readonly fileCount?: number;
  readonly filesTruncated?: boolean;
  readonly technologies?: ReadonlyArray<string>;
  readonly reviewedAt?: number;
  readonly nodes?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly capabilities: ReadonlyArray<string>;
    readonly runtime?: string;
    readonly specialty?: string;
    readonly reason?: string;
  }>;
};

export type RosterTaskSummary = {
  readonly id: string;
  readonly name?: string;
  readonly nodeId: string;
  readonly nodeName?: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly status: "waiting" | "running" | "completed" | "failed" | "blocked";
};

export type RosterRunSummary = {
  readonly apiVersion: typeof ROSTER_CONTROL_API_VERSION;
  readonly id: string;
  readonly objective: string;
  readonly status: RosterRunStatus;
  readonly createdAt: string | number;
  readonly updatedAt: string | number;
  readonly jobId?: string;
  readonly workingDirectory?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly reviewPolicy?: RosterReviewPolicy;
  readonly workerRuntime?: RosterWorkerRuntime;
  readonly tasks?: ReadonlyArray<RosterTaskSummary>;
  readonly receiptCount?: number;
  readonly frontier?: {
    readonly hash?: string;
    readonly summary?: string;
    readonly changedFiles?: number;
    readonly insertions?: number;
    readonly deletions?: number;
    readonly certified?: boolean;
    readonly files?: ReadonlyArray<{ readonly status: string; readonly path: string }>;
    readonly patchBytes?: number;
    readonly truncated?: boolean;
  };
  readonly result?: {
    readonly status?: string;
    readonly summary?: string;
    readonly changedFiles?: ReadonlyArray<string>;
    readonly validation?: ReadonlyArray<string>;
    readonly frontierHash?: string;
  };
  readonly error?: string;
};

export type RosterRunList = {
  readonly apiVersion: typeof ROSTER_CONTROL_API_VERSION;
  readonly runs: ReadonlyArray<RosterRunSummary>;
};

export type RosterDiff = {
  readonly schema: typeof ROSTER_CONTROL_API_VERSION;
  readonly repositoryRoot: string;
  readonly scope?: "checkout" | "run";
  readonly runId?: string;
  readonly dirty: boolean;
  readonly summary: string;
  readonly files: ReadonlyArray<{ readonly status: string; readonly path: string }>;
  readonly truncated: boolean;
  readonly patch: {
    readonly text: string;
    readonly bytes: number;
    readonly maxBytes: number;
    readonly truncated: boolean;
  };
};

export type RosterCommandReceipt = {
  readonly schema: typeof ROSTER_CONTROL_API_VERSION;
  readonly runId: string;
  readonly jobId: string;
  readonly command: unknown;
  readonly ok: boolean;
};

export type RosterSessionAttachment = {
  readonly apiVersion: typeof ROSTER_CONTROL_API_VERSION;
  readonly runId: string;
  readonly baseUrl: string;
};

export const terminalRosterRunStatus = (status: RosterRunStatus): boolean =>
  status === "completed" || status === "failed" || status === "aborted";
