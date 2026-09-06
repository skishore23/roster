import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const forbiddenPaths = [
  "src/engine/runtime/model-tool-loop-node-runtime.ts",
];
for (const path of forbiddenPaths) {
  if (existsSync(join(repositoryRoot, path))) {
    throw new Error(`External harness boundary forbids ${path}`);
  }
}

const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
for (const dependency of ["ai", "@ai-sdk/anthropic", "@ai-sdk/provider"]) {
  if (packageJson.dependencies?.[dependency] || packageJson.devDependencies?.[dependency]) {
    throw new Error(`External harness boundary forbids direct dependency ${dependency}`);
  }
}

const sourceFiles = [];
const collect = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if ([".ts", ".mjs"].includes(extname(entry.name))) sourceFiles.push(path);
  }
};
for (const directory of ["src/engine/runtime", "src/evals"]) {
  collect(join(repositoryRoot, directory));
}
const forbiddenSource = /model-tool-loop|ModelToolLoop|ToolLoopAgent|@ai-sdk\/anthropic|@ai-sdk\/provider|from\s+["']ai["']/u;
for (const path of sourceFiles) {
  if (forbiddenSource.test(readFileSync(path, "utf8"))) {
    throw new Error(`External harness boundary violation in ${relative(repositoryRoot, path)}`);
  }
}

process.stdout.write("External harness boundary verified\n");
