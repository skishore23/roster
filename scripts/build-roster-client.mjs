import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputDir = path.join(root, "public", "assets");

await fs.mkdir(outputDir, { recursive: true });
await build({
  entryPoints: [path.join(root, "src", "browser", "roster-browser.ts")],
  outfile: path.join(outputDir, "roster-client.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  charset: "utf8",
  legalComments: "none",
  minify: true,
  sourcemap: false,
  treeShaking: true,
  logLevel: "info",
});

await build({
  entryPoints: [path.join(root, "src", "browser", "roster-shell.ts")],
  outfile: path.join(outputDir, "roster-shell.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  charset: "utf8",
  legalComments: "eof",
  minify: true,
  sourcemap: false,
  treeShaking: true,
  logLevel: "info",
});
