import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const CODING_BUILD_SCHEMA = "roster.coding-build.v1";

const normalizeCodingBuildPath = (inputPath) => path.posix.normalize(inputPath.replaceAll("\\", "/"));

export function codingBuildFingerprint(entries) {
  const hash = createHash("sha256");
  hash.update(`${CODING_BUILD_SCHEMA}\0`, "utf8");
  const normalizedEntries = entries.map((entry) => ({
    ...entry,
    path: normalizeCodingBuildPath(entry.path),
  }));
  normalizedEntries.sort((left, right) => Buffer.compare(
    Buffer.from(left.path, "utf8"),
    Buffer.from(right.path, "utf8"),
  ));
  for (const entry of normalizedEntries) {
    const normalizedPath = entry.path;
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
