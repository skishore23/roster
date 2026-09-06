import { randomBytes } from "node:crypto";

import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import {
  normalizeSimulationCampaignInput,
  runSimulationCampaign,
  type CoordinationPattern,
} from "../simulations/campaign.js";
import type { AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import { html, text } from "../framework/http.js";
import { simulationCampaignHtml, simulationShell } from "../views/simulations.js";

const simulationFormSchema = z.object({
  pattern: z.enum(["collaboration", "adaptive", "fanout", "hierarchy", "pipeline"]),
  agents: z.coerce.number().int().min(2).max(128),
  maxParallel: z.coerce.number().int().min(1).max(32),
  schedules: z.coerce.number().int().min(1).max(20),
  seed: z.coerce.number().int().min(0).max(0xffff_ffff),
  injectFaults: z.string().optional(),
}).refine((form) => form.maxParallel <= form.agents, {
  message: "maxParallel must not exceed agents",
  path: ["maxParallel"],
});

const DEFAULT_CAMPAIGN = normalizeSimulationCampaignInput({
  pattern: "collaboration",
  agents: 12,
  maxParallel: 6,
  schedules: 6,
  injectFaults: true,
  seed: 0x51f15e,
});

const wantsJson = (accept: string | undefined): boolean =>
  accept?.split(",").some((value) => value.trim().startsWith("application/json")) ?? false;

const simulationSecurityHeaders = (nonce: string): Readonly<Record<string, string>> => ({
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self' https://fonts.gstatic.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`,
  ].join("; "),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

const simulationPage = (
  report: Awaited<ReturnType<typeof runSimulationCampaign>>,
  input: ReturnType<typeof normalizeSimulationCampaignInput>
): Response => {
  const nonce = randomBytes(18).toString("base64");
  return html(simulationShell(report, input, nonce), { ...simulationSecurityHeaders(nonce) });
};

const createSimulationRoute = (): AgentRouteModule => ({
  id: "simulations",
  kind: "simulation",
  paths: { shell: "/simulations", run: "/simulations/run" },
  register: (app: Hono) => {
    app.get("/simulations", async (_c) => {
      const report = await runSimulationCampaign(DEFAULT_CAMPAIGN);
      return simulationPage(report, DEFAULT_CAMPAIGN);
    });

    app.post(
      "/simulations/run",
      zValidator("form", simulationFormSchema, (result, c) => {
        if (result.success) return;
        const error = "Choose valid campaign controls and try again.";
        if (wantsJson(c.req.header("accept"))) {
          c.header("Cache-Control", "no-store");
          return c.json({ ok: false, error }, 400);
        }
        return text(400, error);
      }),
      async (c) => {
        const form = c.req.valid("form");
        const input = normalizeSimulationCampaignInput({
          pattern: form.pattern as CoordinationPattern,
          agents: form.agents,
          maxParallel: form.maxParallel,
          schedules: form.schedules,
          seed: form.seed,
          injectFaults: form.injectFaults === "1",
        });
        const report = await runSimulationCampaign(input);
        if (wantsJson(c.req.header("accept"))) {
          c.header("Cache-Control", "no-store");
          return c.json({
            ok: true,
            campaignId: report.campaignId,
            html: simulationCampaignHtml(report),
          });
        }
        return simulationPage(report, input);
      }
    );
  },
});

const factory: AgentModuleFactory = () => createSimulationRoute();

export default factory;
