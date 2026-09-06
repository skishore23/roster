export type ModelUsage = {
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
};

export type LlmTextRequest = {
  /** Optional per-call routing override for heterogeneous agent workloads. */
  readonly model?: string;
  readonly system?: string;
  readonly user: string;
  readonly onUsage?: (usage: ModelUsage) => void | Promise<void>;
};

export type LlmText = (request: LlmTextRequest) => Promise<string>;
