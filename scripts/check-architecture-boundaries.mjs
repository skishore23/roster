import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sourceRoot = join(repositoryRoot, "src");
const engineRoot = join(sourceRoot, "engine");
const forbiddenEngineLayers = new Set([
  "adapters",
  "agents",
  "desktop",
  "domains",
  "sdk",
  "simulations",
  "views",
]);
const publicSdkEntries = [
  "authoring.ts",
  "capabilities.ts",
  "orchestration.ts",
  "runtime.ts",
  "workspace.ts",
];

const sourceFiles = [];
const collect = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if ([".ts", ".mts", ".cts"].includes(extname(entry.name))) sourceFiles.push(path);
  }
};
collect(engineRoot);

const importSpecifier = /(?:from\s*|import\s*\()["']([^"']+)["']/gu;
const violations = [];

for (const file of sourceFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importSpecifier)) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) continue;
    const target = resolve(dirname(file), specifier);
    const relativeTarget = relative(sourceRoot, target);
    if (relativeTarget.startsWith(`..${sep}`) || relativeTarget === "..") continue;
    const [layer] = relativeTarget.split(sep);
    if (layer && forbiddenEngineLayers.has(layer)) {
      violations.push(`${relative(repositoryRoot, file)} imports ${specifier}`);
    }
  }
}

if (violations.length > 0) {
  throw new Error([
    "Architecture boundary violations:",
    ...violations.map((violation) => `- ${violation}`),
    "Engine code may depend only on core and other engine modules. Product domains, adapters, simulations, views, desktop code, and the public SDK must depend inward.",
  ].join("\n"));
}

for (const entry of publicSdkEntries) {
  const file = join(sourceRoot, "sdk", entry);
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importSpecifier)) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) continue;
    const target = resolve(dirname(file), specifier);
    const relativeTarget = relative(sourceRoot, target);
    const [layer] = relativeTarget.split(sep);
    if (!layer || !["core", "engine", "sdk"].includes(layer)) {
      violations.push(`src/sdk/${entry} imports ${specifier}`);
    }
  }
}

const rootSdkSource = readFileSync(join(sourceRoot, "sdk", "index.ts"), "utf8");
if (!/^export \* from ["']\.\/authoring\.js["'];?\s*$/mu.test(rootSdkSource)) {
  violations.push("src/sdk/index.ts must remain the minimal authoring-only package root");
}

if (violations.length > 0) {
  throw new Error([
    "Public SDK boundary violations:",
    ...violations.map((violation) => `- ${violation}`),
    "Curated SDK entry points may expose only core and engine capabilities; product domains belong in their own packages.",
  ].join("\n"));
}

process.stdout.write(`Architecture boundaries verified (${sourceFiles.length} engine files)\n`);
