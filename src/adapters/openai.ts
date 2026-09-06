// ============================================================================
// OpenAI adapter - minimal text generation (no tools)
// ============================================================================

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { boundedFiniteInteger } from "../core/numbers.js";
import type { LlmTextRequest, ModelUsage } from "../engine/runtime/model.js";
import { DEFAULT_OPENAI_MODEL } from "../models.js";

const defaultModel = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
let client: OpenAI | null = null;
let rateLimitUntil = 0;

export const openAIRequestLimits = (env: NodeJS.ProcessEnv = process.env) => ({
  maxOutputTokens: boundedFiniteInteger(env.OPENAI_MAX_OUTPUT_TOKENS, 4_096, 64, 128_000),
  maxRetries: boundedFiniteInteger(env.OPENAI_SDK_MAX_RETRIES, 1, 0, 10),
  timeoutMs: boundedFiniteInteger(env.OPENAI_TIMEOUT_MS, 120_000, 1_000, 600_000),
});

export const openAIRetryLimits = (env: NodeJS.ProcessEnv = process.env) => ({
  maxRetries: boundedFiniteInteger(env.OPENAI_MAX_RETRIES, 3, 0, 10),
  baseDelayMs: boundedFiniteInteger(env.OPENAI_RETRY_BASE_MS, 500, 0, 60_000),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const isRetryableOpenAIRateLimit = (err: unknown): boolean => {
  const anyErr = err as {
    status?: number;
    code?: number | string;
    type?: string;
    name?: string;
    message?: string;
  } | undefined;
  if (!anyErr) return false;
  const description = [
    anyErr.code,
    anyErr.type,
    anyErr.name,
    anyErr.message,
  ].filter((value) => value !== undefined).map(String).join(" ");
  // OpenAI reports hard quota and billing failures with HTTP 429 as well.
  // Retrying those responses only delays the durable failure and can make a
  // configuration incident look like transient provider contention.
  if (
    /insufficient[_ -]?quota|billing|hard[_ -]?limit|quota (?:is )?(?:exhausted|exceeded)|exceeded (?:your )?(?:current )?quota/i
      .test(description)
  ) {
    return false;
  }
  if (anyErr.status === 429 || anyErr.code === 429) return true;
  if (typeof anyErr.name === "string" && /ratelimit/i.test(anyErr.name)) return true;
  if (/rate.?limit/i.test(description)) return true;
  return false;
};

const parseRetryMs = (value?: string | null): number | null => {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v.endsWith("ms")) {
    const ms = Number.parseFloat(v.slice(0, -2));
    return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null;
  }
  if (v.endsWith("s")) {
    const s = Number.parseFloat(v.slice(0, -1));
    return Number.isFinite(s) ? Math.max(0, Math.round(s * 1000)) : null;
  }
  const num = Number.parseFloat(v);
  if (!Number.isFinite(num)) return null;
  return num >= 1000 ? Math.round(num) : Math.round(num * 1000);
};

const extractRetryDelayMs = (err: unknown): number | null => {
  const anyErr = err as { message?: string; headers?: { get?: (k: string) => string | null } } | undefined;
  const msg = typeof anyErr?.message === "string" ? anyErr.message : "";
  const msgMatch = msg.match(/try again in (\d+)ms/i);
  if (msgMatch) return Number.parseInt(msgMatch[1], 10);
  const headers = anyErr?.headers;
  if (headers?.get) {
    const retryMs = parseRetryMs(headers.get("retry-after-ms"));
    if (retryMs !== null) return retryMs;
    const retryAfter = parseRetryMs(headers.get("retry-after"));
    if (retryAfter !== null) return retryAfter;
    const resetTokens = parseRetryMs(headers.get("x-ratelimit-reset-tokens"));
    if (resetTokens !== null) return resetTokens;
    const resetReqs = parseRetryMs(headers.get("x-ratelimit-reset-requests"));
    if (resetReqs !== null) return resetReqs;
  }
  return null;
};

const withRateLimitRetry = async <T>(op: () => Promise<T>): Promise<T> => {
  const { maxRetries, baseDelayMs } = openAIRetryLimits();
  let attempt = 0;
  while (true) {
    const now = Date.now();
    if (rateLimitUntil > now) {
      await sleep(rateLimitUntil - now);
    }
    try {
      return await op();
    } catch (err) {
      if (!isRetryableOpenAIRateLimit(err) || attempt >= maxRetries) throw err;
      attempt += 1;
      const retryMs = extractRetryDelayMs(err);
      const backoff = retryMs ?? Math.min(8_000, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 200);
      const waitMs = Math.max(0, Math.min(60_000, backoff + jitter));
      rateLimitUntil = Math.max(rateLimitUntil, Date.now() + waitMs);
      await sleep(waitMs);
    }
  }
};

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY missing");
    const limits = openAIRequestLimits();
    client = new OpenAI({ apiKey, maxRetries: limits.maxRetries, timeout: limits.timeoutMs });
  }
  return client;
}

// ============================================================================
// Embeddings
// ============================================================================

export const embed = async (texts: ReadonlyArray<string>): Promise<ReadonlyArray<ReadonlyArray<number>>> => {
  return withRateLimitRetry(async () => {
    const response = await getClient().embeddings.create({
      model: "text-embedding-3-small",
      input: texts as string[],
    });
    return response.data.map((d) => d.embedding);
  });
};

// ============================================================================
// Text Generation
// ============================================================================

export type LlmTextOptions = LlmTextRequest & {
  readonly onDelta?: (delta: string) => void | Promise<void>;
};

export type LlmStructuredOptions<Schema extends z.ZodTypeAny> = {
  /** Optional per-call routing override for heterogeneous agent teams. */
  readonly model?: string;
  /** Durable trace identifier forwarded to OpenAI for timeout reconciliation. */
  readonly requestId?: string;
  /** Optional role-specific ceiling for larger structured responses. */
  readonly maxOutputTokens?: number;
  readonly system?: string;
  readonly user: string;
  readonly images?: ReadonlyArray<{
    readonly dataUrl: string;
    readonly detail?: "low" | "high" | "auto";
  }>;
  readonly schema: Schema;
  readonly schemaName: string;
};

export type LlmStructuredResult<T> = {
  readonly parsed: T;
  readonly raw: string;
  readonly usage?: ModelUsage;
};

export type LlmStructured = <Schema extends z.ZodTypeAny>(
  opts: LlmStructuredOptions<Schema>
) => Promise<LlmStructuredResult<z.infer<Schema>>>;

export const llmText = async (opts: LlmTextOptions): Promise<string> => {
  return withRateLimitRetry(async () => {
    const limits = openAIRequestLimits();
    const stream = getClient().responses.stream({
      model: opts.model?.trim() || defaultModel,
      instructions: opts.system,
      input: opts.user,
      max_output_tokens: limits.maxOutputTokens,
    });

    let text = "";
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        if (!event.delta) continue;
        text += event.delta;
        if (opts.onDelta) await opts.onDelta(event.delta);
      } else if (event.type === "response.output_text.done") {
        text = event.text;
      }
    }

    const response = await stream.finalResponse();
    if (opts.onUsage && response.usage) {
      const usage: ModelUsage = {
        model: response.model,
        inputTokens: response.usage.input_tokens,
        cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: response.usage.output_tokens,
        reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
        totalTokens: response.usage.total_tokens,
      };
      await opts.onUsage(usage);
    }
    return response.output_text?.trim() ?? text.trim();
  });
};

export const llmStructured = async <Schema extends z.ZodTypeAny>(
  opts: LlmStructuredOptions<Schema>
): Promise<LlmStructuredResult<z.infer<Schema>>> => {
  return withRateLimitRetry(async () => {
    const limits = openAIRequestLimits();
    const maxOutputTokens = opts.maxOutputTokens === undefined
      ? limits.maxOutputTokens
      : Math.max(64, Math.min(128_000, Math.floor(opts.maxOutputTokens)));
    const input = opts.images && opts.images.length > 0
      ? [{
          role: "user" as const,
          content: [
            { type: "input_text" as const, text: opts.user },
            ...opts.images.map((image) => ({
              type: "input_image" as const,
              image_url: image.dataUrl,
              detail: image.detail ?? "high" as const,
            })),
          ],
        }]
      : opts.user;
    const response = await getClient().responses.parse(
      {
        model: opts.model?.trim() || defaultModel,
        instructions: opts.system,
        input,
        max_output_tokens: maxOutputTokens,
        text: {
          format: zodTextFormat(opts.schema, opts.schemaName),
        },
      },
      opts.requestId
        ? { headers: { "X-Client-Request-Id": opts.requestId } }
        : undefined
    );

    const raw = response.output_text?.trim() ?? "";
    if (response.output_parsed === null) {
      throw new Error(raw ? `Model returned no structured output: ${raw}` : "Model returned no structured output");
    }

    return {
      parsed: response.output_parsed,
      raw,
      usage: response.usage ? {
        model: response.model,
        inputTokens: response.usage.input_tokens,
        cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: response.usage.output_tokens,
        reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  });
};
