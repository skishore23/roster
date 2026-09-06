import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

test("packed CLI scaffolds import through public exports in a separate consumer", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-consumer-"));
  try {
    const packed = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: root });
    const [{ filename }] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    await exec("tar", ["-xzf", join(directory, filename), "-C", directory]);
    const consumer = join(directory, "consumer");
    await mkdir(join(consumer, "node_modules"), { recursive: true });
    await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "test-consumer", type: "module" }));
    // Reuse installed dependencies without relying on the repository's source
    // tree, dev loader, or unpublished relative SDK paths.
    await symlink(join(root, "node_modules"), join(directory, "package", "node_modules"), "dir");
    await symlink(join(directory, "package"), join(consumer, "node_modules", "roster"), "dir");
    const cli = join(directory, "package", "dist", "cli.js");
    for (const template of ["basic", "assistant-tool", "human-loop", "merge", "adaptive-graph"]) {
      const id = `example-${template}`;
      await exec(process.execPath, [cli, "new", id, "--template", template], { cwd: consumer });
      const file = template === "adaptive-graph" ? `src/rosters/${id}.roster.ts` : `src/agents/${id}.agent.ts`;
      const source = await readFile(join(consumer, file), "utf8");
      assert.doesNotMatch(source, /\.\.\/sdk\//);
      await exec(process.execPath, ["--input-type=module", "-e", `await import('./${file}')`], { cwd: consumer });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
