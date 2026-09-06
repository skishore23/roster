import { randomBytes } from "node:crypto";

import { zValidator } from "@hono/zod-validator";
import type { Context, Hono } from "hono";

import { SpacetimeWebAccess } from "../adapters/spacetimedb-web-access.js";
import type { AgentCmd } from "../modules/agent.js";
import type { EnqueueJobInput, QueueCommandInput } from "../engine/runtime/job-queue.js";
import { html, text, toFormRecord } from "../framework/http.js";
import { agentRunFormSchema } from "../framework/schemas.js";
import type { AgentLoaderContext, AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import type { RuntimeOp } from "../framework/translators.js";
import {
  monitorShell,
  type MonitorImprovementAudit,
  type MonitorRealtimeBootConfig,
} from "../views/monitor.js";
import {
  getAgentArchitecture,
  getAgentDisplayName,
  getCommandRunAgentSpec,
  isCommandRunAgentId,
} from "./agent-display.js";
import { parseAgentConfig } from "./agent.js";

type MonitorRouteDeps = {
  readonly enqueueJob: (job: EnqueueJobInput) => Promise<void>;
  readonly queueCommand: (input: QueueCommandInput) => Promise<{ readonly id: string } | undefined>;
  readonly webAccess?: SpacetimeWebAccess;
  readonly improvementAudit?: () => Promise<MonitorImprovementAudit>;
};

type AgentRunStartIntent = {
  readonly stream: string;
  readonly runId: string;
  readonly problem: string;
  readonly config: ReturnType<typeof parseAgentConfig>;
};

const MONITOR_BASE_PATH = "/monitor";

const buildShellUrl = (stream: string, runId?: string, jobId?: string): string => {
  const params = new URLSearchParams({ stream });
  if (runId) params.set("run", runId);
  if (jobId) params.set("job", jobId);
  return `${MONITOR_BASE_PATH}?${params.toString()}`;
};

const redirectResponse = (url: string): Response => new Response("", {
  status: 303,
  headers: {
    Location: url,
    "Cache-Control": "no-store",
  },
});

const parseJsonObject = (raw: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
};

const monitorSecurityHeaders = (
  webAccess: SpacetimeWebAccess | undefined,
  nonce: string,
): Readonly<Record<string, string>> => {
  const connectSources = webAccess?.connectSources() ?? [];
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      // spacetimedb@2.6.1 generates algebraic serializers with Function(...).
      `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`,
      `style-src 'self' 'nonce-${nonce}'`,
      `connect-src 'self' ${connectSources.join(" ")}`.trim(),
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
};

const monitorBoot = (
  webAccess: SpacetimeWebAccess,
  stream: string,
  selectedJobId?: string,
): MonitorRealtimeBootConfig => ({
  workspaceId: webAccess.workspaceId,
  queueStream: "jobs",
  activityStream: stream,
  selectedJobId,
  memoryScope: "agent",
  capabilitySecret: webAccess.capabilitySecret,
  realtime: {
    enabled: true,
    uri: webAccess.uri,
    database: webAccess.controlPlane.config.database,
    confirmedReads: webAccess.controlPlane.config.confirmedReads,
  },
});

export const translateAgentRunStartIntent = (
  intent: AgentRunStartIntent,
): ReadonlyArray<RuntimeOp<AgentCmd>> => {
  const queueJobId = `agent_${intent.runId}_${Date.now().toString(36)}`;
  return [
    {
      type: "enqueue_job",
      job: {
        jobId: queueJobId,
        agentId: "agent",
        lane: "collect",
        sessionKey: `agent:${intent.stream}`,
        singletonMode: "cancel",
        maxAttempts: 2,
        payload: {
          kind: "agent.run",
          architectureId: "tool-loop",
          stream: intent.stream,
          runId: intent.runId,
          problem: intent.problem,
          config: intent.config,
        },
      },
    },
    {
      type: "redirect",
      header: "Location",
      url: buildShellUrl(intent.stream, intent.runId, queueJobId),
    },
  ];
};

export const createMonitorRoute = (deps: MonitorRouteDeps): AgentRouteModule => ({
  id: "agent",
  kind: "run",
  paths: {
    shell: "/monitor",
    run: "/monitor/run",
    steer: "/monitor/job/:id/steer",
    followUp: "/monitor/job/:id/follow-up",
    abort: "/monitor/job/:id/abort",
  },
  register: (app: Hono) => {
    app.get("/monitor", async (c) => {
      const stream = (c.req.query("stream") ?? "agents/agent").trim().slice(0, 500) || "agents/agent";
      const selectedJobId = c.req.query("job")?.trim().slice(0, 200) || undefined;
      const nonce = randomBytes(18).toString("base64");
      const improvementAudit = await deps.improvementAudit?.();
      return html(monitorShell({
        stream,
        selectedJobId,
        nonce,
        ...(improvementAudit ? { improvementAudit } : {}),
        realtime: deps.webAccess ? monitorBoot(deps.webAccess, stream, selectedJobId) : undefined,
      }), { ...monitorSecurityHeaders(deps.webAccess, nonce) });
    });

    app.post(
      "/monitor/run",
      zValidator("form", agentRunFormSchema, (result) => {
        if (!result.success) return text(400, "problem required");
      }),
      async (c) => {
        const form = toFormRecord(await c.req.parseBody());
        const requested = form.agentId?.trim() ?? "agent";
        const agentId = isCommandRunAgentId(requested) ? requested : "agent";
        const spec = getCommandRunAgentSpec(agentId);
        const stream = (c.req.query("stream") ?? spec.defaultStream).trim().slice(0, 500) || spec.defaultStream;
        const problem = form.problem?.trim() ?? "";
        if (!problem) return text(400, "problem required");
        const runId = `run_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
        const config = parseAgentConfig(form);

        let job: EnqueueJobInput;
        if (agentId === "agent") {
          const op = translateAgentRunStartIntent({ stream, runId, problem, config })
            .find((candidate): candidate is Extract<RuntimeOp<AgentCmd>, { readonly type: "enqueue_job" }> => candidate.type === "enqueue_job");
          if (!op) throw new Error("agent dispatch did not produce a queue job");
          job = op.job;
        } else {
          const jobId = `${agentId.replace(/[^a-z0-9]+/g, "_")}_${runId}`;
          job = {
            jobId,
            agentId,
            lane: "collect",
            sessionKey: `${agentId}:${stream}`,
            singletonMode: "cancel",
            maxAttempts: 2,
            payload: {
              kind: spec.kind,
              architectureId: getAgentArchitecture(agentId)?.id,
              stream,
              runId,
              problem,
              config,
              agentName: getAgentDisplayName(agentId),
            },
          };
        }
        await deps.enqueueJob(job);
        const jobId = job.jobId;
        const target = spec.routePath ?? "/monitor";
        const params = new URLSearchParams({ stream, run: runId });
        if (jobId) params.set("job", jobId);
        return redirectResponse(`${target}?${params.toString()}`);
      },
    );

    const commandResponse = async (
      c: Context,
      input: Omit<QueueCommandInput, "jobId">,
      successMessage: string,
    ): Promise<Response> => {
      const jobId = c.req.param("id")?.trim();
      if (!jobId) return text(400, "job id required");
      const queued = await deps.queueCommand({ jobId, ...input });
      if (!queued) return text(404, "job not found or terminal");
      if (c.req.header("X-Requested-With") === "fetch") return text(202, successMessage);
      return redirectResponse(buildShellUrl(c.req.query("stream") ?? "agents/agent", c.req.query("run"), jobId));
    };

    app.post("/monitor/job/:id/steer", async (c) => {
      const form = toFormRecord(await c.req.parseBody());
      const payload: Record<string, unknown> = {};
      if (form.problem?.trim()) payload.problem = form.problem.trim();
      if (form.config?.trim()) {
        const config = parseJsonObject(form.config);
        if (!config) return text(400, "config must be a valid JSON object");
        payload.config = config;
      }
      if (Object.keys(payload).length === 0) return text(400, "provide problem and/or config");
      return commandResponse(c, { command: "steer", payload, by: "agent.ui" }, "Steer command queued.");
    });

    app.post("/monitor/job/:id/follow-up", async (c) => {
      const form = toFormRecord(await c.req.parseBody());
      const note = form.note?.trim();
      if (!note) return text(400, "note required");
      return commandResponse(c, { command: "follow_up", payload: { note }, by: "agent.ui" }, "Follow-up queued.");
    });

    app.post("/monitor/job/:id/abort", async (c) => {
      const form = toFormRecord(await c.req.parseBody());
      const reason = form.reason?.trim() || "operator requested abort";
      return commandResponse(c, { command: "abort", payload: { reason }, by: "agent.ui" }, "Abort command queued.");
    });
  },
});

const factory: AgentModuleFactory = (ctx: AgentLoaderContext): AgentRouteModule => createMonitorRoute({
  enqueueJob: ctx.enqueueJob,
  queueCommand: (input) => ctx.queue.queueCommand(input),
  webAccess: ctx.helper("spacetimeWebAccess", (value): value is SpacetimeWebAccess => value instanceof SpacetimeWebAccess),
  improvementAudit: ctx.helper(
    "improvementAudit",
    (value): value is () => Promise<MonitorImprovementAudit> => typeof value === "function",
  ),
});

export default factory;
