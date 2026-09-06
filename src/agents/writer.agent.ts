import { randomBytes } from "node:crypto";

import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import type { LlmTextOptions } from "../adapters/openai.js";
import { fold } from "../core/chain.js";
import type { Runtime } from "../core/runtime.js";
import type { Chain } from "../core/types.js";
import { DEFAULT_OPENAI_MODEL } from "../models.js";
import type { WriterCmd, WriterEvent, WriterState } from "../modules/writer.js";
import { reduce as reduceWriter, initial as initialWriter } from "../modules/writer.js";
import {
  WRITER_EXAMPLES,
  runWriterRoster,
  normalizeWriterConfig,
  parseWriterConfig,
} from "./writer.js";
import {
  getLatestWriterRunId,
  sliceWriterChainByStep,
} from "./writer.runs.js";
import { writerRunStream } from "./writer.streams.js";
import { writerShell } from "../views/writer.js";
import { html, makeEventId, parseAt, parseBranch, text, toFormRecord } from "../framework/http.js";
import { writerRunFormSchema } from "../framework/schemas.js";
import type { AgentLoaderContext, AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import type { RuntimeOp } from "../framework/translators.js";
import { executeRuntimeOps } from "../framework/translators.js";
import type { EnqueueJobInput } from "../engine/runtime/job-queue.js";
import { SpacetimeWebAccess } from "../adapters/spacetimedb-web-access.js";

type WriterRouteDeps = {
  readonly runtime: Runtime<WriterCmd, WriterEvent, WriterState>;
  readonly llmText: (opts: LlmTextOptions) => Promise<string>;
  readonly prompts: Parameters<typeof runWriterRoster>[0]["prompts"];
  readonly promptHash: string;
  readonly promptPath: string;
  readonly model: string;
  readonly enqueueJob: (job: EnqueueJobInput) => Promise<void>;
  readonly webAccess?: SpacetimeWebAccess;
};

type WriterRunStartIntent = {
  readonly stream: string;
  readonly runId: string;
  readonly runStream: string;
  readonly sourceStream: string;
  readonly sourceChain: Chain<WriterEvent>;
  readonly at: number | null;
  readonly append?: string;
  readonly resolvedProblem: string;
  readonly config: ReturnType<typeof parseWriterConfig>;
  readonly resumeRequested: boolean;
};

export const translateWriterRunStartIntent = (
  intent: WriterRunStartIntent
): ReadonlyArray<RuntimeOp<WriterCmd>> => {
  const ops: RuntimeOp<WriterCmd>[] = [];
  let runStreamOverride: string | undefined;
  let forkedBranch: string | undefined;
  const queuedProblem = intent.append ? `${intent.resolvedProblem}\n\n${intent.append}` : intent.resolvedProblem;
  const queueJobId = `writer_${intent.runId}_${Date.now().toString(36)}`;

  if (intent.resumeRequested && intent.sourceChain.length > 0) {
    const forkSlice = intent.at === null ? intent.sourceChain : sliceWriterChainByStep(intent.sourceChain, intent.at);
    const forkAt = forkSlice.length;
    const branchId = `resume_${Date.now().toString(36)}_${forkAt}`;
    const branchStream = `${intent.runStream}/branches/${branchId}`;
    ops.push({ type: "fork", stream: intent.sourceStream, at: forkAt, newName: branchStream });
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
      agentId: "writer",
      lane: "collect",
      sessionKey: `writer:${intent.stream}`,
      singletonMode: "cancel",
      maxAttempts: 2,
      payload: {
        kind: "writer.run",
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
  ops.push({ type: "redirect", header: "Location", url: `/writer?${redirectParams.toString()}` });

  return ops;
};

export const createWriterRoute = (deps: WriterRouteDeps): AgentRouteModule => {
  const { runtime, enqueueJob } = deps;

  return {
    id: "writer",
    kind: "run",
    paths: {
      shell: "/writer",
      run: "/writer/run",
    },
    register: (app: Hono) => {
      app.get("/writer", async (c) => {
        const stream = c.req.query("stream") ?? "agents/writer";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const at = parseAt(c.req.query("at"));
        const chain = await runtime.chain(stream);
        const latest = getLatestWriterRunId(chain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        const nonce = randomBytes(18).toString("base64");
        return html(writerShell(
          stream,
          WRITER_EXAMPLES,
          activeRun,
          wantsEmpty ? null : at,
          branchParam ?? undefined,
          deps.webAccess
            ? {
                boot: deps.webAccess.boot({
                  domain: "writer",
                  stream,
                  runId: activeRun,
                  runStream: activeRun ? writerRunStream(stream, activeRun) : undefined,
                  branchStream: branchParam ?? undefined,
                }),
                nonce,
              }
            : undefined,
        ));
      });

      app.post(
        "/writer/run",
        zValidator("form", writerRunFormSchema, (result) => {
          if (!result.success) return text(400, "problem required");
        }),
        async (c) => {
        const stream = c.req.query("stream") ?? "agents/writer";
        const runParam = c.req.query("run");
        const branchParam = parseBranch(c.req.query("branch"));
        const at = parseAt(c.req.query("at"));
        const formRaw = toFormRecord(c.req.valid("form"));

        const problem = formRaw.problem?.trim();
        const append = formRaw.append?.trim();
        const runId = runParam?.trim().length ? runParam.trim() : `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const runStream = writerRunStream(stream, runId);
        const branchPrefix = `${runStream}/branches/`;
        let sourceStream = runStream;
        let sourceChain = await runtime.chain(runStream);
        if (branchParam && branchParam.startsWith(branchPrefix)) {
          const branchChain = await runtime.chain(branchParam);
          if (branchChain.length > 0) {
            sourceStream = branchParam;
            sourceChain = branchChain;
          }
        }
        const existingState = sourceChain.length > 0 ? fold(sourceChain, reduceWriter, initialWriter) : undefined;
        const resolvedProblem = existingState?.problem || problem || "";
        if (!resolvedProblem) return text(400, "problem required");
        const hasConfigInput = formRaw.parallel !== undefined;
        let config = parseWriterConfig(formRaw);
        if (!hasConfigInput && existingState?.config) {
          config = normalizeWriterConfig({ maxParallel: existingState.config.maxParallel });
        }

        const ops = translateWriterRunStartIntent({
          stream,
          runId,
          runStream,
          sourceStream,
          sourceChain,
          at,
          append,
          resolvedProblem,
          config,
          resumeRequested: Boolean(runParam?.trim().length),
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
          redirect?.url ?? `/writer?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(runId)}`,
          303,
        );
        }
      );

    },
  };
};

const factory: AgentModuleFactory = (ctx: AgentLoaderContext): AgentRouteModule =>
  createWriterRoute({
    runtime: ctx.runtime<Runtime<WriterCmd, WriterEvent, WriterState>>("writer"),
    llmText: ctx.llmText,
    prompts: ctx.prompt<Parameters<typeof runWriterRoster>[0]["prompts"]>("writer"),
    promptHash: ctx.promptHashes.writer ?? "",
    promptPath: ctx.promptPaths.writer ?? "prompts/writer.prompts.json",
    model: ctx.models.writer ?? DEFAULT_OPENAI_MODEL,
    enqueueJob: ctx.enqueueJob,
    webAccess: ctx.helper("spacetimeWebAccess", (value): value is SpacetimeWebAccess => value instanceof SpacetimeWebAccess),
  });

export default factory;
