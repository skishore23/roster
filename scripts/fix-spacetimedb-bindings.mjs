import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bindingsDir = path.join(repoRoot, "src/spacetimedb-bindings");

const visit = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(target);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = fs.readFileSync(target, "utf8");
    const normalized = source
      .replace(
        /(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
        (_match, prefix, specifier, suffix) => {
          if (/\.(?:js|json|mjs|cjs)$/.test(specifier)) return `${prefix}${specifier}${suffix}`;
          return `${prefix}${specifier}.js${suffix}`;
        }
      )
      .replace(/\s+$/, "\n");
    if (normalized !== source) fs.writeFileSync(target, normalized);
  }
};

visit(bindingsDir);
