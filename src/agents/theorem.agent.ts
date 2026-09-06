import { randomBytes } from "node:crypto";

import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import type { LlmTextOptions } from "../adapters/openai.js";
import { fold } from "../core/chain.js";
import type { Runtime } from "../core/runtime.js";
import type { Chain } from "../core/types.js";
import { DEFAULT_OPENAI_MODEL } from "../models.js";
import type { TheoremCmd, TheoremEvent, TheoremState } from "../modules/theorem.js";
import { reduce as reduceTheorem, initial as initialTheorem } from "../modules/theorem.js";
import {
  THEOREM_EXAMPLES,
  getLatestTheoremRunId,
  normalizeTheoremConfig,
  parseTheoremConfig,
  runTheoremRoster,
  sliceTheoremChainByStep,
} from "./theorem.js";
import { theoremRunStream } from "./theorem.streams.js";
import { theoremShell } from "../views/theorem.js";
import { html, makeEventId, parseAt, parseBranch, text, toFormRecord } from "../framework/http.js";
import { theoremRunFormSchema } from "../framework/schemas.js";
import type { AgentLoaderContext, AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import type { RuntimeOp } from "../framework/translators.js";
import { executeRuntimeOps } from "../framework/translators.js";
import type { EnqueueJobInput } from "../engine/runtime/job-queue.js";
import { SpacetimeWebAccess } from "../adapters/spacetimedb-web-access.js";

type TheoremRouteDeps = {
  readonly runtime: Runtime<TheoremCmd, TheoremEvent, TheoremState>;
  readonly llmText: (opts: LlmTextOptions) => Promise<string>;
  readonly prompts: Parameters<typeof runTheoremRoster>[0]["prompts"];
  readonly promptHash: string;
  readonly promptPath: string;
  readonly model: string;
  readonly enqueueJob: (job: EnqueueJobInput) => Promise<void>;
  readonly webAccess?: SpacetimeWebAccess;
};

type TheoremRouteUiConfig = {
  readonly routeId?: string;
  readonly basePath?: string;
  readonly defaultStream?: string;
  readonly jobAgentId?: string;
  readonly jobKind?: string;
  readonly jobIdPrefix?: string;
  readonly title?: string;
  readonly brand?: string;
  readonly brandSub?: string;
  readonly controlsTitle?: string;
  readonly controlsSub?: string;
  readonly runButtonLabel?: string;
  readonly examples?: ReadonlyArray<{ id: string; label: string; problem: string }>;
};

type TheoremRunStartIntent = {
  readonly stream: string;
  readonly runId: string;
  readonly runStream: string;
  readonly sourceStream: string;
  readonly sourceChain: Chain<TheoremEvent>;
  readonly at: number | null;
  readonly append?: string;
  readonly resolvedProblem: string;
  readonly config: ReturnType<typeof parseTheoremConfig>;
  readonly resumeRequested: boolean;
};

type TheoremRunStartIntentOptions = {
  readonly basePath?: string;
  readonly jobAgentId?: string;
  readonly jobKind?: string;
  readonly jobIdPrefix?: string;
};

const mergeTimelineChains = <T extends { readonly id: string; readonly ts: number; readonly stream: string }>(
  chains: ReadonlyArray<ReadonlyArray<T>>
) => {
  const merged = chains.flatMap((chain) => chain);
  merged.sort((a, b) => a.ts - b.ts || a.stream.localeCompare(b.stream) || a.id.localeCompare(b.id));
  return merged;
};

const normalizeBasePath = (value?: string): string => {
  const raw = (value ?? "/theorem").trim();
  if (!raw) return "/theorem";
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
};

const normalizeTheoremRouteUiConfig = (config?: TheoremRouteUiConfig): Required<TheoremRouteUiConfig> => ({
  routeId: config?.routeId ?? "theorem",
  basePath: normalizeBasePath(config?.basePath),
  defaultStream: config?.defaultStream ?? "agents/theorem",
  jobAgentId: config?.jobAgentId ?? "theorem",
  jobKind: config?.jobKind ?? "theorem.run",
  jobIdPrefix: config?.jobIdPrefix ?? config?.routeId ?? "theorem",
  title: config?.title ?? "Roster - Adaptive Proof",
  brand: config?.brand ?? "Roster",
  brandSub: config?.brandSub ?? "Adaptive topology / proof search",
  controlsTitle: config?.controlsTitle ?? "Adaptive proof coordination",
  controlsSub: config?.controlsSub ?? "Dynamic population, reflection, rebracketing, and certified composition.",
  runButtonLabel: config?.runButtonLabel ?? "Run",
  examples: config?.examples ?? THEOREM_EXAMPLES,
});

const isRunOrBranchStream = (runStream: string, candidate: string): boolean =>
  candidate === runStream || candidate.startsWith(`${runStream}/branches/`);

export const resolveTheoremResumeAnchor = (
  displayChain: Chain<TheoremEvent>,
  runStream: string,
  at: number | null,
): { readonly stream: string; readonly hash: string } | undefined => {
  if (at === null) return undefined;
  const viewChain = sliceTheoremChainByStep(displayChain, at);
  const anchor = viewChain[viewChain.length - 1];
  if (!anchor) return undefined;
  if (!isRunOrBranchStream(runStream, anchor.stream)) return undefined;
  return { stream: anchor.stream, hash: anchor.hash };
};

const translateTheoremRunStartIntentInternal = (
  intent: TheoremRunStartIntent,
  opts?: TheoremRunStartIntentOptions
): ReadonlyArray<RuntimeOp<TheoremCmd>> => {
  const basePath = normalizeBasePath(opts?.basePath);
  const jobAgentId = opts?.jobAgentId ?? "theorem";
  const jobKind = opts?.jobKind ?? "theorem.run";
  const jobIdPrefix = opts?.jobIdPrefix ?? "theorem";
  const ops: RuntimeOp<TheoremCmd>[] = [];
  let runStreamOverride: string | undefined;
  let forkedBranch: string | undefined;
  const queuedProblem = intent.append ? `${intent.resolvedProblem}\n\n${intent.append}` : intent.resolvedProblem;
  const queueJobId = `${jobIdPrefix}_${intent.runId}_${Date.now().toString(36)}`;

  if (intent.resumeRequested && intent.sourceChain.length > 0) {
    const forkSlice = intent.at === null ? intent.sourceChain : sliceTheoremChainByStep(intent.sourceChain, intent.at);
    const forkAt = forkSlice.length;
    const branchId = `resume_${Date.now().toString(36)}_${forkAt}`;
    const branchStream = `${intent.runStream}/branches/${branchId}`;
    ops.push({ type: "fork", stream: intent.sourceStream, at: forkAt, newName: branchStream });

    const noteBits = [
      "resume fork",
      intent.sourceStream !== intent.runStream ? `from ${intent.sourceStream}` : "",
      intent.at !== null ? `at step ${intent.at}` : "",
    ].filter(Boolean);
    ops.push({
      type: "emit",
      stream: intent.runStream,
      cmd: {
        type: "emit",
        eventId: makeEventId(intent.runStream),
        event: {
          type: "branch.created",
          runId: intent.runId,
          branchId: branchStream,
          forkAt,
          note: noteBits.join(" "),
        },
      },
    });
    runStreamOverride = branchStream;
    forkedBranch = branchStream;
  }

  if (intent.append && runStreamOverride) {
    ops.push({
      type: "emit",
      stream: runStreamOverride,
      cmd: {
        type: "emit",
        eventId: makeEventId(runStreamOverride),
        event: { type: "problem.appended", runId: intent.runId, append: intent.append, agentId: "orchestrator" },
      },
    });
  }

  ops.push({
    type: "enqueue_job",
    job: {
      jobId: queueJobId,
      agentId: jobAgentId,
      lane: "collect",
      sessionKey: `${jobAgentId}:${intent.stream}`,
      singletonMode: "cancel",
      maxAttempts: 2,
      payload: {
        kind: jobKind,
        stream: intent.stream,
        runId: intent.runId,
        runStream: runStreamOverride,
        problem: queuedProblem,
        config: intent.config,
      },
    },
  });

  const redirectParams = new URLSearchParams({ stream: intent.stream, run: intent.runId });
  if (forkedBranch) redirectParams.set("branch", forkedBranch);
  redirectParams.set("job", queueJobId);
  ops.push({ type: "redirect", header: "Location", url: `${basePath}?${redirectParams.toString()}` });

  return ops;
};

export const translateTheoremRunStartIntent = (
  intent: TheoremRunStartIntent
): ReadonlyArray<RuntimeOp<TheoremCmd>> =>
  translateTheoremRunStartIntentInternal(intent);

export const createTheoremRoute = (deps: TheoremRouteDeps, ui?: TheoremRouteUiConfig): AgentRouteModule => {
  const { runtime, enqueueJob } = deps;
  const uiConfig = normalizeTheoremRouteUiConfig(ui);
  const basePath = uiConfig.basePath;
  const defaultStream = uiConfig.defaultStream;

  const loadTheoremDescendantChains = async (rootStream: string) => {
    const out: Array<{ readonly name: string; readonly forkAt: number; readonly chain: Awaited<ReturnType<typeof runtime.chain>> }> = [];
    const queue: string[] = [rootStream];

    while (queue.length > 0) {
      const parent = queue.shift();
      if (!parent) break;
      const children = await runtime.children(parent);
      for (const child of children) {
        const chain = await runtime.chain(child.name);
        out.push({
          name: child.name,
          forkAt: Math.max(0, child.forkAt ?? 0),
          chain,
        });
        queue.push(child.name);
      }
    }

    return out;
  };

  const buildTheoremDisplayChain = async (
    baseStream: string,
    runId: string
  ): Promise<Awaited<ReturnType<typeof runtime.chain>>> => {
    const runStream = theoremRunStream(baseStream, runId);
    const runChain = await runtime.chain(runStream);
    const descendants = await loadTheoremDescendantChains(runStream);
    const branchDeltas = descendants.map((desc) => desc.chain.slice(desc.forkAt));
    return mergeTimelineChains([runChain, ...branchDeltas]);
  };

  return {
    id: uiConfig.routeId,
    kind: "run",
    paths: {
      shell: basePath,
      run: `${basePath}/run`,
    },
    register: (app: Hono) => {
      app.get(basePath, async (c) => {
        const stream = c.req.query("stream") ?? defaultStream;
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const chain = await runtime.chain(stream);
        const latest = getLatestTheoremRunId(chain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        const runStream = activeRun ? theoremRunStream(stream, activeRun) : undefined;
        const nonce = randomBytes(18).toString("base64");
        return html(theoremShell(
          stream,
          uiConfig.examples,
          activeRun,
          wantsEmpty ? null : at,
          branchParam ?? undefined,
          {
            ...uiConfig,
            realtime: deps.webAccess
              ? {
                  boot: deps.webAccess.boot({
                    domain: basePath === "/axiom" ? "axiom" : "theorem",
                    stream,
                    runId: activeRun,
                    runStream,
                    branchStream: branchParam ?? undefined,
                  }),
                  nonce,
                }
              : undefined,
          }
        ));
      });

      app.post(
        `${basePath}/run`,
        zValidator("form", theoremRunFormSchema, (result) => {
          if (!result.success) return text(400, "problem required");
        }),
        async (c) => {
        const stream = c.req.query("stream") ?? defaultStream;
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const at = parseAt(c.req.query("at"));
        const formRaw = toFormRecord(c.req.valid("form"));

        const problem = formRaw.problem?.trim();
        const append = formRaw.append?.trim();
        const runId = runParam?.trim().length ? runParam.trim() : `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const runStream = theoremRunStream(stream, runId);
        const branchPrefix = `${runStream}/branches/`;
        let sourceStream = runStream;
        let sourceChain = await runtime.chain(runStream);
        let resumeAt = at;
        if (branchParam && branchParam.startsWith(branchPrefix)) {
          const branchChain = await runtime.chain(branchParam);
          if (branchChain.length > 0) {
            sourceStream = branchParam;
            sourceChain = branchChain;
          }
        }

        if (runParam?.trim().length && at !== null) {
          const displayChain = sourceStream === runStream
            ? await buildTheoremDisplayChain(stream, runId)
            : sourceChain;
          const anchor = resolveTheoremResumeAnchor(displayChain, runStream, at);
          if (anchor) {
            const anchorChain = await runtime.chain(anchor.stream);
            const anchorIndex = anchorChain.findIndex((receipt) => receipt.hash === anchor.hash);
            if (anchorIndex >= 0) {
              sourceStream = anchor.stream;
              sourceChain = anchorChain.slice(0, anchorIndex + 1);
              resumeAt = null;
            }
          }
          if (resumeAt !== null) {
            sourceChain = sliceTheoremChainByStep(sourceChain, at);
            resumeAt = null;
          }
        }

        const existingState = sourceChain.length > 0 ? fold(sourceChain, reduceTheorem, initialTheorem) : undefined;
        const resolvedProblem = existingState?.problem || problem || "";
        if (!resolvedProblem) return text(400, "problem required");

        const hasConfigInput = formRaw.rounds !== undefined
          || formRaw.depth !== undefined
          || formRaw.memory !== undefined
          || formRaw.branch !== undefined
          || formRaw.concurrency !== undefined;
        let config = parseTheoremConfig(formRaw);
        if (!hasConfigInput && existingState?.config) {
          config = normalizeTheoremConfig({
            rounds: existingState.config.rounds,
            maxDepth: existingState.config.depth,
            memoryWindow: existingState.config.memoryWindow,
            branchThreshold: existingState.config.branchThreshold,
            maxParallel: existingState.config.maxParallel,
          });
        }

        const ops = translateTheoremRunStartIntentInternal({
          stream,
          runId,
          runStream,
          sourceStream,
          sourceChain,
          at: resumeAt,
          append,
          resolvedProblem,
          config,
          resumeRequested: Boolean(runParam?.trim().length),
        }, {
          basePath,
          jobAgentId: uiConfig.jobAgentId,
          jobKind: uiConfig.jobKind,
          jobIdPrefix: uiConfig.jobIdPrefix,
        });

        const redirect = await executeRuntimeOps(ops, {
          fork: async (op) => {
            await runtime.fork(op.stream, op.at, op.newName);
          },
          emit: async (op) => {
            await runtime.execute(op.stream, op.cmd);
          },
          startRun: async () => {},
          enqueueJob: async (op) => {
            await enqueueJob(op.job);
          },
          broadcast: async () => {},
        });

        return c.redirect(
          redirect?.url ?? `${basePath}?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(runId)}`,
          303,
        );
        }
      );

    },
  };
};

const factory: AgentModuleFactory = (ctx: AgentLoaderContext): AgentRouteModule =>
  createTheoremRoute({
    runtime: ctx.runtime<Runtime<TheoremCmd, TheoremEvent, TheoremState>>("theorem"),
    llmText: ctx.llmText,
    prompts: ctx.prompt<Parameters<typeof runTheoremRoster>[0]["prompts"]>("theorem"),
    promptHash: ctx.promptHashes.theorem ?? "",
    promptPath: ctx.promptPaths.theorem ?? "prompts/theorem.prompts.json",
    model: ctx.models.theorem ?? DEFAULT_OPENAI_MODEL,
    enqueueJob: ctx.enqueueJob,
    webAccess: ctx.helper("spacetimeWebAccess", (value): value is SpacetimeWebAccess => value instanceof SpacetimeWebAccess),
  });

export default factory;
