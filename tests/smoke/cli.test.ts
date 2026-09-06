import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { spacetimeTestOptions } from "../support/spacetimedb-test.js";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const tsc = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

const run = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {}
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve) => {
    const grouped = process.platform !== "win32";
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATA_DIR: path.join(ROOT, "data"),
        ROSTER_WORKSPACE_ID: `test/cli-${process.pid}`,
        ...env,
      },
      stdio: "pipe",
      detached: grouped,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const stop = (): void => {
      if (grouped && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        }
      }
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      resolve({ code: null, stdout, stderr: `${stderr}\nCLI command timed out after 30s` });
    }, 30_000);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

const compile = (): Promise<{ readonly code: number | null; readonly stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(tsc, ["--noEmit", "-p", "tsconfig.json"], { cwd: ROOT, stdio: "pipe" });
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });

test("cli: every registered scaffold template compiles and unknown templates fail", { timeout: 60_000 }, async () => {
  const templates = ["basic", "assistant-tool", "human-loop", "merge"] as const;
  const files: string[] = [];
  try {
    for (const template of templates) {
      const id = `tmp-${template}-${Date.now().toString(36)}`;
      files.push(path.join(ROOT, "src", "agents", `${id}.agent.ts`));
      const generated = await run(["new", id, "--template", template]);
      assert.equal(generated.code, 0, generated.stderr);
    }
    const rosterId = `tmp-adaptive-${Date.now().toString(36)}`;
    const rosterFile = path.join(ROOT, "src", "rosters", `${rosterId}.roster.ts`);
    files.push(rosterFile);
    const generatedRoster = await run(["new", rosterId, "--template", "adaptive-graph"]);
    assert.equal(generatedRoster.code, 0, generatedRoster.stderr);
    assert.equal(generatedRoster.stdout.includes(`src/rosters/${rosterId}.roster.ts`), true);
    const rosterSource = await fs.readFile(rosterFile, "utf-8");
    assert.match(rosterSource, /defineRosterPlatform/);
    assert.match(rosterSource, /createRosterRootTask/);
    assert.doesNotMatch(rosterSource, /\bdefineRoster\b/);

    const compiled = await compile();
    assert.equal(compiled.code, 0, compiled.stderr);

    const unknownId = `tmp-unknown-${Date.now().toString(36)}`;
    const unknown = await run(["new", unknownId, "--template", "missing"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /Unknown scaffold template 'missing'/);
    assert.equal(await fs.stat(path.join(ROOT, "src", "agents", `${unknownId}.agent.ts`)).then(() => true, () => false), false);
  } finally {
    await Promise.all(files.map((file) => fs.rm(file, { force: true })));
  }
});

test("cli: help and jobs commands are available", spacetimeTestOptions(60_000), async () => {
  const help = await run(["help"]);
  assert.equal(help.code, 0);
  assert.equal(help.stdout.includes("roster <command>"), true);
  assert.match(help.stdout, /roster setup/);
  assert.match(help.stdout, /roster doctor/);
  assert.match(help.stdout, /roster up/);
  assert.match(help.stdout, /roster status/);

  const status = await run(["status", "--json"]);
  assert.equal(status.code, 0, status.stderr);
  const statusReport = JSON.parse(status.stdout) as { readonly checks?: ReadonlyArray<{ readonly id?: string }> };
  assert.ok(statusReport.checks?.some((check) => check.id === "database"));

  const doctor = await run(["doctor", "--json"]);
  assert.equal(doctor.code, 0, doctor.stderr);
  const doctorReport = JSON.parse(doctor.stdout) as { readonly ok?: boolean };
  assert.equal(doctorReport.ok, true);

  const jobs = await run(["jobs", "--limit", "1"]);
  assert.equal(jobs.code, 0);
  assert.equal(jobs.stdout.includes("\"jobs\""), true);
});

test("cli: failed Spacetime initialization disconnects and exits", spacetimeTestOptions(60_000), async () => {
  const tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-cli-token-"));
  try {
    const result = await run(["jobs", "--limit", "1"], {
      SPACETIMEDB_TOKEN: "",
      SPACETIMEDB_TOKEN_PATH: path.join(tokenDir, "anonymous.token"),
    });
    assert.notEqual(result.code, null, result.stderr);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /belongs to another identity/);
  } finally {
    await fs.rm(tokenDir, { recursive: true, force: true });
  }
});

test("cli: inline agent honors --run-stream", spacetimeTestOptions(60_000), async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-cli-data-"));
  const agentId = `tmp-inline-${Date.now().toString(36)}`;
  const agentFile = path.join(ROOT, "src", "agents", `${agentId}.agent.ts`);
  const runStream = `custom/${agentId}/run`;

  try {
    await fs.writeFile(agentFile, `import { defineAgent, receipt, action, type ReceiptBody } from "../sdk/index.js";

const receipts = {
  "task.requested": receipt<{ prompt: string }>(),
  "task.completed": receipt<{ output: string }>(),
};

type AgentView = { readonly prompt?: string; readonly done: boolean };
type AgentEmit = <K extends keyof typeof receipts>(type: K, body: ReceiptBody<(typeof receipts)[K]>) => void;

export default defineAgent<typeof receipts, AgentView, Record<string, never>>({
  id: "${agentId}",
  version: "1.0.0",
  receipts,
  view: ({ on }) => ({
    prompt: on("task.requested").last()?.prompt,
    done: on("task.completed").exists(),
  }),
  actions: () => [
    action<AgentView, AgentEmit>("complete", {
      when: ({ view }) => Boolean(view.prompt) && !view.done,
      run: ({ view, emit }) => {
        emit("task.completed", { output: view.prompt ?? "" });
      },
    }),
  ],
  goal: ({ view }) => view.done,
  maxIterations: 3,
});
`, "utf-8");

    const result = await run([
      "run",
      agentId,
      "--problem",
      "hello",
      "--run-id",
      "r-inline",
      "--stream",
      `agents/${agentId}`,
      "--run-stream",
      runStream,
    ], { DATA_DIR: dataDir });

    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    const payloadStart = lines.findLastIndex((line) => line.trim() === "{");
    assert.ok(payloadStart >= 0, `missing CLI result payload in:\n${result.stdout}`);
    const parsed = JSON.parse(lines.slice(payloadStart).join("\n")) as { readonly runStream?: string };
    assert.equal(parsed.runStream, runStream);

    const trace = await run(["trace", runStream], { DATA_DIR: dataDir });
    assert.equal(trace.code, 0, trace.stderr);
    assert.equal(trace.stdout.includes("task.completed"), true);
  } finally {
    await fs.rm(agentFile, { force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
