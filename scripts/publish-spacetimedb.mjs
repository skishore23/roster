import "dotenv/config";
import { spawnSync } from "node:child_process";

const uri = process.env.ROSTER_SPACETIME_PRODUCTION_URI?.trim();
const database = process.env.ROSTER_SPACETIME_PRODUCTION_DATABASE?.trim();
if (!uri || !database) {
  console.error("Set ROSTER_SPACETIME_PRODUCTION_URI and ROSTER_SPACETIME_PRODUCTION_DATABASE to your own deployment before publishing.");
  process.exitCode = 1;
} else {
  const url = new URL(uri);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Production URI must be an HTTP(S) endpoint without embedded credentials, query, or fragment");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(database)) throw new Error("Invalid production database name");
  // Retain the CLI's own confirmation. Publishing is always an explicit action.
  const result = spawnSync("spacetime", ["publish", database, "--server", uri, "--module-path", "./spacetimedb", "--no-config"], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
