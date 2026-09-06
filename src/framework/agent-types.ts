import type { Hono } from "hono";

import type { LlmStructured, LlmTextOptions } from "../adapters/openai.js";
import type { EnqueueJobInput, JobQueue } from "../engine/runtime/job-queue.js";
import type { ModernAgentSpec } from "../engine/runtime/agent-loop.js";
import type { ReceiptDeclaration } from "../sdk/receipt.js";

export type AgentRouteModule = {
  readonly id: string;
  readonly kind?: string;
  readonly paths?: Readonly<Record<string, string>>;
  readonly register: (app: Hono) => void;
};

export type HeadlessAgentSpec = ModernAgentSpec<
  Readonly<Record<string, ReceiptDeclaration<unknown>>>,
  unknown,
  Record<string, unknown>
>;

export type HeadlessAgentRequest = {
  readonly spec: HeadlessAgentSpec;
  readonly problem: string;
  readonly runId?: string;
  readonly stream?: string;
  readonly runStream?: string;
};

export type HeadlessAgentResult = {
  readonly runId: string;
  readonly stream: string;
  readonly runStream: string;
};

/** A normalized, server-discoverable agent module. */
export type DiscoveredAgentModule = AgentRouteModule & ({
  readonly moduleType: "application";
} | {
  readonly moduleType: "headless";
  readonly spec: HeadlessAgentSpec;
});

type DependencyTable = Readonly<Record<string, unknown>>;

export type AgentLoaderContextInput = {
  readonly llmText: (opts: LlmTextOptions) => Promise<string>;
  readonly llmStructured: LlmStructured;
  readonly enqueueJob: (job: EnqueueJobInput) => Promise<void>;
  readonly queue: JobQueue;
  readonly runtimes: DependencyTable;
  readonly prompts: DependencyTable;
  readonly promptHashes: Readonly<Record<string, string>>;
  readonly promptPaths: Readonly<Record<string, string>>;
  readonly models: Readonly<Record<string, string>>;
  readonly helpers?: DependencyTable;
  readonly runHeadlessAgent?: (input: HeadlessAgentRequest) => Promise<HeadlessAgentResult>;
};

export type AgentLoaderContext = Omit<AgentLoaderContextInput, "runtimes" | "prompts" | "helpers"> & {
  /** Resolve a required runtime with a useful startup error instead of an unsafe cast. */
  readonly runtime: <T>(id: string) => T;
  /** Resolve required prompt configuration with a useful startup error. */
  readonly prompt: <T>(id: string) => T;
  /** Resolve an optional helper and validate it without coupling the loader to its class. */
  readonly helper: <T>(id: string, guard: (value: unknown) => value is T) => T | undefined;
};

const required = <T>(table: DependencyTable, category: string, id: string): T => {
  if (!Object.prototype.hasOwnProperty.call(table, id)) {
    throw new Error(`Missing agent ${category} dependency '${id}'`);
  }
  return table[id] as T;
};

export const createAgentLoaderContext = (input: AgentLoaderContextInput): AgentLoaderContext => {
  const { runtimes, prompts, helpers, ...publicInput } = input;
  return {
    ...publicInput,
    runtime: <T>(id: string): T => required<T>(runtimes, "runtime", id),
    prompt: <T>(id: string): T => required<T>(prompts, "prompt", id),
    helper: <T>(id: string, guard: (value: unknown) => value is T): T | undefined => {
      const value = helpers?.[id];
      return guard(value) ? value : undefined;
    },
  };
};

export type AgentModuleFactory = (ctx: AgentLoaderContext) => AgentRouteModule;

export type AgentModule = {
  readonly default: AgentModuleFactory | AgentRouteModule | HeadlessAgentSpec;
};
