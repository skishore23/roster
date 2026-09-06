import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const paths = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0"))].filter((path) => path && existsSync(path));
const failures = [];
const forbidden = /^(?:artifacts\/|release\/|\.superpowers\/sdd\/|docs\/private\/|spacetime\.production\.json$)|(?:^|\/)\.env(?:\.|$)(?!example$)|\.(?:pem|key|p12|pfx|dmg|aiff|mp4)$/;
for (const path of paths) {
  const stat = statSync(path);
  if (!stat.isFile()) continue;
  if (forbidden.test(path)) failures.push(`${path}: private or generated material belongs outside public source`);
  if (stat.size > 5 * 1024 * 1024) failures.push(`${path}: source file exceeds 5 MiB; use release assets for generated binaries`);
  if (!/\.(?:md|ts|tsx|js|mjs|json|toml|yml|yaml|sh|rs)$/.test(path)) continue;
  const source = readFileSync(path, "utf8");
  if (/\/Users\/[A-Za-z0-9._-]+\//.test(source)) failures.push(`${path}: contains an absolute developer home path`);
}
for (const path of ["package.json", "packages/pi-roster/package.json", "apps/desktop/package.json", "spacetimedb/package.json"]) {
  const pkg = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (pkg.repository?.url !== "git+https://github.com/skishore23/roster.git") failures.push(`${path}: repository identity differs from Roster`);
  if (pkg.license !== "MIT") failures.push(`${path}: missing MIT package metadata`);
  if (pkg.private !== true) failures.push(`${path}: npm publication requires an owned namespace and a separate release change`);
}
for (const path of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE", "THIRD_PARTY_NOTICES.md", ".env.example"]) {
  if (!existsSync(path)) failures.push(`${path}: missing public project file`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log(`Public source checks passed (${paths.length} files).`);
