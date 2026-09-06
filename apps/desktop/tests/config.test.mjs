import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateCodingBuildResources } from "../scripts/stage-sidecar.mjs";

const appRoot = new URL("../", import.meta.url);
const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, appRoot), "utf8"));

test("Tauri package identity and frontend paths are stable", async () => {
  const config = await readJson("src-tauri/tauri.conf.json");
  assert.equal(config.productName, "Roster");
  assert.equal(config.identifier, "ai.roster.desktop");
  assert.equal(config.build.devUrl, "http://127.0.0.1:1420");
  assert.equal(config.build.frontendDist, "../dist");
  assert.deepEqual(config.app.security.capabilities, ["main"]);
  assert.equal(config.app.windows[0].minWidth, 840);
  assert.equal(config.app.windows[0].minHeight, 600);
});

test("desktop capability exposes only the native folder dialog", async () => {
  const capability = await readJson("src-tauri/capabilities/main.json");
  assert.deepEqual(capability.windows, ["main"]);
  assert.ok(capability.permissions.includes("dialog:allow-open"));
  assert.deepEqual(capability.permissions, ["core:default", "dialog:allow-open"]);
});

test("production CSP permits managed SpacetimeDB without permitting arbitrary remote code", async () => {
  const config = await readJson("src-tauri/tauri.conf.json");
  const csp = config.app.security.csp;
  assert.match(csp, /wss:\/\/maincloud\.spacetimedb\.com/);
  assert.match(csp, /http:\/\/127\.0\.0\.1:3000/);
  assert.match(csp, /ws:\/\/127\.0\.0\.1:3000/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(csp, /https: \*/);
});

test("desktop keeps SpacetimeDB selection in the backend", async () => {
  const html = await readFile(new URL("index.html", appRoot), "utf8");
  const frontend = await readFile(new URL("src/main.ts", appRoot), "utf8");
  const native = await readFile(new URL("src-tauri/src/lib.rs", appRoot), "utf8");
  const localConfig = await readJson("../../spacetime.json");

  assert.doesNotMatch(html, /spacetimeMode|SpacetimeDB mode|Data environment/);
  assert.doesNotMatch(frontend, /spacetimeMode|selectedSpacetimeMode/);
  assert.match(native, /fn spacetime_config\(\)/);
  assert.match(native, /unwrap_or_else\(\|\| "local"\.to_string\(\)\)/);
  assert.match(native, /ROSTER_SPACETIME_LOCAL_URI/);
  assert.match(native, /ROSTER_SPACETIME_PRODUCTION_URI/);
  assert.match(native, /ROSTER_SPACETIME_MODE/);
  assert.deepEqual(localConfig, {
    server: "local",
    database: "roster-local",
    "module-path": "./spacetimedb",
  });
  assert.match(native, /Set ROSTER_SPACETIME_PRODUCTION_DATABASE to your own deployment/);
});

test("desktop development owns an isolated local SpacetimeDB lifecycle", async () => {
  const packageJson = await readJson("package.json");
  const tauriConfig = await readJson("src-tauri/tauri.conf.json");
  const launcherSource = await readFile(new URL("scripts/run-tauri-dev.mjs", appRoot), "utf8");
  const devControlPlane = await import(new URL("scripts/run-tauri-dev.mjs", appRoot));
  const controlPlane = devControlPlane.desktopDevControlPlane({
    pid: 42,
    now: 1_785_000_000_000,
    port: 31_337,
  });

  assert.equal(packageJson.scripts["tauri:dev"], "node scripts/run-tauri-dev.mjs");
  assert.match(tauriConfig.app.security.devCsp, /http:\/\/127\.0\.0\.1:\*/u);
  assert.match(tauriConfig.app.security.devCsp, /ws:\/\/127\.0\.0\.1:\*/u);
  assert.match(launcherSource, /process\.once\("SIGHUP", stop\)/u);
  assert.equal(controlPlane.uri, "http://127.0.0.1:31337");
  assert.match(controlPlane.database, /^roster-desktop-dev-42-[a-z0-9]+$/u);
  assert.deepEqual(controlPlane.environment, {
    ROSTER_SPACETIME_MODE: "local",
    ROSTER_SPACETIME_LOCAL_URI: controlPlane.uri,
    ROSTER_SPACETIME_LOCAL_DATABASE: controlPlane.database,
  });
  assert.deepEqual(
    devControlPlane.spacetimeStartArguments({
      port: 31_337,
      dataDirectory: "/tmp/roster-desktop-dev",
    }),
    [
      "start",
      "--listen-addr",
      "127.0.0.1:31337",
      "--data-dir",
      "/tmp/roster-desktop-dev",
      "--in-memory",
      "--non-interactive",
    ],
  );
  assert.deepEqual(
    devControlPlane.spacetimePublishArguments(controlPlane),
    [
      "publish",
      controlPlane.database,
      "--server",
      controlPlane.uri,
      "--module-path",
      "spacetimedb",
      "--yes",
      "--no-config",
    ],
  );
});

test("production bundles require the target-named Roster runtime", async () => {
  const config = await readJson("src-tauri/tauri.conf.json");
  assert.deepEqual(config.bundle.externalBin, ["binaries/roster-runtime"]);

  const packageJson = await readJson("package.json");
  assert.match(packageJson.scripts["tauri:build"], /^npm run sidecar:stage && /);
  assert.equal(packageJson.scripts["tauri:dev"], "node scripts/run-tauri-dev.mjs");
  assert.match(packageJson.scripts.verify, /npm run test:native/);
  assert.doesNotMatch(packageJson.scripts.verify, /tauri:info/);
});

test("sidecar staging includes a relocatable bundled Pi launcher", async () => {
  const source = await readFile(new URL("scripts/stage-sidecar.mjs", appRoot), "utf8");
  assert.match(source, /@earendil-works\/pi-coding-agent\/dist\/cli\.js/);
  assert.match(source, /bundledRuntimeBin/);
  assert.match(source, /bundledNode/);
  assert.match(source, /assertStagedAgentModules/);
  assert.match(source, /\.agent\.js/);
  assert.match(source, /desktopAgentModules = \["coding\.agent\.js"\]/);
  assert.match(source, /pruneStagedAgentModules/);
  assert.match(source, /desktopPublicAssets = \[/);
  assert.match(source, /stageCodingBuildResources/);
  assert.match(source, /assertStagedPublicAssets/);
  assert.match(source, /coding-build\.json/u);
});

test("sidecar staging rejects Coding bundles whose fingerprint differs from its manifest", async () => {
  const resourceRoot = await mkdtemp(path.join(os.tmpdir(), "roster-desktop-coding-build-"));
  const assets = path.join(resourceRoot, "public", "assets");
  const fingerprint = "a".repeat(64);
  try {
    await mkdir(assets, { recursive: true });
    await writeFile(path.join(assets, "coding-build.json"), JSON.stringify({
      schema: "roster.coding-build.v1",
      fingerprint,
    }));
    await Promise.all([
      "coding-client.js",
      "coding-enhancements.js",
      "coding-mermaid-renderer.js",
    ].map((assetName) => writeFile(path.join(assets, assetName), `export const build = "${fingerprint}";\n`)));

    assert.deepEqual(validateCodingBuildResources(resourceRoot), {
      schema: "roster.coding-build.v1",
      fingerprint,
    });

    await writeFile(path.join(assets, "coding-enhancements.js"), "export const build = \"stale\";\n");
    assert.throws(
      () => validateCodingBuildResources(resourceRoot),
      /Coding build fingerprint mismatch/u,
    );
  } finally {
    await rm(resourceRoot, { recursive: true, force: true });
  }
});

test("desktop sidecar exposes only the repository agent surface", async () => {
  const native = await readFile(new URL("src-tauri/src/lib.rs", appRoot), "utf8");
  const runtimeConfig = await readFile(new URL("../../src/desktop/runtime-config.ts", appRoot), "utf8");
  const server = await readFile(new URL("../../src/server.ts", appRoot), "utf8");

  assert.match(native, /"ROSTER_SERVER_SURFACE", "repository"/);
  assert.match(runtimeConfig, /ROSTER_SERVER_SURFACE: "repository"/);
  assert.match(server, /serverSurfaceAllowsPath\(SERVER_SURFACE, c\.req\.path\)/);
  assert.match(server, /selectServerSurfaceJobHandlers\(SERVER_SURFACE/);
  assert.match(server, /serverSurfaceAgentModuleNames\(SERVER_SURFACE\)/);
});

test("desktop chooses a local default agent without forwarding OpenAI API auth", async () => {
  const html = await readFile(new URL("index.html", appRoot), "utf8");
  const frontend = await readFile(new URL("src/main.ts", appRoot), "utf8");
  const native = await readFile(new URL("src-tauri/src/lib.rs", appRoot), "utf8");
  const runtime = await readFile(new URL("../../src/desktop/runtime.ts", appRoot), "utf8");
  const localOnly = await readFile(new URL("../../src/runtime/local-only.ts", appRoot), "utf8");

  assert.match(html, /choose the default agent for coding work/i);
  assert.match(frontend, /defaultInput\.name = "defaultRuntime"/);
  assert.match(frontend, /defaultRuntimeId/);
  assert.match(frontend, /defaultRuntimeId,\s*\n\s*\}\);/);
  assert.match(native, /default_runtime_id: String/);
  assert.match(native, /ROSTER_DESKTOP_DEFAULT_RUNTIME_ID/);
  assert.match(native, /document\.default_runtime_id/);
  assert.match(native, /ROSTER_CODING_LOCAL_ONLY/);
  assert.match(native, /ROSTER_CODING_DEFAULT_RUNTIME/);
  assert.match(runtime, /applyRosterLocalOnlyEnvironment\(\)/);
  assert.match(runtime, /ROSTER_AGENT_MODULES_DIR/);
  assert.match(runtime, /new URL\("\.\.\/agents", import\.meta\.url\)/);
  assert.match(localOnly, /env\.OPENAI_API_KEY = ""/);
});

test("Finder-launched macOS builds discover trusted CLI install locations", async () => {
  const frontend = await readFile(new URL("src/main.ts", appRoot), "utf8");
  const native = await readFile(new URL("src-tauri/src/lib.rs", appRoot), "utf8");

  assert.match(native, /fn macos_runtime_directories\(/);
  assert.match(native, /home\.join\("\.local\/bin"\)/);
  assert.match(native, /home\.join\("\.local\/share\/pnpm"\)/);
  assert.match(native, /\/opt\/homebrew\/bin/);
  assert.match(native, /\/Applications\/ChatGPT\.app\/Contents\/Resources/);
  assert.match(native, /preferred_directories[\s\S]*path_directories[\s\S]*fallback_directories/);
  assert.match(native, /fn validate_runtime_profiles_json\([\s\S]*desktop_runtime_directories\(app\)/);
  assert.doesNotMatch(native, /(?:bash|zsh|sh)\s+-lc/);
  assert.match(frontend, /: "Not found";/);
});

test("desktop reopens a saved valid repository without repeating onboarding", async () => {
  const frontend = await readFile(new URL("src/main.ts", appRoot), "utf8");
  const native = await readFile(new URL("src-tauri/src/lib.rs", appRoot), "utf8");

  assert.match(native, /fn load_saved_desktop_setup\(/);
  assert.match(native, /\.join\("onboarding\.json"\)/);
  assert.match(native, /canonical_repository\(&saved_repository\.path\)/);
  assert.match(native, /load_saved_desktop_setup,/);
  assert.match(frontend, /invoke<SavedDesktopSetup \| null>\("load_saved_desktop_setup"\)/);
  assert.match(frontend, /await discoverRuntimes\(saved\)/);
  assert.match(frontend, /await launchRosterRuntime\(\)/);
  assert.match(frontend, /void resumeSavedSetup\(\)/);
});

test("desktop surfaces bounded sidecar startup diagnostics without waiting for the full timeout", async () => {
  const native = await readFile(new URL("src-tauri/src/lib.rs", appRoot), "utf8");

  assert.match(native, /MAX_STARTUP_DIAGNOSTIC_BYTES/);
  assert.match(native, /CommandEvent::Stderr/);
  assert.match(native, /CommandEvent::Error/);
  assert.match(native, /observation\.terminated/);
  assert.match(native, /local runtime could not start/);
  assert.match(native, /GET \/readyz HTTP\/1\.1/);
  assert.match(native, /ready\.control_plane == "connected"/);
  assert.doesNotMatch(native, /TcpStream::connect_timeout\([^)]*\)\.is_ok\(\)/);
});

test("desktop startup failures keep diagnostics bounded and recoverable", async () => {
  const onboardingHtml = await readFile(new URL("index.html", appRoot), "utf8");
  const frontend = await readFile(new URL("src/main.ts", appRoot), "utf8");

  assert.match(onboardingHtml, /data-runtime-error[^>]*hidden/);
  assert.match(onboardingHtml, /data-retry-runtime/);
  assert.match(onboardingHtml, /data-copy-runtime-error/);
  assert.match(onboardingHtml, /<details[^>]*data-runtime-diagnostics/);
  assert.doesNotMatch(onboardingHtml, /<details[^>]*data-runtime-diagnostics[^>]*\sopen(?:\s|>|=)/);
  assert.match(frontend, /const launchRosterRuntime = createSingleFlightAction\(launchRosterRuntimeAttempt\)/);
  assert.match(frontend, /retryRuntimeButton\.addEventListener\("click", launchRosterRuntime\)/);
  assert.match(frontend, /await copyRuntimeDiagnostic\(\{/);
});

test("desktop restarts when the selected runtime or backend changes", async () => {
  const native = await readFile(new URL("src-tauri/src/lib.rs", appRoot), "utf8");

  assert.match(native, /struct RuntimeConfiguration/);
  assert.match(native, /runtime_profiles_json: String/);
  assert.match(native, /default_runtime_id: String/);
  assert.match(native, /spacetime_uri: String/);
  assert.match(native, /spacetime_database: String/);
  assert.match(native, /process\.configuration == configuration/);
  assert.match(native, /runtime_is_ready\(process\.port\)/);
});

test("desktop sidecar is bounded by the native application lifecycle", async () => {
  const native = await readFile(new URL("src-tauri/src/lib.rs", appRoot), "utf8");
  const runtime = await readFile(new URL("../../src/desktop/runtime.ts", appRoot), "utf8");

  assert.match(native, /impl Drop for RuntimeState/);
  assert.match(native, /ROSTER_DESKTOP_PARENT_PID/);
  assert.match(native, /RunEvent::ExitRequested/);
  assert.match(native, /RunEvent::Exit/);
  assert.match(runtime, /Number\(requiredEnvironment\("ROSTER_DESKTOP_PARENT_PID"\)\)/);
  assert.match(runtime, /process\.kill\(parentProcessId, 0\)/);
  assert.match(runtime, /process\.kill\(process\.pid, "SIGTERM"\)/);
  assert.match(runtime, /parentWatchdog\.unref\(\)/);
});

test("first-run page explains agent cooperation before setup", async () => {
  const source = await readFile(new URL("index.html", appRoot), "utf8");
  const styles = await readFile(new URL("src/styles.css", appRoot), "utf8");
  assert.match(source, /Choose a repository/);
  assert.match(source, /Meet your repository team/);
  assert.match(source, /Open your first room/);
  assert.match(source, /data-onboarding-primary/);
  assert.match(source, /data-workspace-preview/);
  assert.equal((source.match(/data-onboarding-primary/g) ?? []).length, 1);
  assert.match(source, /data-preview-room-rail/);
  assert.match(source, /data-preview-message-skeleton/);
  assert.doesNotMatch(source, /data-preview-node-message/);
  assert.doesNotMatch(source, /I mapped the main execution path|I’m ready to implement/);
  assert.match(source, /data-preview-composer/);
  assert.match(source, /source stay on this device/);
  assert.match(styles, /\.onboarding-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*520px\) minmax\(420px,\s*1fr\)/su);
  assert.match(styles, /@media\s*\(max-width:\s*980px\)[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su);
  assert.doesNotMatch(styles, /position:\s*(?:absolute|fixed)[^}]*\.workspace-preview/su);
  assert.match(styles, /\.setup-column \.runtime-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su);
  assert.match(styles, /\.setup-column \.runtime-controls\s*\{[^}]*flex-wrap:\s*wrap/su);
});
