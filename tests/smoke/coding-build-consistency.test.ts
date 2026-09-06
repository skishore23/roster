import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  codingBuildFingerprint,
  parseCodingBuildManifest,
} from "../../scripts/coding-build-manifest.mjs";
import { initialOrchestrationState } from "../../src/modules/orchestration.js";
import {
  CODING_COMPOSER_DRAFT_KEY,
  codingBuildMismatch,
  initializeCodingBuildGuard,
  resolveCodingBuildStorage,
} from "../../src/browser/coding-build.js";
import { readCodingBuildManifest } from "../../src/runtime/coding-build.js";
import { codingShell } from "../../src/views/coding.js";

const codingShellOptions = () => ({
  state: initialOrchestrationState,
  events: [],
  nonce: "coding-build-consistency",
  repositoryPath: "/tmp/coding-build-consistency",
  gitRemote: "",
  gitAccount: "",
  realtime: {
    enabled: false,
    uri: "ws://localhost:3000",
    database: "roster",
    confirmedReads: false,
    workspaceId: "workspace-coding-build-consistency",
  },
});

test("Coding web launch is exposed through the supported package command", async () => {
  const packageSource = await readFile(new URL("../../package.json", import.meta.url), "utf8");
  const packageJson = JSON.parse(packageSource) as { readonly scripts: Readonly<Record<string, string>> };

  assert.equal(packageJson.scripts["coding:web"], "node scripts/run-coding-web-dev.mjs");
});

type SpawnResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

const spawnResult = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): {
  readonly child: ReturnType<typeof spawn>;
  readonly completed: Promise<SpawnResult>;
  readonly output: () => string;
} => {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return {
    child,
    completed: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    }),
    output: () => stdout,
  };
};

const waitForOutput = async (
  running: ReturnType<typeof spawnResult>,
  expected: string,
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!running.output().includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("Coding web launch supervises build and server processes with native exit semantics", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "roster-coding-web-supervisor-"));
  const tracePath = path.join(fixtureRoot, "trace.log");
  const childPath = path.join(fixtureRoot, "child.mjs");
  const harnessPath = path.join(fixtureRoot, "harness.mjs");
  const supervisorUrl = pathToFileURL(path.resolve("scripts/run-coding-web-dev.mjs")).href;
  await writeFile(childPath, `import { appendFileSync } from "node:fs";
const phase = process.argv[2];
const trace = (line) => appendFileSync(process.env.ROSTER_TEST_TRACE, line + "\\n", "utf8");
trace(phase + ":start");
process.stdout.write(phase + ":start\\n");
if (phase === "server" && process.env.ROSTER_TEST_SERVER_WAIT === "1") {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    trace(phase + ":" + signal);
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
  setInterval(() => {}, 1_000);
} else {
  process.exit(Number(process.env[phase === "build" ? "ROSTER_TEST_BUILD_EXIT" : "ROSTER_TEST_SERVER_EXIT"] ?? 0));
}
`, "utf8");
  await writeFile(harnessPath, `import { applyCodingWebDevExit, runCodingWebDev } from ${JSON.stringify(supervisorUrl)};
const result = await runCodingWebDev({
  buildCommand: { command: process.execPath, args: [${JSON.stringify(childPath)}, "build"] },
  serverCommand: { command: process.execPath, args: [${JSON.stringify(childPath)}, "server"] },
});
applyCodingWebDevExit(result);
`, "utf8");

  const run = (env: NodeJS.ProcessEnv = {}) => spawnResult(process.execPath, [harnessPath], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      ROSTER_TEST_TRACE: tracePath,
      ...env,
    },
  });
  const resetTrace = () => writeFile(tracePath, "", "utf8");

  try {
    await t.test("build completes before the server starts", async () => {
      await resetTrace();
      const result = await run().completed;
      assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null });
      assert.equal(await readFile(tracePath, "utf8"), "build:start\nserver:start\n");
    });

    await t.test("a failed build suppresses server startup and propagates its exit", async () => {
      await resetTrace();
      const result = await run({ ROSTER_TEST_BUILD_EXIT: "23" }).completed;
      assert.deepEqual({ code: result.code, signal: result.signal }, { code: 23, signal: null });
      assert.equal(await readFile(tracePath, "utf8"), "build:start\n");
    });

    await t.test("a server failure propagates its exit", async () => {
      await resetTrace();
      const result = await run({ ROSTER_TEST_SERVER_EXIT: "17" }).completed;
      assert.deepEqual({ code: result.code, signal: result.signal }, { code: 17, signal: null });
      assert.equal(await readFile(tracePath, "utf8"), "build:start\nserver:start\n");
    });

    await t.test("a supervisor signal is forwarded and retained as the process result", async () => {
      await resetTrace();
      const running = run({ ROSTER_TEST_SERVER_WAIT: "1" });
      await waitForOutput(running, "server:start");
      running.child.kill("SIGTERM");
      const result = await running.completed;
      assert.deepEqual({ code: result.code, signal: result.signal }, { code: null, signal: "SIGTERM" });
      assert.equal(await readFile(tracePath, "utf8"), "build:start\nserver:start\nserver:SIGTERM\n");
    });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Coding build fingerprints are deterministic and content-sensitive", () => {
  const a = codingBuildFingerprint([
    { path: "src/b.ts", bytes: "second" },
    { path: "src/a.ts", bytes: "first" },
  ]);
  const b = codingBuildFingerprint([
    { path: "src/a.ts", bytes: "first" },
    { path: "src/b.ts", bytes: "second" },
  ]);
  const changed = codingBuildFingerprint([
    { path: "src/a.ts", bytes: "changed" },
    { path: "src/b.ts", bytes: "second" },
  ]);
  assert.match(a, /^[a-f0-9]{64}$/u);
  assert.equal(a, b);
  assert.notEqual(a, changed);
});

test("Coding build fingerprints normalize paths before deterministic bytewise ordering", () => {
  assert.equal(codingBuildFingerprint([
    { path: "src/ä.ts", bytes: "umlaut" },
    { path: ".\\src\\z.ts", bytes: "zee" },
    { path: "src/𐀀.ts", bytes: "supplementary" },
  ]), "13b61c280c35d19e3b60d51ca188f81d205c27d54a8293ddf1773b24dacd120e");
});

test("Coding build discovery fingerprints shared server views and the build toolchain", async () => {
  const buildModule = await import("../../scripts/build-coding-client.mjs");
  assert.equal(typeof buildModule.discoverCodingBuildFingerprintEntries, "function");
  const entries = await buildModule.discoverCodingBuildFingerprintEntries(path.resolve("."));
  const inputPaths = entries.map((entry: { readonly path: string }) => entry.path);
  assert.ok(inputPaths.includes("src/views/theme.ts"), "shared theme view must participate");
  assert.ok(
    inputPaths.some((inputPath: string) => inputPath.startsWith("node_modules/@oblivionocean/minigfm/")),
    "server-side HTML rendering packages must participate",
  );
  assert.ok(inputPaths.includes("scripts/build-coding-client.mjs"), "build recipe must participate");
  assert.ok(inputPaths.includes("@roster/toolchain/esbuild"), "esbuild identity must participate");
  assert.notEqual(
    codingBuildFingerprint(entries),
    codingBuildFingerprint(entries.filter((entry: { readonly path: string }) => entry.path !== "src/views/theme.ts")),
  );
});

test("Coding build manifests reject missing or malformed fingerprints", () => {
  assert.deepEqual(
    parseCodingBuildManifest({ schema: "roster.coding-build.v1", fingerprint: "a".repeat(64) }),
    { schema: "roster.coding-build.v1", fingerprint: "a".repeat(64) },
  );
  assert.throws(() => parseCodingBuildManifest({ schema: "roster.coding-build.v1", fingerprint: "old" }));
  assert.throws(() => parseCodingBuildManifest({ schema: "roster.coding-build.v0", fingerprint: "a".repeat(64) }));
});

test("Coding page renders observe a browser-only manifest replacement", async () => {
  const manifestUrl = new URL("../../public/assets/coding-build.json", import.meta.url);
  const originalManifest = await readFile(manifestUrl, "utf8");
  const firstFingerprint = "a".repeat(64);
  const secondFingerprint = "b".repeat(64);
  try {
    await writeFile(manifestUrl, `${JSON.stringify({
      schema: "roster.coding-build.v1",
      fingerprint: firstFingerprint,
    })}\n`, { encoding: "utf8", flush: true });
    assert.match(codingShell(codingShellOptions()), new RegExp(firstFingerprint, "u"));

    await writeFile(manifestUrl, `${JSON.stringify({
      schema: "roster.coding-build.v1",
      fingerprint: secondFingerprint,
    })}\n`, { encoding: "utf8", flush: true });
    const refreshedHtml = codingShell(codingShellOptions());
    assert.match(refreshedHtml, new RegExp(secondFingerprint, "u"));
    assert.doesNotMatch(refreshedHtml, new RegExp(firstFingerprint, "u"));
  } finally {
    await writeFile(manifestUrl, originalManifest, { encoding: "utf8", flush: true });
  }
});

test("Coding pages publish the build fingerprint with versioned assets and a stale-build notice", () => {
  const html = codingShell(codingShellOptions());
  const fingerprint = readCodingBuildManifest().fingerprint;

  assert.match(html, new RegExp(`<meta name="roster-coding-build" content="${fingerprint}">`, "u"));
  assert.match(html, /\/assets\/coding-client\.js\?v=[a-f0-9]{64}/u);
  assert.match(html, /<script[^>]*src="\/assets\/coding-enhancements\.js\?v=[a-f0-9]{64}"[^>]*data-coding-enhancements/u);
  assert.match(html, /\/assets\/coding-mermaid-renderer\.js\?v=[a-f0-9]{64}/u);
  assert.match(html, /data-coding-build-mismatch[^>]*hidden/u);
  assert.match(html, /\.coding-build-notice\[hidden\]\{display:none(?:!important)?\}/u);
  assert.match(html, /New Roster build available/u);
  assert.match(html, /coding-command-surface[\s\S]*data-coding-build-short[^>]*>[a-f0-9]{12}</u);
});

test("desktop staging publishes one validated Coding build byte-for-byte", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "roster-desktop-coding-stage-"));
  const sourceRoot = path.join(fixtureRoot, "source");
  const destinationRoot = path.join(fixtureRoot, "destination");
  const sourceAssets = path.join(sourceRoot, "public", "assets");
  const destinationAssets = path.join(destinationRoot, "public", "assets");
  const fingerprint = "c".repeat(64);
  const manifestBytes = `${JSON.stringify({
    schema: "roster.coding-build.v1",
    fingerprint,
  })}\n`;
  const stagedAssets = [
    "coding-build.json",
    "coding-client.js",
    "coding-enhancements.js",
    "coding-mermaid-renderer.js",
    "roster-shell.js",
  ];

  try {
    await mkdir(sourceAssets, { recursive: true });
    await writeFile(path.join(sourceAssets, "coding-build.json"), manifestBytes, "utf8");
    for (const assetName of stagedAssets.filter((assetName) => assetName.endsWith(".js"))) {
      await writeFile(
        path.join(sourceAssets, assetName),
        assetName.startsWith("coding-")
          ? `export const codingBuild = ${JSON.stringify(fingerprint)};\n`
          : "export const rosterShell = true;\n",
        "utf8",
      );
    }

    const { stageCodingBuildResources } = await import(
      "../../apps/desktop/scripts/stage-sidecar.mjs"
    );
    assert.equal(typeof stageCodingBuildResources, "function");
    assert.deepEqual(await stageCodingBuildResources(sourceRoot, destinationRoot), {
      schema: "roster.coding-build.v1",
      fingerprint,
    });
    assert.equal(
      await readFile(path.join(destinationAssets, "coding-build.json"), "utf8"),
      manifestBytes,
    );
    assert.deepEqual((await readdir(destinationAssets)).sort(), [...stagedAssets].sort());

    await writeFile(
      path.join(sourceAssets, "coding-client.js"),
      "export const codingBuild = 'stale';\n",
      "utf8",
    );
    await assert.rejects(
      stageCodingBuildResources(sourceRoot, destinationRoot),
      /Coding build fingerprint mismatch in staged asset 'coding-client\.js'/u,
    );
    assert.equal(
      await readFile(path.join(destinationAssets, "coding-build.json"), "utf8"),
      manifestBytes,
      "a validation failure must leave the last complete staged build intact",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("server Coding build manifests reject invalid resource files", async () => {
  const resourceRoot = await mkdtemp(path.join(os.tmpdir(), "roster-coding-build-"));
  const manifestPath = path.join(resourceRoot, "public", "assets", "coding-build.json");
  try {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({
      schema: "roster.coding-build.v1",
      fingerprint: "b".repeat(64),
    }), { encoding: "utf8", flush: true });
    assert.deepEqual(readCodingBuildManifest(resourceRoot), {
      schema: "roster.coding-build.v1",
      fingerprint: "b".repeat(64),
    });

    await writeFile(manifestPath, JSON.stringify({
      schema: "roster.coding-build.v1",
      fingerprint: "stale",
    }), { encoding: "utf8", flush: true });
    assert.throws(() => readCodingBuildManifest(resourceRoot), /Invalid Roster Coding build manifest/u);
  } finally {
    await rm(resourceRoot, { recursive: true, force: true });
  }
});

test("browser build guard detects stale pages and preserves the composer draft key", () => {
  assert.equal(codingBuildMismatch("a".repeat(64), "a".repeat(64)), false);
  assert.equal(codingBuildMismatch("a".repeat(64), "b".repeat(64)), true);
  assert.equal(CODING_COMPOSER_DRAFT_KEY, "roster.coding.composer-draft.v1");
});

test("browser build guard restores a draft and reloads only after stale-build confirmation", () => {
  const composer = { value: "" };
  const meta = { content: "stale-build" };
  const notice = { hidden: true };
  let reloadClick: (() => void) | undefined;
  const reload = {
    addEventListener: (_type: string, listener: () => void) => {
      reloadClick = listener;
    },
  };
  const document = {
    querySelector: (selector: string) => {
      if (selector === "[data-coding-composer-input]") return composer;
      if (selector === "meta[name=\"roster-coding-build\"]") return meta;
      if (selector === "[data-coding-build-mismatch]") return notice;
      if (selector === "[data-coding-build-reload]") return reload;
      return null;
    },
  } as unknown as Document;
  const entries = new Map([[CODING_COMPOSER_DRAFT_KEY, "recovered draft"]]);
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  } as unknown as Storage;
  const originalWindow = globalThis.window;
  let reloaded = false;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { reload: () => { reloaded = true; } } },
  });
  try {
    initializeCodingBuildGuard(document, storage);
    assert.equal(composer.value, "recovered draft");
    assert.equal(entries.has(CODING_COMPOSER_DRAFT_KEY), false);
    assert.equal(notice.hidden, false);
    composer.value = "keep this message";
    reloadClick?.();
    assert.equal(entries.get(CODING_COMPOSER_DRAFT_KEY), "keep this message");
    assert.equal(reloaded, true);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("browser build guard keeps a nonempty composer open when draft persistence fails", () => {
  const composer = { value: "do not lose this message" };
  const meta = { content: "stale-build" };
  const notice = { hidden: true };
  let reloadClick: (() => void) | undefined;
  const document = {
    querySelector: (selector: string) => {
      if (selector === "[data-coding-composer-input]") return composer;
      if (selector === "meta[name=\"roster-coding-build\"]") return meta;
      if (selector === "[data-coding-build-mismatch]") return notice;
      if (selector === "[data-coding-build-reload]") {
        return { addEventListener: (_type: string, listener: () => void) => { reloadClick = listener; } };
      }
      return null;
    },
  } as unknown as Document;
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error("storage unavailable"); },
  } as unknown as Storage;
  const originalWindow = globalThis.window;
  let reloaded = false;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { reload: () => { reloaded = true; } } },
  });
  try {
    initializeCodingBuildGuard(document, storage);
    reloadClick?.();
    assert.equal(composer.value, "do not lose this message");
    assert.equal(reloaded, false);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("browser build guard tolerates an unavailable session storage getter", () => {
  assert.equal(resolveCodingBuildStorage(() => { throw new Error("storage unavailable"); }), undefined);
});
