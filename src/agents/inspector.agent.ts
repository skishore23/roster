import { randomBytes } from "node:crypto";
import fs from "node:fs";

import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import { SpacetimeWebAccess } from "../adapters/spacetimedb-web-access.js";
import { resolvePackageResource } from "../core/package-resource.js";
import type { EnqueueJobInput } from "../engine/runtime/job-queue.js";
import type { AgentLoaderContext, AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import { html, parseAt, parseInspectorDepth, parseLimit, parseOrder, text, toFormRecord } from "../framework/http.js";
import { receiptInspectFormSchema } from "../framework/schemas.js";
import { receiptShell } from "../views/receipt.js";
import { INSPECTOR_TEAM } from "./inspector.constants.js";
import { inspectorAnalysisStream } from "./inspector.streams.js";

type InspectorRouteDeps = {
  readonly enqueueJob: (job: EnqueueJobInput) => Promise<void>;
  readonly webAccess?: SpacetimeWebAccess;
};

const MAX_STREAM_LENGTH = 512;

const normalizeStream = (value: string | null | undefined): string => {
  const stream = value?.trim() ?? "";
  if (!stream || stream.length > MAX_STREAM_LENGTH || /[\u0000-\u001f\u007f]/.test(stream)) return "";
  return stream;
};

const streamExists = (access: SpacetimeWebAccess, streamId: string): boolean =>
  access.controlPlane.workspaceSnapshot(access.workspaceId).streams.some((stream) =>
    stream.streamId === streamId
  );

const replayUrl = (input: {
  readonly stream: string;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly depth: number;
  readonly at: number | null;
}): string => {
  const query = new URLSearchParams({
    stream: input.stream,
    order: input.order,
    limit: String(input.limit),
    depth: String(input.depth),
  });
  if (input.at !== null) query.set("at", String(input.at));
  return `/replay?${query.toString()}`;
};

export const createInspectorRoute = (deps: InspectorRouteDeps): AgentRouteModule => ({
  id: "receipt-inspector",
  kind: "inspector",
  paths: {
    shell: "/replay",
    inspect: "/replay/inspect",
    client: "/assets/replay-client.js",
  },
  register: (app: Hono) => {
    app.get("/assets/replay-client.js", async () => {
      const asset = resolvePackageResource("public", "assets", "replay-client.js");
      try {
        const body = await fs.promises.readFile(asset);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch {
        return text(404, "Replay client bundle is not built");
      }
    });

    app.get("/replay", (c) => {
      const selected = normalizeStream(c.req.query("stream")) || undefined;
      const order = parseOrder(c.req.query("order"));
      const limit = parseLimit(c.req.query("limit"));
      const depth = parseInspectorDepth(c.req.query("depth"));
      const at = parseAt(c.req.query("at"));
      const nonce = randomBytes(18).toString("base64");
      return html(receiptShell({
        selected,
        limit,
        order,
        depth,
        at,
        realtime: deps.webAccess
          ? {
              boot: deps.webAccess.boot({
                domain: "replay",
                stream: selected ?? "agents/theorem",
              }),
              nonce,
            }
          : undefined,
      }));
    });

    app.post(
      "/replay/inspect",
      zValidator("form", receiptInspectFormSchema, (result) => {
        if (!result.success) return text(400, "stream required");
      }),
      async (c) => {
        const form = toFormRecord(c.req.valid("form"));
        const stream = normalizeStream(form.stream);
        const order = parseOrder(form.order ?? null);
        const limit = parseLimit(form.limit ?? null);
        const at = parseAt(form.at ?? null);
        const depth = parseInspectorDepth(form.depth ?? null);
        const question = form.question?.trim() || "Analyze this run.";

        if (!stream) return text(400, "stream required");
        if (!deps.webAccess) return text(503, "SpacetimeDB replay access is unavailable");
        if (!streamExists(deps.webAccess, stream)) return text(404, "stream not found");

        const groupId = `inspect_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const apiReady = Boolean(process.env.OPENAI_API_KEY);
        const apiNote = apiReady ? undefined : "OPENAI_API_KEY not set";

        await Promise.all(INSPECTOR_TEAM.map(async (agent) => {
          const runId = `${groupId}_${agent.id}`;
          await deps.enqueueJob({
            jobId: `inspector_${runId}`,
            agentId: "inspector",
            lane: "collect",
            sessionKey: `inspector:${stream}:${at ?? "live"}:${agent.id}`,
            singletonMode: "cancel",
            maxAttempts: 2,
            payload: {
              kind: "inspector.run",
              stream: inspectorAnalysisStream(stream),
              runId,
              groupId,
              agentId: agent.id,
              agentName: agent.name,
              source: { kind: "stream", name: stream },
              order,
              limit,
              at: at ?? undefined,
              question,
              mode: agent.mode,
              depth,
              apiReady,
              apiNote,
            },
          });
        }));

        return c.redirect(replayUrl({ stream, order, limit, depth, at }), 303);
      },
    );
  },
});

const factory: AgentModuleFactory = (ctx: AgentLoaderContext): AgentRouteModule =>
  createInspectorRoute({
    enqueueJob: ctx.enqueueJob,
    webAccess: ctx.helper("spacetimeWebAccess", (value): value is SpacetimeWebAccess => value instanceof SpacetimeWebAccess),
  });

export default factory;
