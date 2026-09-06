import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const source = (relativePath: string): Promise<string> =>
  fs.readFile(path.join(ROOT, relativePath), "utf8");

const section = (value: string, start: string, end: string): string => {
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return value.slice(from, to);
};

test("task context repository placement is snapshotted before reducer-owned execution starts", async () => {
  const [moduleSource, platformSource, controlSource] = await Promise.all([
    source("spacetimedb/src/index.ts"),
    source("src/engine/platform/roster-platform.ts"),
    source("src/adapters/spacetimedb-task-graph-control.ts"),
  ]);
  const initialize = section(
    moduleSource,
    "export const initializeRosterExecution",
    "export const ensureRosterExecution",
  );

  assert.match(platformSource, /repository:\s*options\.contextRepository\(seedTasks\[0\]\)/);
  assert.match(controlSource, /initialContextFrontier:\s*\{[\s\S]*repository:\s*input\.repository/s);
  assert.match(initialize, /parseRosterTaskRepositoryPlacement\(\s*["']contextFrontierJson\.repository["']/);
  assert.match(initialize, /frontierJson:\s*canonicalJson\([^,]+,\s*authoritativeFrontierRecord/);
});

test("startRosterTask reconstructs manifest identity and inclusions from reducer-owned rows", async () => {
  const moduleSource = await source("spacetimedb/src/index.ts");
  const authority = section(
    moduleSource,
    "const authoritativeRosterTaskContextManifest",
    "export const startRosterTask",
  );
  const start = section(
    moduleSource,
    "export const startRosterTask",
    "export const acceptRosterTaskOutcome",
  );

  for (const evidence of [
    "task.inputManifestJson",
    "rosterTaskEdge.taskKey.filter",
    "rosterTaskDefinition.id.find",
    "rosterTaskOutcome.outcomeId.find",
    "outcome.artifactsJson",
    "rosterTaskOutputReference.taskKey.filter",
    "rosterContextFrontier.id.find",
    "frontier.frontierJson",
    "room.activeRunId",
  ]) {
    assert.match(authority, new RegExp(evidence.replaceAll(".", "\\.")));
  }
  assert.match(authority, /effectiveRosterTask\(ctx, execution\.runId, declaredDependency\)/);
  for (const field of [
    "includedInputIds",
    "includedArtifactIds",
    "includedReferenceIds",
    "excludedUnfinishedInputIds",
  ]) {
    assert.match(authority, new RegExp(`${field}: sortedRosterTaskContextIds`));
  }
  assert.match(authority, /contextVersion\s*=\s*`context_\$\{rosterHashCanonical\(identity\)/);
  assert.match(authority, /manifestId\s*=\s*`context_manifest_\$\{rosterHashCanonical/);
  assert.doesNotMatch(
    authority,
    /frontier\.(?:frontierVersion|topologyVersion|catalogVersion)\s*!==\s*task\./,
    "run-scoped repository placement must not reject admitted dynamic task versions",
  );

  assert.match(start, /authoritativeRosterTaskContextManifest\(/);
  assert.match(start, /canonicalJson\(["']Claimed task context manifest["'][\s\S]*authoritativeManifest\.canonicalManifestJson/);
  assert.match(start, /manifestId,\s*contextVersion,\s*canonicalManifestJson[\s\S]*=\s*authoritativeManifest/);
  assert.doesNotMatch(
    start,
    /claimedManifest\.(?:repository|includedInputIds|includedArtifactIds|includedReferenceIds|excludedUnfinishedInputIds)/,
    "caller-selected placement and inclusion sets must never become reducer authority",
  );
});
