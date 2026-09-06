import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputDir = path.join(root, "public", "assets");

await fs.mkdir(outputDir, { recursive: true });
await build({
  entryPoints: [path.join(root, "src", "browser", "replay-client.ts")],
  outfile: path.join(outputDir, "replay-client.js"),
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
