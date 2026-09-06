import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CODING_PI_EXTENSION_PACKAGES = ["@cortexkit/aft-pi"] as const;

type PiPackageManifest = {
  readonly pi?: {
    readonly extensions?: unknown;
  };
};

const packageRequire = createRequire(import.meta.url);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

const uniqueStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
};

export const piExtensionPathsFromManifest = (
  packageRoot: string,
  manifest: PiPackageManifest,
): ReadonlyArray<string> => {
  const extensions = manifest.pi?.extensions;
  if (!Array.isArray(extensions)) return [];
  return extensions
    .filter((extension): extension is string => typeof extension === "string" && extension.trim().length > 0)
    .map((extension) => resolve(packageRoot, extension));
};

const validPackageSegment = (segment: string): boolean =>
  segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\");

const packagePathSegments = (packageName: string): ReadonlyArray<string> | undefined => {
  const segments = packageName.split("/");
  if (packageName.startsWith("@")) {
    return segments.length === 2 && segments.every(validPackageSegment) ? segments : undefined;
  }
  return segments.length === 1 && validPackageSegment(segments[0]) ? segments : undefined;
};

const findNodeModulesManifest = (packageName: string): string | undefined => {
  const segments = packagePathSegments(packageName);
  if (!segments) return undefined;
  let directory = moduleDirectory;
  while (true) {
    const candidate = join(directory, "node_modules", ...segments, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

const findPackageManifest = (packageName: string): string | undefined => {
  const nodeModulesManifest = findNodeModulesManifest(packageName);
  if (nodeModulesManifest) return nodeModulesManifest;
  try {
    const entrypoint = packageRequire.resolve(packageName);
    let directory = dirname(entrypoint);
    while (true) {
      const candidate = join(directory, "package.json");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  } catch {
    return undefined;
  }
};

export const resolvePiExtensionPackagePaths = (
  packageNames: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  uniqueStrings(packageNames.flatMap((packageName) => {
    try {
      const manifestPath = findPackageManifest(packageName);
      if (!manifestPath) return [];
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PiPackageManifest;
      return piExtensionPathsFromManifest(dirname(manifestPath), manifest).filter((extensionPath) =>
        existsSync(extensionPath));
    } catch {
      return [];
    }
  }));
