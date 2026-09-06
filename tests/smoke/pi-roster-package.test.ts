import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../packages/pi-roster/", import.meta.url);
const read = (path: string): Promise<string> => readFile(new URL(path, root), "utf8");

test("Pi package exposes the versioned Roster coding control surface", async () => {
  const manifest = JSON.parse(await read("package.json")) as {
    readonly name?: string;
    readonly engines?: { readonly node?: string };
    readonly keywords?: ReadonlyArray<string>;
    readonly pi?: {
      readonly extensions?: ReadonlyArray<string>;
      readonly skills?: ReadonlyArray<string>;
      readonly prompts?: ReadonlyArray<string>;
    };
    readonly peerDependencies?: Readonly<Record<string, string>>;
  };
  const [extension, client, contracts, skill] = await Promise.all([
    read("extensions/roster.ts"),
    read("src/client.ts"),
    read("src/contracts.ts"),
    read("skills/roster-coding/SKILL.md"),
  ]);

  assert.equal(manifest.name, "@roster/pi");
  assert.equal(manifest.engines?.node, ">=22.19.0");
  assert.ok(manifest.keywords?.includes("pi-package"));
  assert.deepEqual(manifest.pi, {
    extensions: ["./extensions"],
    skills: ["./skills"],
    prompts: ["./prompts"],
  });
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
  assert.match(client, /\/api\/v2\/coding/);
  assert.match(client, /diff\?runId=/);
  assert.match(contracts, /roster\.coding\.v2/);
  assert.match(contracts, /RosterReviewPolicy/);
  assert.match(client, /http:\/\/127\.0\.0\.1:8787/);
  for (const command of ["roster-code", "roster-runs", "roster-attach", "roster-steer", "roster-diff", "roster-abort"]) {
    assert.match(extension, new RegExp(`registerCommand\\(\"${command}\"`));
  }
  assert.match(extension, /sessionManager\.getBranch\(\)/);
  assert.match(extension, /--fast/);
  assert.match(extension, /--reviewed/);
  assert.match(extension, /--pi/);
  assert.match(extension, /--hermes/);
  assert.match(contracts, /RosterWorkerRuntime/);
  assert.doesNotMatch(extension, /appendEntry\([^\n]*ROSTER_API_TOKEN/);
  assert.match(skill, /durable `roster\/<run-id>` branch/);
  assert.match(skill, /Roster's versioned JSON API and durable receipts are authoritative/);
});
