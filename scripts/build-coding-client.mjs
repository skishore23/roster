import { build, version as esbuildVersion } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  codingBuildFingerprint,
  writeCodingBuildManifest,
} from "./coding-build-manifest.mjs";

const CODING_ENTRIES = [
  ["src/browser/coding-client.ts", "public/assets/coding-client.js"],
  [
    "src/browser/coding-enhancements.ts",
    "public/assets/coding-enhancements.js",
    ["./coding-mermaid-renderer.js"],
  ],
  ["src/browser/coding-mermaid-renderer.ts", "public/assets/coding-mermaid-renderer.js"],
];
const CODING_BUILD_RECIPE_INPUTS = [
  "scripts/build-coding-client.mjs",
  "scripts/coding-build-manifest.mjs",
];

const buildBrowserEntry = (
  root,
  entryPoint,
  output,
  external = [],
  buildOptions = {},
) => build({
  absWorkingDir: root,
  entryPoints: [entryPoint],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  charset: "utf8",
  legalComments: "none",
  minify: true,
  sourcemap: false,
  treeShaking: true,
  external,
  logLevel: "info",
  ...buildOptions,
});

const normalizeInputPath = (root, inputPath) => {
  const absolutePath = path.isAbsolute(inputPath) ? inputPath : path.resolve(root, inputPath);
  return path.posix.normalize(path.relative(root, absolutePath).replaceAll("\\", "/"));
};

const discoverBrowserInputs = (root) => Promise.all(CODING_ENTRIES.map(
  ([entryPoint, output, external = []]) => buildBrowserEntry(root, entryPoint, output, external, {
    write: false,
    metafile: true,
    logLevel: "silent",
  }),
));

const discoverServerViewInputs = (root) => build({
  absWorkingDir: root,
  entryPoints: ["src/views/coding.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  write: false,
  metafile: true,
  logLevel: "silent",
});

export async function discoverCodingBuildFingerprintEntries(repositoryRoot = process.cwd()) {
  const root = path.resolve(repositoryRoot);
  const [browserResults, serverViewResult] = await Promise.all([
    discoverBrowserInputs(root),
    discoverServerViewInputs(root),
  ]);
  const sourcePaths = new Set([
    ...browserResults.flatMap(({ metafile }) => Object.keys(metafile.inputs)),
    ...Object.keys(serverViewResult.metafile.inputs),
    ...CODING_BUILD_RECIPE_INPUTS,
  ].map((inputPath) => normalizeInputPath(root, inputPath)));
  const sourceEntries = await Promise.all([...sourcePaths].map(async (inputPath) => ({
    path: inputPath,
    bytes: await fs.readFile(path.join(root, inputPath)),
  })));
  return [
    ...sourceEntries,
    { path: "@roster/toolchain/esbuild", bytes: `esbuild@${esbuildVersion}\n` },
  ];
}

export async function buildCodingClient(repositoryRoot = process.cwd()) {
  const root = path.resolve(repositoryRoot);
  const publicDirectory = path.join(root, "public");
  await fs.mkdir(path.join(publicDirectory, "assets"), { recursive: true });
  const fingerprint = codingBuildFingerprint(
    await discoverCodingBuildFingerprintEntries(root),
  );

  await Promise.all(CODING_ENTRIES.map(
    ([entryPoint, output, external = []]) => buildBrowserEntry(root, entryPoint, output, external, {
      define: {
        __ROSTER_CODING_BUILD__: JSON.stringify(fingerprint),
      },
      banner: {
        js: `globalThis.__ROSTER_CODING_BUILD__ = ${JSON.stringify(fingerprint)};`,
      },
    }),
  ));

  await writeCodingBuildManifest(publicDirectory, fingerprint);
  process.stdout.write(`Roster Coding build ${fingerprint}\n`);
  return fingerprint;
}

const launchedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (launchedPath === import.meta.url) await buildCodingClient();
