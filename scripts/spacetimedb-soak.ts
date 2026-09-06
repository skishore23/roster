import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runSpacetimeSoak } from "../src/evals/spacetimedb-soak.js";

const execFileAsync = promisify(execFile);

const integer = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
};

const duration = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite duration`);
  return value;
};

const providerCommand = (): ReadonlyArray<string> | undefined => {
  const raw = process.env.ROSTER_SOAK_PROVIDER_COMMAND_JSON?.trim();
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)
    || parsed.length < 1
    || parsed.length > 32
    || !parsed.every((value) => typeof value === "string" && value.length > 0 && value.length <= 2_000)) {
    throw new Error("ROSTER_SOAK_PROVIDER_COMMAND_JSON must be a bounded JSON argv array");
  }
  return parsed;
};

const command = providerCommand();
if ((process.env.ROSTER_SOAK_REQUIRE_PROVIDER === "1" || process.argv.includes("--require-provider")) && !command) {
  throw new Error("Production soak requires ROSTER_SOAK_PROVIDER_COMMAND_JSON for a real provider probe");
}
const providerProbe = command
  ? async (iteration: number): Promise<void> => {
      const [executable, ...args] = command;
      await execFileAsync(executable!, [...args, String(iteration)], {
        timeout: duration("ROSTER_SOAK_PROVIDER_TIMEOUT_MS", 180_000),
        maxBuffer: 1_048_576,
        env: { ...process.env, ROSTER_SOAK_PROVIDER_ITERATION: String(iteration) },
      });
    }
  : undefined;

const soakWorkspaceId = process.env.ROSTER_SOAK_WORKSPACE_ID?.trim()
  || process.env.ROSTER_WORKSPACE_ID?.trim();
const evidence = await runSpacetimeSoak({
  ...(soakWorkspaceId ? { workspaceId: soakWorkspaceId } : {}),
  eventCount: integer("ROSTER_SOAK_EVENTS", 2_000),
  providerCallCount: providerProbe ? integer("ROSTER_SOAK_PROVIDER_CALLS", 5) : 0,
  eventP95Ms: duration("ROSTER_SOAK_EVENT_P95_MS", 250),
  reconnectP95Ms: duration("ROSTER_SOAK_RECONNECT_P95_MS", 5_000),
  workerRecoveryP95Ms: duration("ROSTER_SOAK_WORKER_RECOVERY_P95_MS", 8_000),
  providerP95Ms: duration("ROSTER_SOAK_PROVIDER_P95_MS", 180_000),
  ...(providerProbe ? { providerProbe } : {}),
});

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
if (!evidence.passed) process.exitCode = 1;
