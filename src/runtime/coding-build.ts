import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CodingBuildManifest {
  schema: "roster.coding-build.v1";
  fingerprint: string;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function readCodingBuildManifest(resourceRoot = repositoryRoot): CodingBuildManifest {
  const value = JSON.parse(readFileSync(path.join(resourceRoot, "public/assets/coding-build.json"), "utf8"));
  if (
    value === null || typeof value !== "object"
    || value.schema !== "roster.coding-build.v1"
    || typeof value.fingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.fingerprint)
  ) {
    throw new Error("Invalid Roster Coding build manifest");
  }
  const manifest: CodingBuildManifest = {
    schema: "roster.coding-build.v1",
    fingerprint: value.fingerprint,
  };
  return manifest;
}
