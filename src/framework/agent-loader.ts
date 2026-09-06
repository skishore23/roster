import fs from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createAgentLoaderContext,
  type AgentLoaderContextInput,
  type AgentModule,
  type AgentModuleFactory,
  type DiscoveredAgentModule,
  type AgentRouteModule,
  type HeadlessAgentSpec,
} from "./agent-types.js";
import { headlessAgentShell } from "../views/headless-agent.js";

const exists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

export const inferAgentsDir = async (): Promise<{ readonly dir: string; readonly suffix: string }> => {
  const here = fileURLToPath(import.meta.url);
  const runningFromDist = here.includes(`${path.sep}dist${path.sep}`);
  const configuredDir = process.env.ROSTER_AGENT_MODULES_DIR?.trim();
  if (configuredDir) {
    if (!path.isAbsolute(configuredDir)) {
      throw new Error("ROSTER_AGENT_MODULES_DIR must be an absolute path");
    }
    if (!await exists(configuredDir)) {
      throw new Error(`Configured Roster agent directory does not exist: ${configuredDir}`);
    }
    return {
      dir: configuredDir,
      suffix: runningFromDist ? ".agent.js" : ".agent.ts",
    };
  }
  const srcDir = path.join(process.cwd(), "src", "agents");
  const distDir = path.join(process.cwd(), "dist", "agents");

  if (runningFromDist && await exists(distDir)) {
    return { dir: distDir, suffix: ".agent.js" };
  }
  if (await exists(srcDir)) {
    return { dir: srcDir, suffix: ".agent.ts" };
  }
  const adjacentDir = path.resolve(path.dirname(here), "..", "agents");
  if (await exists(adjacentDir)) {
    return { dir: adjacentDir, suffix: runningFromDist ? ".agent.js" : ".agent.ts" };
  }
  return { dir: distDir, suffix: ".agent.js" };
};

const asRouteDefinition = (value: unknown): AgentRouteModule | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<AgentRouteModule>;
  if (typeof candidate.id !== "string") return undefined;
  if (typeof candidate.register !== "function") return undefined;
  return candidate as AgentRouteModule;
};

const asHeadlessAgentSpec = (value: unknown): HeadlessAgentSpec | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<HeadlessAgentSpec>;
  if (typeof candidate.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(candidate.id)) return undefined;
  if (typeof candidate.version !== "string" || !candidate.version.trim()) return undefined;
  if (!candidate.receipts || typeof candidate.receipts !== "object"
    || Object.values(candidate.receipts).some((receipt) =>
      !receipt || typeof receipt !== "object" || (receipt as { readonly __receipt?: unknown }).__receipt !== true)) return undefined;
  if (typeof candidate.view !== "function") return undefined;
  if (typeof candidate.actions !== "function") return undefined;
  if (typeof candidate.goal !== "function") return undefined;
  return candidate as HeadlessAgentSpec;
};

const safeTokenEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const headlessRoute = (spec: HeadlessAgentSpec, ctx: ReturnType<typeof createAgentLoaderContext>): DiscoveredAgentModule => {
  const root = `/agents/${spec.id}`;
  const run = `${root}/run`;
  const metadata = `${root}/metadata`;
  const csrf = randomBytes(32).toString("base64url");
  return {
    id: spec.id,
    moduleType: "headless",
    kind: "headless",
    paths: { root, run, metadata },
    spec,
    register: (app) => {
      app.get(root, (c) => c.html(headlessAgentShell({
        id: spec.id,
        version: spec.version,
        runPath: run,
        csrf,
      })));
      app.get(metadata, (c) => c.json({
        id: spec.id,
        version: spec.version,
        moduleType: "headless",
        receiptTypes: Object.keys(spec.receipts).sort(),
        run: `roster run ${spec.id} --problem <text>`,
      }));
      app.post(run, async (c) => {
        if (!ctx.runHeadlessAgent) {
          return c.json({ error: "Headless agent execution is not configured" }, 501);
        }
        const contentType = c.req.header("content-type") ?? "";
        const body: Record<string, unknown> = contentType.includes("application/json")
          ? await c.req.json<Record<string, unknown>>().catch(() => ({}))
          : Object.fromEntries(await c.req.formData());
        const submittedCsrf = c.req.header("x-roster-csrf")
          ?? (typeof body.csrf === "string" ? body.csrf : "");
        if (!safeTokenEqual(submittedCsrf, csrf)) return c.json({ error: "invalid csrf token" }, 403);
        const problem = typeof body.problem === "string" ? body.problem.trim() : "";
        if (!problem) return c.json({ error: "problem is required" }, 400);
        if (problem.length > 100_000) return c.json({ error: "problem is too long" }, 400);
        const runId = typeof body.runId === "string" && body.runId.trim() ? body.runId.trim() : undefined;
        const stream = typeof body.stream === "string" && body.stream.trim() ? body.stream.trim() : undefined;
        if (runId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(runId)) {
          return c.json({ error: "runId is invalid" }, 400);
        }
        if (stream && (stream.length > 512 || /[\u0000-\u001f\u007f]/.test(stream))) {
          return c.json({ error: "stream is invalid" }, 400);
        }
        const result = await ctx.runHeadlessAgent({
          spec,
          problem,
          ...(runId ? { runId } : {}),
          ...(stream ? { stream } : {}),
        });
        return c.json({ ok: true, moduleType: "headless", ...result });
      });
    },
  };
};

const applicationRoute = (definition: AgentRouteModule): DiscoveredAgentModule => ({
  ...definition,
  moduleType: "application",
});

type LoadedAgentDefault = AgentModuleFactory | AgentRouteModule | HeadlessAgentSpec;

const loadDefault = async (file: string): Promise<LoadedAgentDefault> => {
  const mod = await import(pathToFileURL(file).href) as AgentModule;
  if (typeof mod.default === "function") {
    return mod.default;
  }
  if (asRouteDefinition(mod.default)) return mod.default;
  if (asHeadlessAgentSpec(mod.default)) return mod.default;
  throw new Error(`Invalid agent module '${path.basename(file)}': default export must be a defineAgent spec, route factory, or route module`);
};

export type AgentLoaderOptions = {
  readonly directory?: string;
  readonly suffix?: string;
  /** Exact module basenames to load, without the `.agent.ts`/`.agent.js` suffix. */
  readonly moduleNames?: ReadonlyArray<string>;
};

export const loadAgentRoutes = async (
  input: AgentLoaderContextInput,
  options: AgentLoaderOptions = {},
): Promise<ReadonlyArray<DiscoveredAgentModule>> => {
  const inferred = await inferAgentsDir();
  const dir = options.directory ?? inferred.dir;
  const suffix = options.suffix ?? inferred.suffix;
  const ctx = createAgentLoaderContext(input);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const moduleNames = options.moduleNames
    ? [...new Set(options.moduleNames.map((name) => name.trim()))]
    : undefined;
  if (moduleNames?.some((name) => !/^[a-z][a-z0-9-]*$/.test(name))) {
    throw new Error("Agent module names must be lowercase safe basenames");
  }
  if (moduleNames && moduleNames.length !== options.moduleNames?.length) {
    throw new Error("Agent module names must be unique");
  }
  const requestedModules = moduleNames ? new Set(moduleNames) : undefined;
  const files = entries
    .filter((entry) => entry.isFile()
      && entry.name.endsWith(suffix)
      && (!requestedModules || requestedModules.has(entry.name.slice(0, -suffix.length))))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  if (requestedModules) {
    const discovered = new Set(files.map((file) => path.basename(file).slice(0, -suffix.length)));
    const missing = moduleNames!.filter((name) => !discovered.has(name));
    if (missing.length > 0) {
      throw new Error(`Configured Roster agent modules are missing: ${missing.join(", ")}`);
    }
  }

  const modules = await Promise.all(files.map(loadDefault));
  const routes = modules.map((module): DiscoveredAgentModule => {
    if (typeof module === "function") return applicationRoute(module(ctx));
    const route = asRouteDefinition(module);
    if (route) return applicationRoute(route);
    return headlessRoute(asHeadlessAgentSpec(module)!, ctx);
  });

  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.id)) {
      throw new Error(`duplicate agent route id '${route.id}'`);
    }
    seen.add(route.id);
  }

  return routes;
};
