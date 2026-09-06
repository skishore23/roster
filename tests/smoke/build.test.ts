import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

type CommandResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

const runCommand = (command: string, args: readonly string[], cwd = ROOT): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });

test("smoke: project builds", { timeout: 180_000 }, async () => {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = await runCommand(npmCmd, ["run", "build"]);

  assert.equal(
    result.code,
    0,
    `npm run build failed\nstdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`
  );

  const packed = await runCommand(npmCmd, ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  assert.equal(
    packed.code,
    0,
    `npm pack --dry-run failed\nstdout:\n${packed.stdout}\n\nstderr:\n${packed.stderr}`
  );
  const reports = JSON.parse(packed.stdout) as ReadonlyArray<{
    readonly files?: ReadonlyArray<{ readonly path?: string }>;
  }>;
  const packagedPaths = new Set(reports[0]?.files?.flatMap((file) => file.path ? [file.path] : []) ?? []);
  for (const requiredPath of [
    "docs/production-architecture.md",
    "prompts/agent.prompts.json",
    "prompts/axiom-roster.prompts.json",
    "prompts/axiom.prompts.json",
    "prompts/canvas.prompts.json",
    "prompts/inspector.prompts.json",
    "prompts/theorem.prompts.json",
    "prompts/writer.prompts.json",
    "public/assets/canvas-client.js",
    "public/assets/roster-client.js",
    "public/assets/roster-shell.js",
    "public/assets/replay-client.js",
    "dist/core/numbers.js",
    "dist/core/package-resource.js",
    "dist/domains/coding-control-authorization.js",
  ]) {
    assert.equal(packagedPaths.has(requiredPath), true, `npm package is missing ${requiredPath}`);
  }
  for (const agentModule of [
    "axiom-simple.agent.js",
    "axiom.agent.js",
    "canvas.agent.js",
    "coding.agent.js",
    "inspector.agent.js",
    "monitor.agent.js",
    "simulation.agent.js",
    "theorem.agent.js",
    "writer.agent.js",
  ]) {
    assert.equal(
      packagedPaths.has(`dist/agents/${agentModule}`),
      true,
      `npm package is missing built-in agent ${agentModule}`,
    );
  }
  assert.equal(
    packagedPaths.has("dist/rosters/coding-agent.roster.js"),
    false,
    "npm package contains a deleted generated module",
  );

  const relocated = await mkdtemp(path.join(tmpdir(), "roster-package-relocated-"));
  try {
    const localAgents = path.join(relocated, "dist", "agents");
    await mkdir(localAgents, { recursive: true });
    await writeFile(path.join(localAgents, "custom.agent.js"), "export default {};\n", "utf8");
    const promptModule = pathToFileURL(path.join(ROOT, "dist", "prompts", "theorem.js")).href;
    const resourceModule = pathToFileURL(path.join(ROOT, "dist", "core", "package-resource.js")).href;
    const loaderModule = pathToFileURL(path.join(ROOT, "dist", "framework", "agent-loader.js")).href;
    const probe = await runCommand(process.execPath, ["--input-type=module", "--eval", `
      const { existsSync, realpathSync } = await import("node:fs");
      const { loadTheoremPrompts } = await import(${JSON.stringify(promptModule)});
      const { resolvePackageResource } = await import(${JSON.stringify(resourceModule)});
      const { inferAgentsDir } = await import(${JSON.stringify(loaderModule)});
      loadTheoremPrompts();
      if (!existsSync(resolvePackageResource("public", "assets", "canvas-client.js"))) {
        throw new Error("relocated browser asset was not resolved");
      }
      const inferred = await inferAgentsDir();
      if (inferred.suffix !== ".agent.js" || realpathSync(inferred.dir) !== realpathSync(${JSON.stringify(path.join(relocated, "dist", "agents"))})) {
        throw new Error("caller-local built agents were not preferred");
      }
    `], relocated);
    assert.equal(
      probe.code,
      0,
      `relocated package probe failed\nstdout:\n${probe.stdout}\n\nstderr:\n${probe.stderr}`,
    );

    const pinnedProbe = await runCommand(process.execPath, ["--input-type=module", "--eval", `
      const { realpathSync } = await import("node:fs");
      process.env.ROSTER_AGENT_MODULES_DIR = ${JSON.stringify(path.join(ROOT, "dist", "agents"))};
      const { inferAgentsDir } = await import(${JSON.stringify(loaderModule)});
      const inferred = await inferAgentsDir();
      if (inferred.suffix !== ".agent.js" || realpathSync(inferred.dir) !== realpathSync(process.env.ROSTER_AGENT_MODULES_DIR)) {
        throw new Error("explicit packaged agents did not override the caller repository");
      }
    `], relocated);
    assert.equal(
      pinnedProbe.code,
      0,
      `packaged agent pin probe failed\nstdout:\n${pinnedProbe.stdout}\n\nstderr:\n${pinnedProbe.stderr}`,
    );
  } finally {
    await rm(relocated, { recursive: true, force: true });
  }
});
