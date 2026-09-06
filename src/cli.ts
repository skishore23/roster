#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { connectSpacetimeControlPlaneFromEnv, type SpacetimeControlPlane } from "./adapters/spacetimedb-control.js";
import { createSpacetimeJobQueue } from "./adapters/spacetimedb-job-queue.js";
import {
  SpacetimeEventRepository,
  spacetimeBranchStore,
  spacetimeStore,
} from "./adapters/spacetimedb-runtime.js";
import { createRuntime } from "./core/runtime.js";
import { runHeadlessAgent, type HeadlessAgentEvent } from "./framework/headless-agent-runner.js";
import type { HeadlessAgentSpec } from "./framework/agent-types.js";
import type { JobStatus } from "./modules/job.js";
import { buildMetricsReport, formatMetricsReport, type MetricsHistorySelector } from "./modules/metrics-report.js";
import {
  collectRosterDiagnostics,
  formatRosterDiagnostics,
  runRosterStack,
  setupRosterProject,
} from "./operations/local-stack.js";
import { codingCommandExitCode, executeCodingCommand } from "./cli/coding-command.js";
import { ensureCodingServer } from "./cli/coding-bootstrap.js";

type Flags = Readonly<Record<string, string | boolean>>;

type ParsedArgs = {
  readonly command?: string;
  readonly args: ReadonlyArray<string>;
  readonly flags: Flags;
};

const ROOT = process.cwd();
const WORKSPACE_ID = process.env.ROSTER_WORKSPACE_ID?.trim() || "roster/default";
const WORKSPACE_NAME = process.env.ROSTER_WORKSPACE_NAME?.trim() || "Roster local workspace";

const printUsage = (): void => {
  console.log(`roster <command> [args]\n\nCommands:\n  roster coding                         Interactive multi-agent coding daily driver\n  roster coding help                    Terminal and automation command reference\n  roster setup [--skip-install] [--skip-publish]\n  roster doctor [--json]\n  roster up\n  roster status [--json]\n  roster new <id> [--template basic|assistant-tool|human-loop|merge|adaptive-graph]\n  roster dev\n  roster run <agent-id> --problem <text> [--stream agents/<agentId>] [--run-id <runId>]\n  roster trace <run-id|stream>\n  roster replay <run-id|stream>\n  roster fork <run-id|stream> --at <index> [--name <branch-name>]\n  roster inspect <run-id|stream>\n  roster jobs [--status queued|leased|running|completed|failed|canceled] [--limit <n>]\n  roster abort <job-id> [--reason <text>]
  roster metrics --run-id <run-id> [--json]`);
};

const parseArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  const [command, ...rest] = argv;
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }

    const trimmed = token.slice(2);
    const eq = trimmed.indexOf("=");
    if (eq >= 0) {
      const key = trimmed.slice(0, eq);
      const value = trimmed.slice(eq + 1);
      flags[key] = value;
      continue;
    }

    const key = trimmed;
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }

  return { command, args, flags };
};

const asString = (flags: Flags, key: string): string | undefined => {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
};

type CliSpacetime = {
  readonly control: SpacetimeControlPlane;
  readonly repository: SpacetimeEventRepository;
  readonly queue: Awaited<ReturnType<typeof createSpacetimeJobQueue>>;
};

let cliSpacetime: Promise<CliSpacetime> | undefined;

const getSpacetime = (): Promise<CliSpacetime> => {
  cliSpacetime ??= (async () => {
    const control = await connectSpacetimeControlPlaneFromEnv();
    if (!control) throw new Error("SpacetimeDB is required; SPACETIMEDB_ENABLED=0 is not a CLI fallback");
    let repository: SpacetimeEventRepository | undefined;
    let queue: Awaited<ReturnType<typeof createSpacetimeJobQueue>> | undefined;
    try {
      repository = new SpacetimeEventRepository(control, WORKSPACE_ID, WORKSPACE_NAME);
      await repository.initialize();
      queue = await createSpacetimeJobQueue({ control, workspaceId: WORKSPACE_ID });
      return { control, repository, queue };
    } catch (error) {
      queue?.close();
      repository?.close();
      control.disconnect();
      throw error;
    }
  })();
  return cliSpacetime;
};

const closeSpacetime = async (): Promise<void> => {
  if (!cliSpacetime) return;
  const active = await cliSpacetime.catch(() => undefined);
  active?.queue.close();
  active?.repository.close();
  active?.control.disconnect();
};

const looksLikeDefineAgentSpec = (value: unknown): value is HeadlessAgentSpec => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.version === "string"
    && typeof candidate.view === "function"
    && typeof candidate.actions === "function"
    && typeof candidate.goal === "function"
    && Boolean(candidate.receipts)
    && typeof candidate.receipts === "object";
};

const loadAgentDefault = async (agentId: string): Promise<unknown | undefined> => {
  const srcFile = path.join(ROOT, "src", "agents", `${agentId}.agent.ts`);
  if (fs.existsSync(srcFile)) {
    const mod = await import(pathToFileURL(srcFile).href);
    return mod.default;
  }

  const distFile = path.join(ROOT, "dist", "agents", `${agentId}.agent.js`);
  if (fs.existsSync(distFile)) {
    const mod = await import(pathToFileURL(distFile).href);
    return mod.default;
  }

  return undefined;
};

const resolveStream = async (runOrStream: string): Promise<string> => {
  const { control } = await getSpacetime();
  const streams = control.workspaceSnapshot(WORKSPACE_ID).streams.map((stream) => stream.streamId);
  if (runOrStream.includes("/") && streams.includes(runOrStream)) return runOrStream;
  const direct = streams.find((stream) => stream === runOrStream);
  if (direct) return direct;
  const suffix = `/runs/${runOrStream}`;
  const runStream = streams.find((stream) => stream.endsWith(suffix));
  if (runStream) return runStream;
  throw new Error(`Unable to resolve run/stream '${runOrStream}'`);
};

const readChain = async (stream: string): Promise<ReadonlyArray<{ readonly ts: number; readonly body: Record<string, unknown> }>> => {
  const { repository } = await getSpacetime();
  const store = spacetimeStore<Record<string, unknown>>(repository);
  const chain = await store.read(stream);
  return chain.map((receipt) => ({ ts: receipt.ts, body: receipt.body }));
};

type AgentTemplate = {
  readonly receipts: string;
  readonly viewType: string;
  readonly view: string;
  readonly action: string;
  readonly goal: string;
};

const COMMON_RECEIPTS = `
    "task.requested": receipt<{ prompt: string }>(),
    "task.completed": receipt<{ output: string }>(),`;

const AGENT_TEMPLATES = {
  basic: {
    receipts: COMMON_RECEIPTS,
    viewType: "{ readonly prompt?: string; readonly done: boolean }",
    view: `
    prompt: on("task.requested").last()?.prompt,
    done: on("task.completed").exists(),`,
    action: `action("complete", {
      when: ({ view }) => Boolean(view.prompt) && !view.done,
      run: async ({ view, emit }) => {
        emit("task.completed", { output: view.prompt ?? "" });
      },
    })`,
    goal: "view.done",
  },
  "assistant-tool": {
    receipts: COMMON_RECEIPTS,
    viewType: "{ readonly prompt?: string; readonly done: boolean }",
    view: `
    prompt: on("task.requested").last()?.prompt,
    done: on("task.completed").exists(),`,
    action: `assistant("draft", {
      when: ({ view }) => Boolean(view.prompt) && !view.done,
      run: async ({ view, emit }) => {
        emit("task.completed", { output: \`Draft: \${view.prompt ?? ""}\` });
      },
    })`,
    goal: "view.done",
  },
  "human-loop": {
    receipts: COMMON_RECEIPTS,
    viewType: "{ readonly prompt?: string; readonly done: boolean }",
    view: `
    prompt: on("task.requested").last()?.prompt,
    done: on("task.completed").exists(),`,
    action: `human("approve", {
      when: ({ view }) => Boolean(view.prompt) && !view.done,
      run: async ({ view, emit }) => {
        emit("task.completed", { output: view.prompt ?? "approved" });
      },
    })`,
    goal: "view.done",
  },
  merge: {
    receipts: `
    "task.requested": receipt<{ prompt: string }>(),
    "candidate.generated": receipt<{ text: string; source: string }>(),
    "draft.finalized": receipt<{ text: string }>(),`,
    viewType: "{ readonly prompt?: string; readonly candidate?: { readonly text: string; readonly source: string }; readonly done: boolean }",
    view: `
    prompt: on("task.requested").last()?.prompt,
    candidate: on("candidate.generated").last(),
    done: on("draft.finalized").exists(),`,
    action: `action("merge", {
      when: ({ view }) => Boolean(view.prompt) && !view.done,
      run: async ({ view, emit }) => {
        const text = view.candidate?.text ?? view.prompt ?? "";
        if (!view.candidate) emit("candidate.generated", { text, source: "scaffold" });
        emit("draft.finalized", { text });
      },
    })`,
    goal: "view.done",
  },
} as const satisfies Readonly<Record<string, AgentTemplate>>;

type AgentTemplateName = keyof typeof AGENT_TEMPLATES;

const toPascalCase = (id: string): string => id
  .split("-")
  .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
  .join("");

const renderAdaptiveGraphRoster = (id: string): string => {
  const inputType = `${toPascalCase(id)}Input`;
  const rootFactory = `create${toPascalCase(id)}RootTask`;
  return `import { createHash } from "node:crypto";

import { createRosterRootTask, defineRosterPlatform } from "roster/orchestration";

export type ${inputType} = {
  readonly objective: string;
};

const coordinator = {
  id: "coordinator",
  name: "Coordinator",
  capabilities: ["coordinate"],
  runtime: { kind: "roster-native", profile: "coordinator" },
} as const;

export const platform = defineRosterPlatform({
  id: "${id}",
  version: "3.0.0",
  policyVersion: "${id}-policy-v1",
  coordinatorId: coordinator.id,
  capabilities: [
    { id: "coordinate", description: "Discover workers, expand bounded work, and synthesize accepted outcomes." },
    { id: "research", description: "Gather bounded evidence for the objective." },
    { id: "synthesize", description: "Compose evidence into the final artifact." },
  ],
  nodes: [
    coordinator,
    {
      id: "researcher",
      name: "Researcher",
      capabilities: ["research"],
      parentId: "coordinator",
      runtime: { kind: "roster-native", profile: "researcher" },
    },
    {
      id: "synthesizer",
      name: "Synthesizer",
      capabilities: ["synthesize"],
      parentId: "coordinator",
      runtime: { kind: "roster-native", profile: "synthesizer" },
    },
  ],
  maxNodes: 8,
  policy: {
    maxTasks: 24,
    maxDepth: 3,
    maxFanout: 6,
    maxInflight: 4,
    maxReady: 16,
    maxBlocked: 20,
    maxAttempts: 3,
    maxContextBytes: 4 * 1024 * 1024,
    maxCostMicros: 5_000_000,
    maxTokens: 250_000,
    maxWallTimeMs: 15 * 60_000,
  },
});

export const ${rootFactory} = (input: ${inputType}) => {
  const objectiveVersion = createHash("sha256").update(input.objective).digest("hex");
  return createRosterRootTask({
    taskId: "coordinate-objective",
    semanticKey: \`${id}:objective:\${objectiveVersion}\`,
    nodeId: coordinator.id,
    capability: "coordinate",
    objective: input.objective,
    inputs: {
      inputVersions: { objective: objectiveVersion },
      dataReferences: [],
      frontierVersion: "frontier.initial",
      topologyVersion: "topology.initial",
      catalogVersion: "catalog.live",
    },
  });
};

export default platform;
`;
};

const ROSTER_TEMPLATES = {
  "adaptive-graph": renderAdaptiveGraphRoster,
} as const;

type RosterTemplateName = keyof typeof ROSTER_TEMPLATES;
const TEMPLATE_NAMES = [...Object.keys(AGENT_TEMPLATES), ...Object.keys(ROSTER_TEMPLATES)];

const commandNew = async (id: string, templateName: string): Promise<void> => {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`Invalid agent or roster id '${id}'. Use kebab-case.`);
  }
  const isRosterTemplate = Object.prototype.hasOwnProperty.call(ROSTER_TEMPLATES, templateName);
  const target = isRosterTemplate
    ? path.join(ROOT, "src", "rosters", `${id}.roster.ts`)
    : path.join(ROOT, "src", "agents", `${id}.agent.ts`);
  if (fs.existsSync(target)) {
    throw new Error(`Scaffold file already exists: ${target}`);
  }

  if (!isRosterTemplate && !Object.prototype.hasOwnProperty.call(AGENT_TEMPLATES, templateName)) {
    throw new Error(`Unknown scaffold template '${templateName}'. Choose one of: ${TEMPLATE_NAMES.join(", ")}`);
  }
  if (isRosterTemplate) {
    const render = ROSTER_TEMPLATES[templateName as RosterTemplateName];
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, render(id), "utf-8");
    console.log(`created ${path.relative(ROOT, target)}`);
    return;
  }
  const template = AGENT_TEMPLATES[templateName as AgentTemplateName];

  const body = `import { defineAgent, receipt, action, assistant, human, type ReceiptBody } from "roster/authoring";

const receipts = {${template.receipts}
};

type AgentView = ${template.viewType};
type AgentEmit = <K extends keyof typeof receipts>(type: K, body: ReceiptBody<(typeof receipts)[K]>) => void;

export default defineAgent<typeof receipts, AgentView, Record<string, never>>({
  id: "${id}",
  version: "1.0.0",

  receipts,

  view: ({ on }) => ({
    ${template.view.trim()}
  }),

  actions: () => [
    ${template.action.replace(/^(action|assistant|human)\(/, "$1<AgentView, AgentEmit>(")}
  ],

  goal: ({ view }) => Boolean(${template.goal}),
});
`;

  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, body, "utf-8");
  console.log(`created ${path.relative(ROOT, target)}`);
};

const commandDev = async (): Promise<void> => {
  const source = import.meta.url.endsWith(".ts");
  const server = fileURLToPath(new URL(source ? "./server.ts" : "./server.js", import.meta.url));
  const child = spawn(process.execPath, ["--watch", ...(source ? ["--import", "tsx"] : []), server], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`roster dev exited with code ${code ?? "null"}`));
    });
    child.on("error", reject);
  });
};

const commandRun = async (agentId: string, flags: Flags): Promise<void> => {
  const problem = asString(flags, "problem") ?? asString(flags, "prompt") ?? "";
  if (!problem) throw new Error("--problem is required");
  const runId = asString(flags, "run-id") ?? `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const stream = asString(flags, "stream") ?? `agents/${agentId}`;
  const runStream = asString(flags, "run-stream") ?? `${stream}/runs/${runId}`;

  const loadedDefault = await loadAgentDefault(agentId);
  if (looksLikeDefineAgentSpec(loadedDefault)) {
    const { repository } = await getSpacetime();
    await runHeadlessAgent({
      spec: loadedDefault,
      problem,
      store: spacetimeStore<HeadlessAgentEvent>(repository),
      branchStore: spacetimeBranchStore(repository),
      stream,
      runId,
      runStream,
    });

    console.log(JSON.stringify({ ok: true, mode: "inline", runId, stream, runStream }, null, 2));
    return;
  }

  const { queue } = await getSpacetime();
  const job = await queue.enqueue({
    agentId,
    lane: "collect",
    sessionKey: `${agentId}:${stream}`,
    singletonMode: "cancel",
    maxAttempts: 2,
    payload: {
      kind: `${agentId}.run`,
      stream,
      runId,
      runStream,
      problem,
    },
  });

  console.log(JSON.stringify({ ok: true, mode: "queued", jobId: job.id, runId, stream, runStream }, null, 2));
};

const commandTrace = async (runOrStream: string): Promise<void> => {
  const stream = await resolveStream(runOrStream);
  const chain = await readChain(stream);
  chain.forEach((receipt, idx) => {
    const body = receipt.body;
    const type = typeof body.type === "string" ? body.type : "unknown";
    console.log(`${idx.toString().padStart(4, " ")}  ${new Date(receipt.ts).toISOString()}  ${type}`);
  });
};

const commandReplay = async (runOrStream: string): Promise<void> => {
  const stream = await resolveStream(runOrStream);
  const chain = await readChain(stream);
  console.log(JSON.stringify({ stream, receipts: chain.map((r) => r.body) }, null, 2));
};

const commandInspect = async (runOrStream: string): Promise<void> => {
  const stream = await resolveStream(runOrStream);
  const chain = await readChain(stream);
  console.log(JSON.stringify({ stream, count: chain.length, head: chain[chain.length - 1]?.body ?? null }, null, 2));
};

const commandFork = async (runOrStream: string, flags: Flags): Promise<void> => {
  const atRaw = asString(flags, "at");
  if (!atRaw) throw new Error("--at is required");
  const at = Number(atRaw);
  if (!Number.isFinite(at) || at < 0) throw new Error("--at must be a non-negative number");

  const stream = await resolveStream(runOrStream);
  const branchName = asString(flags, "name") ?? `${stream}/branches/fork_${Date.now().toString(36)}_${Math.floor(at)}`;

  type AnyEvent = Record<string, unknown>;
  type AnyCmd = {
    readonly type: "emit";
    readonly event: AnyEvent;
    readonly eventId: string;
    readonly expectedPrev?: string;
  };

  const { repository } = await getSpacetime();
  const runtime = createRuntime<AnyCmd, AnyEvent, { readonly ok: true }>(
    spacetimeStore<AnyEvent>(repository),
    spacetimeBranchStore(repository),
    (cmd) => [cmd.event],
    (state) => state,
    { ok: true }
  );

  await runtime.fork(stream, Math.floor(at), branchName);
  console.log(JSON.stringify({ ok: true, stream, at: Math.floor(at), branch: branchName }, null, 2));
};

const commandJobs = async (flags: Flags): Promise<void> => {
  const { queue } = await getSpacetime();
  const status = asString(flags, "status");
  const limitRaw = asString(flags, "limit");
  const limit = limitRaw ? Number(limitRaw) : 50;
  const jobs = await queue.listJobs({
    status: status as JobStatus | undefined,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : 50,
  });
  console.log(JSON.stringify({ jobs }, null, 2));
};

const commandAbort = async (jobId: string, flags: Flags): Promise<void> => {
  const reason = asString(flags, "reason") ?? "abort requested";
  const { queue } = await getSpacetime();
  const queued = await queue.queueCommand({
    jobId,
    command: "abort",
    payload: { reason },
    by: "roster-cli",
  });

  if (!queued) {
    throw new Error(`job not found: ${jobId}`);
  }

  console.log(JSON.stringify({ ok: true, jobId, commandId: queued.id }, null, 2));
};

const commandDiagnostics = async (flags: Flags, strict: boolean): Promise<void> => {
  const report = await collectRosterDiagnostics(ROOT, process.env);
  console.log(flags.json === true ? JSON.stringify(report, null, 2) : formatRosterDiagnostics(report));
  if (strict && !report.ok) process.exitCode = 1;
};

const commandMetrics = async (flags: Flags): Promise<void> => {
  const runId = asString(flags, "run-id");
  if (!runId) throw new Error("metrics requires an explicit bounded selector: --run-id <run-id>");
  const spacetime = await getSpacetime();
  const execution = spacetime.control.subscribeRosterExecution(runId);
  try {
    await execution.ready;
    const snapshot = spacetime.control.rosterSnapshot(runId);
    const workspace = spacetime.control.workspaceSnapshot(WORKSPACE_ID);
    const selector: MetricsHistorySelector = { kind: "run", runId };
    const report = buildMetricsReport({
      workspaceId: WORKSPACE_ID,
      selector,
      tasks: snapshot.tasks,
      outcomes: snapshot.outcomes,
      reservations: snapshot.modelReservations,
      profiles: workspace.participantProfiles,
    });
    console.log(flags.json === true ? JSON.stringify(report, null, 2) : formatMetricsReport(report));
  } finally {
    execution.close();
  }
};

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.command;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  switch (command) {
    case "coding":
      if ((!parsed.args[0] || parsed.args[0] === "attach") && process.stdin.isTTY && process.stdout.isTTY) {
        const requestedOrigin = asString(parsed.flags, "api-url") ?? asString(parsed.flags, "url");
        const stack = await ensureCodingServer({
          ...(requestedOrigin ? { origin: requestedOrigin } : {}),
          cwd: ROOT,
          onStatus: (message) => console.error(message),
        });
        try {
          await executeCodingCommand(parsed.args, parsed.flags);
        } finally {
          await stack.close();
        }
      } else {
        await executeCodingCommand(parsed.args, parsed.flags);
      }
      return;
    case "setup":
      await setupRosterProject(ROOT, process.env, {
        install: parsed.flags["skip-install"] !== true,
        publish: parsed.flags["skip-publish"] !== true,
      });
      console.log("Roster setup complete. Run `roster up` to start the daily-driver stack.");
      return;
    case "doctor":
      await commandDiagnostics(parsed.flags, true);
      return;
    case "metrics":
      await commandMetrics(parsed.flags);
      return;
    case "up":
      await runRosterStack(ROOT, process.env);
      return;
    case "status":
      await commandDiagnostics(parsed.flags, false);
      return;
    case "new": {
      const id = parsed.args[0];
      if (!id) throw new Error("agent or roster id is required");
      const template = asString(parsed.flags, "template") ?? "basic";
      await commandNew(id, template);
      return;
    }
    case "dev":
      await commandDev();
      return;
    case "run": {
      const agentId = parsed.args[0];
      if (!agentId) throw new Error("agent id is required");
      await commandRun(agentId, parsed.flags);
      return;
    }
    case "trace": {
      const runOrStream = parsed.args[0];
      if (!runOrStream) throw new Error("run-id or stream is required");
      await commandTrace(runOrStream);
      return;
    }
    case "replay": {
      const runOrStream = parsed.args[0];
      if (!runOrStream) throw new Error("run-id or stream is required");
      await commandReplay(runOrStream);
      return;
    }
    case "fork": {
      const runOrStream = parsed.args[0];
      if (!runOrStream) throw new Error("run-id or stream is required");
      await commandFork(runOrStream, parsed.flags);
      return;
    }
    case "inspect": {
      const runOrStream = parsed.args[0];
      if (!runOrStream) throw new Error("run-id or stream is required");
      await commandInspect(runOrStream);
      return;
    }
    case "jobs":
      await commandJobs(parsed.flags);
      return;
    case "abort": {
      const jobId = parsed.args[0];
      if (!jobId) throw new Error("job id is required");
      await commandAbort(jobId, parsed.flags);
      return;
    }
    default:
      throw new Error(`Unknown command '${command}'`);
  }
};

void main()
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    const codingJson = process.argv[2] === "coding"
      && (process.argv.includes("--json") || process.argv.includes("--jsonl"));
    if (codingJson) {
      console.log(JSON.stringify({
        schema: process.argv.includes("--jsonl") ? "roster.coding-cli.event.v1" : "roster.coding-cli.v1",
        ok: false,
        command: process.argv[3] ?? "coding",
        apiSchema: "roster.coding.v2",
        error: { message, exitCode: codingCommandExitCode(err) },
      }));
    } else {
      console.error(`error: ${message}`);
    }
    process.exitCode = codingCommandExitCode(err);
  })
  .finally(closeSpacetime);
