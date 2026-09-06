import { spawnSync } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const targetByPlatform = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

const platformKey = `${process.platform}-${process.arch}`;
const targetTriple =
  process.env.TAURI_ENV_TARGET_TRIPLE ?? targetByPlatform[platformKey];

if (!targetTriple) {
  throw new Error(
    `Unsupported desktop target ${platformKey}. Set TAURI_ENV_TARGET_TRIPLE explicitly.`,
  );
}

const appRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(
  process.env.ROSTER_RUNTIME_DIR ?? resolve(appRoot, "..", ".."),
);
const extension = targetTriple.includes("windows") ? ".exe" : "";
const sidecarDestination = resolve(
  appRoot,
  "src-tauri",
  "binaries",
  `roster-runtime-${targetTriple}${extension}`,
);
const runtimeDestination = resolve(appRoot, "src-tauri", "runtime");
const runtimeEntry = resolve(runtimeDestination, "dist", "desktop", "runtime.js");
const checkOnly = process.argv.includes("--check");
const desktopAgentModules = ["coding.agent.js"];
const desktopPublicAssets = [
  "coding-build.json",
  "coding-client.js",
  "coding-enhancements.js",
  "coding-mermaid-renderer.js",
  "roster-shell.js",
];
const codingBuildAssets = desktopPublicAssets.filter((assetName) =>
  assetName.startsWith("coding-") && assetName.endsWith(".js")
);

export const validateCodingBuildResources = (resourceRoot) => {
  const assetsDirectory = resolve(resourceRoot, "public", "assets");
  const manifest = JSON.parse(readFileSync(resolve(assetsDirectory, "coding-build.json"), "utf8"));
  if (
    manifest === null || typeof manifest !== "object"
    || manifest.schema !== "roster.coding-build.v1"
    || typeof manifest.fingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(manifest.fingerprint)
  ) {
    throw new Error("Invalid Roster Coding build manifest");
  }
  for (const assetName of codingBuildAssets) {
    if (!readFileSync(resolve(assetsDirectory, assetName), "utf8").includes(manifest.fingerprint)) {
      throw new Error(`Coding build fingerprint mismatch in staged asset '${assetName}'`);
    }
  }
  return {
    schema: "roster.coding-build.v1",
    fingerprint: manifest.fingerprint,
  };
};

export const stageCodingBuildResources = async (sourceRoot, destinationRoot) => {
  const sourceBuild = validateCodingBuildResources(sourceRoot);
  const sourceAssets = resolve(sourceRoot, "public", "assets");
  const destinationAssets = resolve(destinationRoot, "public", "assets");

  await Promise.all(desktopPublicAssets.map((assetName) =>
    access(resolve(sourceAssets, assetName), constants.R_OK)
  ));
  await rm(destinationAssets, { recursive: true, force: true });
  await mkdir(destinationAssets, { recursive: true });
  for (const assetName of desktopPublicAssets) {
    await copyFile(
      resolve(sourceAssets, assetName),
      resolve(destinationAssets, assetName),
    );
  }

  const stagedBuild = validateCodingBuildResources(destinationRoot);
  const sourceManifest = readFileSync(resolve(sourceAssets, "coding-build.json"));
  const stagedManifest = readFileSync(resolve(destinationAssets, "coding-build.json"));
  if (!sourceManifest.equals(stagedManifest) || stagedBuild.fingerprint !== sourceBuild.fingerprint) {
    throw new Error("Staged desktop Coding build does not byte-match the public manifest");
  }
  return stagedBuild;
};

const agentModuleNames = async (root) => (await readdir(
  resolve(root, "dist", "agents"),
  { withFileTypes: true },
))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".agent.js"))
  .map((entry) => entry.name)
  .sort();

const assertStagedAgentModules = async () => {
  const available = await agentModuleNames(repositoryRoot);
  const missing = desktopAgentModules.filter((moduleName) => !available.includes(moduleName));
  if (missing.length > 0) {
    throw new Error(`Production build is missing desktop agent modules: ${missing.join(", ")}.`);
  }
  const expected = desktopAgentModules;
  const staged = await agentModuleNames(runtimeDestination);
  if (JSON.stringify(staged) !== JSON.stringify(expected)) {
    throw new Error(
      `Staged desktop agents do not match the repository-only allowlist. `
        + `Expected [${expected.join(", ")}], received [${staged.join(", ")}].`,
    );
  }
};

const pruneStagedAgentModules = async () => {
  const directory = resolve(runtimeDestination, "dist", "agents");
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile()
      && entry.name.endsWith(".agent.js")
      && !desktopAgentModules.includes(entry.name))
    .map((entry) => rm(resolve(directory, entry.name), { force: true })));
};

const stagedPublicAssetNames = async () => (await readdir(
  resolve(runtimeDestination, "public", "assets"),
  { withFileTypes: true },
))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();

const assertStagedPublicAssets = async () => {
  const staged = await stagedPublicAssetNames();
  const expected = [...desktopPublicAssets].sort();
  if (JSON.stringify(staged) !== JSON.stringify(expected)) {
    throw new Error(
      `Staged desktop assets do not match the repository-only allowlist. `
        + `Expected [${expected.join(", ")}], received [${staged.join(", ")}].`,
    );
  }
};

const stageSidecar = async () => {
if (checkOnly) {
  await access(sidecarDestination, constants.R_OK);
  await access(runtimeEntry, constants.R_OK);
  await access(resolve(runtimeDestination, "node_modules"), constants.R_OK);
  await assertStagedAgentModules();
  await assertStagedPublicAssets();
  const codingBuild = validateCodingBuildResources(runtimeDestination);
  process.stdout.write(
    `Roster Node sidecar and resource tree are staged for ${targetTriple} with Coding build ${codingBuild.fingerprint}.\n`,
  );
  return;
}

const nodeCandidates = [
  process.env.ROSTER_NODE_BIN,
  ...String(process.env.PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean)
    .map((directory) => resolve(directory, process.platform === "win32" ? "node.exe" : "node")),
  process.execPath,
].filter((value, index, values) =>
  value && values.indexOf(value) === index
);

const isRelocatableNode = async (candidate) => {
  if (!isAbsolute(candidate)) return false;
  if (!await access(candidate, constants.R_OK).then(() => true, () => false)) {
    return false;
  }
  const version = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (version.status !== 0 || !/^v\d+\./u.test(version.stdout.trim())) {
    return false;
  }
  if (process.platform !== "darwin") return true;
  const linked = spawnSync("otool", ["-L", candidate], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (linked.status !== 0) return false;
  return linked.stdout
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter(Boolean)
    .every((library) =>
      library.startsWith("/System/Library/")
      || library.startsWith("/usr/lib/")
    );
};

let nodeSource;
for (const candidate of nodeCandidates) {
  if (await isRelocatableNode(candidate)) {
    nodeSource = candidate;
    break;
  }
}
if (!nodeSource) {
  throw new Error(
    "Could not find a relocatable Node executable. Set ROSTER_NODE_BIN to "
      + "an official Node distribution binary; package-manager launchers with private "
      + "dynamic-library dependencies cannot be bundled safely.",
  );
}

const repositoryEntry = resolve(
  repositoryRoot,
  "dist",
  "desktop",
  "runtime.js",
);
await access(repositoryEntry, constants.R_OK).catch(() => {
  throw new Error(
    `Roster's desktop runtime build is missing at ${repositoryEntry}. `
      + "Run the root repository build before staging the desktop application.",
  );
});
await access(resolve(repositoryRoot, "package-lock.json"), constants.R_OK);

await mkdir(resolve(appRoot, "src-tauri", "binaries"), { recursive: true });
await copyFile(nodeSource, sidecarDestination);
if (process.platform !== "win32") {
  await chmod(sidecarDestination, 0o755);
}
const sidecarVersion = spawnSync(sidecarDestination, ["--version"], {
  encoding: "utf8",
  timeout: 5_000,
});
if (sidecarVersion.status !== 0) {
  throw new Error(
    `The staged Node sidecar is not executable after relocation.\n${sidecarVersion.stderr || sidecarVersion.stdout}`,
  );
}

await rm(runtimeDestination, { recursive: true, force: true });
await mkdir(runtimeDestination, { recursive: true });

for (const resource of ["dist", "prompts"]) {
  const source = resolve(repositoryRoot, resource);
  await access(source, constants.R_OK);
  await cp(source, resolve(runtimeDestination, resource), {
    recursive: true,
    force: true,
  });
}
await stageCodingBuildResources(repositoryRoot, runtimeDestination);
await pruneStagedAgentModules();
await assertStagedAgentModules();
await assertStagedPublicAssets();
const codingBuild = validateCodingBuildResources(runtimeDestination);

for (const manifest of ["package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  await copyFile(
    resolve(repositoryRoot, manifest),
    resolve(runtimeDestination, manifest),
  );
}

const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const install = spawnSync(
  npmExecutable,
  ["ci", "--omit=dev", "--no-audit", "--no-fund"],
  {
    cwd: runtimeDestination,
    env: { ...process.env, NODE_ENV: "production" },
    encoding: "utf8",
  },
);

if (install.status !== 0) {
  throw new Error(
    `Could not install locked production runtime dependencies.\n${install.stderr || install.stdout}`,
  );
}

const bundledRuntimeBin = resolve(runtimeDestination, "bin");
await mkdir(bundledRuntimeBin, { recursive: true });
const bundledNode = resolve(
  bundledRuntimeBin,
  process.platform === "win32" ? "node.exe" : "node",
);
await copyFile(nodeSource, bundledNode);
if (process.platform !== "win32") {
  await chmod(bundledNode, 0o755);
  const bundledPi = resolve(bundledRuntimeBin, "pi");
  await writeFile(
    bundledPi,
    [
      "#!/bin/sh",
      'runtime_bin="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
      'exec "$runtime_bin/node" "$runtime_bin/../node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await chmod(bundledPi, 0o755);
}

process.stdout.write(
  `Staged ${basename(nodeSource)}, bundled Pi, and Roster's production resource tree for ${targetTriple} with Coding build ${codingBuild.fingerprint}.\n`,
);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stageSidecar();
}
