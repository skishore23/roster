# Coding Build Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web and native Coding surfaces prove that their server-rendered HTML, browser bundle, and staged desktop runtime all come from the same committed UI build.

**Architecture:** The Coding browser build computes one deterministic fingerprint from every bundled input plus the server-rendered Coding view, injects it into each bundle, and writes a validated manifest. The server publishes that fingerprint in page metadata and versioned asset URLs; the client reports a mismatch without hiding the room or losing the composer draft. Desktop staging rejects inconsistent resources before launch, and both launch paths log the same fingerprint.

**Tech Stack:** TypeScript, Node.js ESM, esbuild, server-rendered HTML, browser DOM APIs, Tauri sidecar staging, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-26-natural-agent-chat-and-build-consistency-design.md`

## Global Constraints

- Do not change Roster's dark-green visual identity.
- The fingerprint schema is exactly `roster.coding-build.v1`.
- The fingerprint is lowercase hexadecimal SHA-256 and contains exactly 64 characters.
- The browser must keep room content visible when a mismatch is detected.
- Reloading from the mismatch notice must preserve the current composer draft.
- Development asset responses remain non-cacheable.
- Desktop staging must fail before opening the room when fingerprints disagree.
- No new runtime dependency is permitted; use Node.js crypto, fs, path, and the existing esbuild dependency.
- Preserve unrelated worktree changes and run `npm run verify` before handoff.

---

## File Map

- `scripts/coding-build-manifest.mjs`: deterministic input normalization, hashing, manifest parsing, and manifest writing.
- `scripts/build-coding-client.mjs`: discovers esbuild inputs, computes the fingerprint, injects it into all Coding bundles, and writes the manifest.
- `src/browser/coding-build.ts`: exposes the compile-time browser fingerprint and mismatch/draft helpers.
- `src/runtime/coding-build.ts`: reads and validates the server-side manifest.
- `src/views/coding.ts`: publishes build metadata, query-busts assets, and renders the hidden mismatch notice.
- `src/browser/coding-client.ts`: compares page and bundle fingerprints and controls reload behavior.
- `apps/desktop/scripts/stage-sidecar.mjs`: stages and validates the manifest and browser bundles.
- `src/desktop/runtime.ts`: records the staged runtime fingerprint at startup.
- `scripts/run-coding-web-dev.mjs`: builds assets before starting the web development server.
- `tests/smoke/coding-build-consistency.test.ts`: pure manifest, server page, and client contract tests.
- `apps/desktop/tests/config.test.mjs`: desktop staging allowlist and mismatch tests.

### Task 1: Deterministic Coding build manifest

**Files:**
- Create: `scripts/coding-build-manifest.mjs`
- Modify: `scripts/build-coding-client.mjs`
- Create: `src/browser/coding-build.ts`
- Create: `tests/smoke/coding-build-consistency.test.ts`

**Interfaces:**
- Produces: `codingBuildFingerprint(entries: Array<{ path: string; bytes: Uint8Array | string }>): string`.
- Produces: `parseCodingBuildManifest(value: unknown): { schema: "roster.coding-build.v1"; fingerprint: string }`.
- Produces: `writeCodingBuildManifest(publicDirectory: string, fingerprint: string): Promise<void>`.
- Produces: browser constant `CODING_BROWSER_BUILD: string` compiled from `__ROSTER_CODING_BUILD__`.
- Produces: generated `public/assets/coding-build.json` excluded from source commits just like the other generated bundles.

- [ ] **Step 1: Write the failing hash and manifest tests**

Add a test which imports the ESM helper and proves sorting, byte sensitivity, and strict schema validation:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  codingBuildFingerprint,
  parseCodingBuildManifest,
} from "../../scripts/coding-build-manifest.mjs";

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

test("Coding build manifests reject missing or malformed fingerprints", () => {
  assert.deepEqual(
    parseCodingBuildManifest({ schema: "roster.coding-build.v1", fingerprint: "a".repeat(64) }),
    { schema: "roster.coding-build.v1", fingerprint: "a".repeat(64) },
  );
  assert.throws(() => parseCodingBuildManifest({ schema: "roster.coding-build.v1", fingerprint: "old" }));
  assert.throws(() => parseCodingBuildManifest({ schema: "roster.coding-build.v0", fingerprint: "a".repeat(64) }));
});
```

- [ ] **Step 2: Run the test and verify the helper is missing**

Run: `node --import tsx --test tests/smoke/coding-build-consistency.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/coding-build-manifest.mjs`.

- [ ] **Step 3: Implement deterministic hashing and strict parsing**

Create the helper with path normalization and length-delimited hashing so different path/content boundaries cannot collide:

```js
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const CODING_BUILD_SCHEMA = "roster.coding-build.v1";

export function codingBuildFingerprint(entries) {
  const hash = createHash("sha256");
  hash.update(`${CODING_BUILD_SCHEMA}\0`, "utf8");
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    const normalizedPath = entry.path.split(path.sep).join("/");
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes);
    hash.update(`${Buffer.byteLength(normalizedPath)}:${normalizedPath}:${bytes.byteLength}:`, "utf8");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function parseCodingBuildManifest(value) {
  if (
    value === null || typeof value !== "object" ||
    value.schema !== CODING_BUILD_SCHEMA ||
    typeof value.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.fingerprint)
  ) {
    throw new Error("Invalid Roster Coding build manifest");
  }
  return { schema: CODING_BUILD_SCHEMA, fingerprint: value.fingerprint };
}

export async function writeCodingBuildManifest(publicDirectory, fingerprint) {
  const manifest = parseCodingBuildManifest({ schema: CODING_BUILD_SCHEMA, fingerprint });
  const assetDirectory = path.join(publicDirectory, "assets");
  await mkdir(assetDirectory, { recursive: true });
  await writeFile(path.join(assetDirectory, "coding-build.json"), `${JSON.stringify(manifest)}\n`, "utf8");
}
```

- [ ] **Step 4: Inject the same fingerprint into every Coding bundle**

Refactor `scripts/build-coding-client.mjs` to perform an esbuild discovery pass with `write: false` and `metafile: true`, union the normalized `metafile.inputs` from all Coding entries, add `src/views/coding.ts`, read those files, compute the hash, and run the production bundles with both:

```js
define: {
  __ROSTER_CODING_BUILD__: JSON.stringify(fingerprint),
},
banner: {
  js: `globalThis.__ROSTER_CODING_BUILD__ = ${JSON.stringify(fingerprint)};`,
},
```

The banner deliberately leaves the literal fingerprint in every emitted Coding bundle so desktop staging can validate all three resources, including entries which do not import `coding-build.ts`.

After all bundles finish, call:

```js
await writeCodingBuildManifest(publicDirectory, fingerprint);
process.stdout.write(`Roster Coding build ${fingerprint}\n`);
```

Create `src/browser/coding-build.ts`:

```ts
declare const __ROSTER_CODING_BUILD__: string;

export const CODING_BROWSER_BUILD = typeof __ROSTER_CODING_BUILD__ === "string"
  ? __ROSTER_CODING_BUILD__
  : "";
```

No `.gitignore` edit is needed because the repository already ignores the entire `public/assets/` directory.

- [ ] **Step 5: Build twice and prove the manifest and bundle agree**

Run: `npm run build:coding-client && cp public/assets/coding-build.json /tmp/roster-coding-build-first.json && npm run build:coding-client && diff -u /tmp/roster-coding-build-first.json public/assets/coding-build.json && rg -F "$(node -e 'process.stdout.write(JSON.parse(require(\"fs\").readFileSync(\"public/assets/coding-build.json\",\"utf8\")).fingerprint)')" public/assets/coding-client.js`

Expected: both builds print the same fingerprint, `diff` is empty, and `rg` finds the fingerprint in `coding-client.js`.

- [ ] **Step 6: Run the focused test**

Run: `node --import tsx --test tests/smoke/coding-build-consistency.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/coding-build-manifest.mjs scripts/build-coding-client.mjs src/browser/coding-build.ts tests/smoke/coding-build-consistency.test.ts
git commit -m "build: fingerprint coding browser assets"
```

### Task 2: Server metadata and safe stale-build recovery

**Files:**
- Create: `src/runtime/coding-build.ts`
- Modify: `src/views/coding.ts`
- Modify: `src/browser/coding-build.ts`
- Modify: `src/browser/coding-client.ts`
- Modify: `tests/smoke/coding-build-consistency.test.ts`

**Interfaces:**
- Consumes: `parseCodingBuildManifest` and generated `public/assets/coding-build.json` from Task 1.
- Produces: `readCodingBuildManifest(resourceRoot?: string): CodingBuildManifest`.
- Produces: `initializeCodingBuildGuard(document: Document, storage: Storage): void`.
- Produces: meta selector `meta[name="roster-coding-build"]`, notice selector `[data-coding-build-mismatch]`, reload selector `[data-coding-build-reload]`, and composer selector `[data-coding-composer-input]`.

- [ ] **Step 1: Add failing server-page contract tests**

Extend the smoke test to render the Coding page through its existing exported page helper and assert:

```ts
assert.match(html, /<meta name="roster-coding-build" content="[a-f0-9]{64}">/u);
assert.match(html, /\/assets\/coding-client\.js\?v=[a-f0-9]{64}/u);
assert.match(html, /data-coding-build-mismatch[^>]*hidden/u);
assert.match(html, /New Roster build available/u);
```

Add a temporary resource directory test which writes valid and invalid manifests and calls `readCodingBuildManifest(tempRoot)`.

- [ ] **Step 2: Run the test and verify metadata is absent**

Run: `node --import tsx --test tests/smoke/coding-build-consistency.test.ts`

Expected: FAIL because the page has no `roster-coding-build` meta element.

- [ ] **Step 3: Implement server-side manifest loading**

Create `src/runtime/coding-build.ts` with a cached default-resource read and an uncached explicit-root read for tests:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export interface CodingBuildManifest {
  schema: "roster.coding-build.v1";
  fingerprint: string;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let cachedManifest: CodingBuildManifest | undefined;

export function readCodingBuildManifest(resourceRoot = repositoryRoot): CodingBuildManifest {
  if (resourceRoot === repositoryRoot && cachedManifest) return cachedManifest;
  const value = JSON.parse(readFileSync(path.join(resourceRoot, "public/assets/coding-build.json"), "utf8"));
  if (
    value === null || typeof value !== "object" ||
    value.schema !== "roster.coding-build.v1" ||
    typeof value.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.fingerprint)
  ) {
    throw new Error("Invalid Roster Coding build manifest");
  }
  const manifest: CodingBuildManifest = {
    schema: "roster.coding-build.v1",
    fingerprint: value.fingerprint,
  };
  if (resourceRoot === repositoryRoot) cachedManifest = manifest;
  return manifest;
}
```

- [ ] **Step 4: Publish the page fingerprint and version all Coding assets**

In `src/views/coding.ts`, read the manifest once per page render, HTML-escape the value using the view's existing escaping helper, add the meta element and `data-roster-build`, and append `?v=${fingerprint}` to `coding-client.js`, `coding-enhancements.js`, and `coding-mermaid-renderer.js`.

Render the notice outside the scrollable message list so content remains visible:

```html
<aside class="coding-build-notice" data-coding-build-mismatch hidden role="status">
  <span>New Roster build available.</span>
  <button type="button" data-coding-build-reload>Reload</button>
</aside>
```

Add subdued styling which does not alter the room palette and a `:focus-visible` outline.

- [ ] **Step 5: Add failing browser guard tests**

Test the exported pure comparison and storage key without requiring a full browser DOM:

```ts
import {
  codingBuildMismatch,
  CODING_COMPOSER_DRAFT_KEY,
} from "../../src/browser/coding-build.ts";

assert.equal(codingBuildMismatch("a".repeat(64), "a".repeat(64)), false);
assert.equal(codingBuildMismatch("a".repeat(64), "b".repeat(64)), true);
assert.equal(CODING_COMPOSER_DRAFT_KEY, "roster.coding.composer-draft.v1");
```

Run: `node --import tsx --test tests/smoke/coding-build-consistency.test.ts`

Expected: FAIL because the comparison and key are not exported.

- [ ] **Step 6: Implement mismatch display and draft-preserving reload**

Add to `src/browser/coding-build.ts`:

```ts
export const CODING_COMPOSER_DRAFT_KEY = "roster.coding.composer-draft.v1";

export function codingBuildMismatch(pageBuild: string | null, browserBuild: string): boolean {
  return typeof pageBuild === "string" && pageBuild.length > 0 && pageBuild !== browserBuild;
}
```

In `src/browser/coding-client.ts`, call an `initializeCodingBuildGuard()` during startup. It must restore a stored draft only when the current composer is empty, remove the stored value after restoration, show the notice only on mismatch, and on reload click write the current composer value to `sessionStorage` before `window.location.reload()`.

Do not auto-reload. Do not disable reading, scrolling, or sending the current room message.

- [ ] **Step 7: Run focused build/page tests**

Run: `npm run build:coding-client && node --import tsx --test tests/smoke/coding-build-consistency.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/coding-build.ts src/views/coding.ts src/browser/coding-build.ts src/browser/coding-client.ts tests/smoke/coding-build-consistency.test.ts
git commit -m "feat: detect stale coding ui builds"
```

### Task 3: Desktop staging validation and startup diagnostics

**Files:**
- Modify: `apps/desktop/scripts/stage-sidecar.mjs`
- Modify: `apps/desktop/tests/config.test.mjs`
- Modify: `src/desktop/runtime.ts`

**Interfaces:**
- Consumes: `public/assets/coding-build.json` and fingerprinted Coding bundles from Tasks 1-2.
- Produces: staged `runtime/public/assets/coding-build.json`.
- Produces: startup diagnostic line beginning `Roster Coding build ` and ending with the 64-character fingerprint.
- Produces: staging failure containing `Coding build fingerprint mismatch`.

- [ ] **Step 1: Add failing desktop resource tests**

Extend `apps/desktop/tests/config.test.mjs` to assert the staging allowlist includes `coding-build.json`. Export the staging validator from `stage-sidecar.mjs` and test a temporary resource tree containing a valid manifest plus bundles with the same fingerprint, then mutate one bundle and assert:

```js
assert.throws(
  () => validateCodingBuildResources(resourceRoot),
  /Coding build fingerprint mismatch/u,
);
```

- [ ] **Step 2: Run desktop config tests and verify failure**

Run: `node --test apps/desktop/tests/config.test.mjs`

Expected: FAIL because the allowlist and validator do not include the manifest.

- [ ] **Step 3: Stage and validate the exact build**

In `stage-sidecar.mjs`, add `coding-build.json` to the existing Coding asset allowlist. Implement `validateCodingBuildResources(resourceRoot)` to parse the staged manifest, read every staged Coding JavaScript bundle, and require the 64-character fingerprint to occur literally in each bundle. Throw:

```js
throw new Error(`Coding build fingerprint mismatch in staged asset '${assetName}'`);
```

Call the validator after copy completion and before reporting staging success.

- [ ] **Step 4: Log the staged fingerprint at native runtime startup**

In `src/desktop/runtime.ts`, call `readCodingBuildManifest()` after `process.chdir(runtime.cwd)` and before importing the server, then emit exactly one line to the sidecar's inherited standard output:

```ts
process.stdout.write(`Roster Coding build ${codingBuild.fingerprint}\n`);
```

The line must not include the database URI, tokens, or filesystem environment variables.

- [ ] **Step 5: Run desktop tests and staging**

Run: `node --test apps/desktop/tests/config.test.mjs && npm --prefix apps/desktop run sidecar:stage`

Expected: PASS, and staging output identifies one fingerprint.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/scripts/stage-sidecar.mjs apps/desktop/tests/config.test.mjs src/desktop/runtime.ts
git commit -m "fix: validate desktop coding build resources"
```

### Task 4: One explicit web launch path

**Files:**
- Create: `scripts/run-coding-web-dev.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `tests/smoke/coding-build-consistency.test.ts`

**Interfaces:**
- Produces: `npm run coding:web` which builds Coding assets once before starting `src/local.ts` in watch mode.
- Consumes: the current process environment without hardcoding a database, port, repository, or model.

- [ ] **Step 1: Add a failing launch-script contract test**

Read `package.json` and the script source in the smoke test and assert:

```ts
assert.equal(packageJson.scripts["coding:web"], "node scripts/run-coding-web-dev.mjs");
assert.match(launchScript, /build:coding-client/u);
assert.match(launchScript, /src\/local\.ts/u);
assert.doesNotMatch(launchScript, /roster-local|127\.0\.0\.1:3000/u);
```

- [ ] **Step 2: Run the test and verify the script is absent**

Run: `node --import tsx --test tests/smoke/coding-build-consistency.test.ts`

Expected: FAIL because `coding:web` is undefined.

- [ ] **Step 3: Implement the launch supervisor**

Create an ESM script using `spawn` with `stdio: "inherit"`. Run `npm run build:coding-client` first; only after exit code 0, spawn `node --watch --import tsx src/local.ts` with the unchanged environment. Forward `SIGINT` and `SIGTERM` to the active child and propagate non-zero exit codes.

Add:

```json
"coding:web": "node scripts/run-coding-web-dev.mjs"
```

Document `npm run coding:web` as the supported web launch command and `npm run desktop:dev` as the native command. State that both print `Roster Coding build ` followed by the 64-character fingerprint and must agree when comparing the same checkout.

- [ ] **Step 4: Run focused tests and smoke-start the web path**

Run: `node --import tsx --test tests/smoke/coding-build-consistency.test.ts`

Expected: PASS.

Run: `npm run coding:web`

Expected: the build completes before the server starts and prints the fingerprint. Stop the process with Ctrl-C after `/coding` responds.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-coding-web-dev.mjs package.json README.md tests/smoke/coding-build-consistency.test.ts
git commit -m "dev: add consistent coding web launch"
```

### Task 5: Cross-surface verification

**Files:**
- None; this task verifies the committed implementation. Any failure returns to the owning task's explicit test and commit cycle.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: one verified fingerprint visible in web HTML, browser bundles, and staged native resources.

- [ ] **Step 1: Run the complete focused suite**

Run: `npm run build:coding-client && node --import tsx --test tests/smoke/coding-build-consistency.test.ts && node --test apps/desktop/tests/config.test.mjs`

Expected: PASS.

- [ ] **Step 2: Run repository verification**

Run: `npm run verify`

Expected: PASS with no type, lint, unit, smoke, or generated-resource failures.

- [ ] **Step 3: Launch web and native surfaces**

In terminal one run `npm run coding:web`. In terminal two run `npm run desktop:dev`. Record the fingerprint printed by each process. Open `/coding` in the web surface and the same repository room in desktop.

Expected: both processes print the same 64-character fingerprint; page metadata, the asset query parameter, and the desktop runtime agree.

- [ ] **Step 4: Exercise mismatch recovery**

With the web server still running, enter an unsent composer draft, rebuild the Coding client once, and refresh the page HTML without reloading the old bundle.

Expected: the room remains visible, the notice says `New Roster build available`, clicking `Reload` reloads once, and the composer draft is restored.

- [ ] **Step 5: Confirm the verified tree is clean**

Run: `git status --short`

Expected: no output. If a verification failure required a change, return to the task that owns that file, repeat its failing-test/pass cycle, and use that task's explicit `git add` and commit command before repeating this verification task.
