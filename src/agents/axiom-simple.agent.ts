import { randomBytes } from "node:crypto";

import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import { SpacetimeWebAccess } from "../adapters/spacetimedb-web-access.js";
import type { Runtime } from "../core/runtime.js";
import { html, text, toFormRecord } from "../framework/http.js";
import { axiomSimpleRunFormSchema } from "../framework/schemas.js";
import type { AgentLoaderContext, AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import type { AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState } from "../modules/axiom-simple.js";
import { esc } from "../views/agent-framework.js";
import { themeBootstrapScript } from "../views/theme.js";
import {
  agentReplayBarHtml,
  agentReplayClientControlsHtml,
  agentShellCss,
  agentShellFrameHtml,
  agentTopNavHtml,
  agentWorkspaceShellHtml,
  staticRoomRoster,
  agentTabsHtml,
  agentTabsScript,
} from "../views/agent-shell.js";
import { axiomSimpleShell } from "../views/axiom-simple.js";
import {
  rosterRealtimeBootHtml,
  rosterRealtimeStatusHtml,
  type RosterRealtimeBootConfig,
} from "../views/roster-realtime.js";
import { parseAxiomSimpleConfig } from "./axiom-simple.js";
import { getLatestAxiomSimpleRunId } from "./axiom-simple.runs.js";
import { axiomSimpleRunStream } from "./axiom-simple.streams.js";

const AXIOM_SIMPLE_EXAMPLES = [
  {
    id: "nat-add-zero",
    label: "Nat.add_zero",
    problem: "In Lean 4 with Mathlib, prove theorem axiom_simple_add_zero (n : Nat) : n + 0 = n.",
  },
  {
    id: "list-append-length",
    label: "List append length",
    problem: "In Lean 4 with Mathlib, prove theorem axiom_simple_list_append_length (xs ys : List Nat) : List.length (xs ++ ys) = List.length xs + List.length ys.",
  },
  {
    id: "false-theorem",
    label: "Reject false theorem",
    problem: "Investigate theorem axiom_simple_bad : 2 = 3. If false, surface formal failure or disproof evidence instead of pretending a proof exists.",
  },
] as const;

const DEFAULT_STREAM = "agents/axiom-simple";
const DEFAULT_CHILD_STREAM = "agents/axiom";
const BASE_PATH = "/axiom-simple";

const runIdForNewRun = (): string =>
  `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

const workerPendingHtml = (runId: string): string =>
  `<div class="empty">Run <code translate="no">${esc(runId)}</code> is queued. Waiting for AXLE receipts…</div>`;

const workerShellHtml = (opts: {
  readonly stream: string;
  readonly runId: string;
  readonly realtime?: {
    readonly boot: RosterRealtimeBootConfig & { readonly surface: "axiom-worker" };
    readonly nonce?: string;
  };
}): string => {
  const replayBar = agentReplayBarHtml({
    id: "axiom-worker-replay",
    title: "Worker receipt history",
    description: "Replay this child agent independently from the parent proof swarm.",
    content: agentReplayClientControlsHtml({
      id: "aw-travel",
      adapter: "axiom-worker",
      emptyLabel: "Synchronizing durable worker history…",
    }),
  });
  const tabs = agentTabsHtml({
    id: "axiom-worker-views",
    label: "Axiom worker context",
    activeId: "evidence",
    tabs: [
      {
        id: "evidence",
        label: "Evidence",
        content: `<div id="aw-side" class="as-worker-stack" data-roster-panel aria-busy="true">${workerPendingHtml(opts.runId)}</div>`,
      },
      {
        id: "run",
        label: "Run",
        content: `<div id="aw-folds" class="as-worker-stack" data-roster-panel aria-busy="true">${workerPendingHtml(opts.runId)}</div>`,
      },
      { id: "history", label: "History", content: replayBar },
    ],
  });
  const room = agentWorkspaceShellHtml({
    id: "axiom-worker-workspace",
    room: {
      eyebrow: "Child proof room",
      title: `#axiom-${opts.runId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-28) || "worker"}`,
      description: "A focused room for one proof worker, its tool evidence, and the parent swarm following its progress.",
      state: "active",
      roster: staticRoomRoster({
        roomId: `axiom-${opts.runId}`,
        summary: "Axiom and AXLE are working on one proof branch",
        members: [
        { name: "You", role: "Observer", kind: "human", presence: "present" },
        { name: "Proof Swarm", role: "Parent room", kind: "system", presence: "present" },
        { name: "Axiom Worker", role: "Lean proof", kind: "agent", presence: "working" },
        { name: "AXLE", role: "Evidence", kind: "agent", presence: "working" },
        ],
      }),
    },
    conversation: `<div id="aw-chat" class="as-worker-stack" data-roster-panel aria-busy="true">${workerPendingHtml(opts.runId)}</div>`,
    context: tabs,
    contextLabel: "Proof evidence and worker context",
    artifact: "Lean proof and AXLE evidence",
    acceptance: "Formal verification over the exact candidate",
    coordinationLabel: "Focused child run",
    railActionsHtml: `<a class="as-worker-back" href="${BASE_PATH}?stream=${encodeURIComponent(DEFAULT_STREAM)}">Back to Proof Swarm</a>`,
  });

  return `<!doctype html>
<html lang="en">
<head>${themeBootstrapScript()}
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#090c11" />
  <title>Roster - Axiom Worker</title>
  <style>
    ${agentShellCss()}
    :root { --good:var(--green); --bad:var(--red); --warn:var(--amber); }
    code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .as-worker-back { min-height:34px; display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:var(--radius-sm); padding:7px 11px; color:var(--ink); background:var(--raised); text-decoration:none; font-size:10px; font-weight:750; }
    .as-worker-back:hover { border-color:var(--agent-accent); background:var(--panel-2); }
    .empty { min-height:68px; display:grid; place-items:center; padding:16px; border:1px dashed var(--line); border-radius:var(--radius-md); color:var(--muted); font-size:11px; text-align:center; }
    .as-worker-stack,#aw-chat,#aw-side,#aw-folds,#aw-travel { min-width:0; display:grid; gap:16px; }
  </style>
</head>
<body>
  ${agentShellFrameHtml({ skipHref: "#main-content", skipLabel: "Skip to worker evidence", chromeHtml: agentTopNavHtml({ active: "swarm", statusLabel: "Axiom worker active", actionsHtml: opts.realtime ? rosterRealtimeStatusHtml("Connecting worker…") : undefined }), mainHtml: room, mainId: "main-content", appClass: "agent-unified-page" })}
  ${agentTabsScript(opts.realtime?.nonce)}
  ${opts.realtime ? rosterRealtimeBootHtml(opts.realtime.boot, { nonce: opts.realtime.nonce }) : ""}
</body>
</html>`;
};

type AxiomSimpleRouteDeps = {
  readonly runtime: Runtime<AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState>;
  readonly enqueueJob: AgentLoaderContext["enqueueJob"];
  readonly webAccess?: SpacetimeWebAccess;
};

const createAxiomSimpleRoute = (deps: AxiomSimpleRouteDeps): AgentRouteModule => {
  const { runtime, enqueueJob } = deps;

  return {
    id: "axiom-simple",
    kind: "run",
    paths: {
      shell: BASE_PATH,
      run: `${BASE_PATH}/run`,
      worker: `${BASE_PATH}/worker`,
    },
    register: (app: Hono) => {
      app.get("/axiom-simple", async (c) => {
        const stream = c.req.query("stream") ?? DEFAULT_STREAM;
        const runParam = c.req.query("run");
        const wantsEmpty = runParam !== undefined && (runParam.trim() === "" || runParam === "new" || runParam === "none");
        const indexChain = await runtime.chain(stream);
        const latest = getLatestAxiomSimpleRunId(indexChain);
        const activeRun = wantsEmpty ? undefined : (runParam ?? latest ?? undefined);
        const nonce = randomBytes(18).toString("base64");
        return html(axiomSimpleShell(stream, AXIOM_SIMPLE_EXAMPLES, activeRun, null, {
          basePath: BASE_PATH,
          title: "Roster - Proof Swarm",
          realtime: deps.webAccess
            ? {
                boot: deps.webAccess.boot({
                  domain: "axiom-simple",
                  stream,
                  runId: activeRun,
                  runStream: activeRun ? axiomSimpleRunStream(stream, activeRun) : undefined,
                }),
                nonce,
              }
            : undefined,
        }));
      });

      app.post(
        "/axiom-simple/run",
        zValidator("form", axiomSimpleRunFormSchema, (result) => {
          if (!result.success) return text(400, "problem required");
        }),
        async (c) => {
          const stream = c.req.query("stream") ?? DEFAULT_STREAM;
          const form = toFormRecord(c.req.valid("form"));
          const problem = form.problem?.trim() ?? "";
          if (!problem) return text(400, "problem required");

          const runId = runIdForNewRun();
          const config = parseAxiomSimpleConfig(form);
          const jobId = `axiom_simple_${runId}_${Date.now().toString(36)}`;

          await enqueueJob({
            jobId,
            agentId: "axiom-simple",
            lane: "collect",
            sessionKey: `axiom-simple:${stream}`,
            singletonMode: "cancel",
            maxAttempts: 2,
            payload: {
              kind: "axiom-simple.run",
              stream,
              runId,
              problem,
              config,
            },
          });

          const redirect = new URLSearchParams({ stream, run: runId, job: jobId });
          return c.redirect(`${BASE_PATH}?${redirect.toString()}`, 303);
        }
      );

      app.get("/axiom-simple/worker", async (c) => {
        const stream = c.req.query("stream") ?? DEFAULT_CHILD_STREAM;
        const runId = c.req.query("run")?.trim();
        if (!runId) return text(400, "run required");
        const nonce = randomBytes(18).toString("base64");
        const boot = deps.webAccess
          ? {
              ...deps.webAccess.boot({
                domain: "axiom",
                stream,
                runId,
                runStream: axiomSimpleRunStream(stream, runId),
              }),
              surface: "axiom-worker" as const,
            }
          : undefined;
        return html(workerShellHtml({
          stream,
          runId,
          realtime: boot ? { boot, nonce } : undefined,
        }));
      });
    },
  };
};

const factory: AgentModuleFactory = (ctx: AgentLoaderContext): AgentRouteModule =>
  createAxiomSimpleRoute({
    runtime: ctx.runtime<Runtime<AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState>>("axiom-simple"),
    enqueueJob: ctx.enqueueJob,
    webAccess: ctx.helper("spacetimeWebAccess", (value): value is SpacetimeWebAccess => value instanceof SpacetimeWebAccess),
  });

export default factory;
