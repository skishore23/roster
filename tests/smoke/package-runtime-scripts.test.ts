import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type PackageManifest = {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
};

test("published TypeScript surfaces install the Node namespace used by their declarations", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageManifest;

  assert.ok(
    manifest.dependencies?.["@types/node"],
    "@types/node must be a production dependency because the published declarations expose NodeJS types",
  );
});

test("one-shot TypeScript scripts avoid the tsx CLI IPC launcher", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageManifest;
  const scripts = manifest.scripts ?? {};
  const oneShotTypeScriptScripts = [
    "serve:local",
    "serve:api",
    "cli",
    "eval:axiom",
    "eval:axiom:first",
    "eval:axiom-roster",
    "eval:axiom-roster:first",
    "eval:creativity",
    "eval:creativity:prompts",
    "eval:creativity:live",
    "eval:creativity:policy-replay",
    "new:agent",
    "test:axle:deterministic",
    "test:smoke",
    "simulate:theorem",
    "simulate:campaign",
    "test:perf",
  ] as const;

  for (const scriptName of oneShotTypeScriptScripts) {
    const command = scripts[scriptName];
    assert.ok(command, `missing package script: ${scriptName}`);
    assert.match(command, /^node --import tsx\b/, scriptName);
    assert.doesNotMatch(command, /^tsx\b/, scriptName);
  }
  assert.equal(scripts.dev, "node --watch --import tsx src/local.ts");
  assert.equal(scripts["dev:api"], "node --watch --import tsx src/server.ts");
  assert.equal(scripts.start, "node dist/local.js");
  assert.equal(scripts["start:api"], "node dist/server.js");
});

test("internal one-shot TypeScript subprocesses avoid the tsx CLI IPC launcher", async () => {
  const launchers = [
    ["tests/smoke/agent-ui-boot.test.ts", "src/server.ts"],
    ["tests/smoke/cli.test.ts", "src/cli.ts"],
    ["tests/smoke/framework-routes.test.ts", "src/server.ts"],
    ["tests/smoke/job-delegate-join.test.ts", "src/server.ts"],
  ] as const;

  for (const [sourcePath, entrypoint] of launchers) {
    const source = await readFile(sourcePath, "utf8");
    const loaderInvocation = `spawn(process.execPath, ["--import", "tsx", "${entrypoint}"`;
    assert.ok(source.includes(loaderInvocation), `${sourcePath} must launch ${entrypoint} through node --import tsx`);
  }
});
