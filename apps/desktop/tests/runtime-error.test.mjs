import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { transformWithOxc } from "vite";

const source = await readFile(new URL("../src/runtime-error.ts", import.meta.url), "utf8");
const compiled = (await transformWithOxc(source, "runtime-error.ts", {
  format: "esm",
  target: "es2022",
})).code;
const runtimeErrors = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const {
  MAX_RUNTIME_DIAGNOSTIC_CHARACTERS,
  copyRuntimeDiagnostic,
  createSingleFlightAction,
  presentRuntimeError,
} = runtimeErrors;

const presentation = () => ({
  panel: { hidden: true },
  summary: { textContent: "" },
  diagnostics: { open: true },
  details: { textContent: "" },
  status: { textContent: "" },
});

test("runtime failures render a generic collapsed summary with bounded redacted details", () => {
  const view = presentation();
  const secret = [
    "Authorization: Bearer authorization-secret-value",
    "api_key=api-secret-value",
    "password: password-secret-value",
    "https://alice:hunter2@example.com/start?access_token=query-secret-value&mode=local",
    "x".repeat(MAX_RUNTIME_DIAGNOSTIC_CHARACTERS * 2),
  ].join("\n");

  const diagnostic = presentRuntimeError(view, new Error(secret));

  assert.equal(view.panel.hidden, false);
  assert.equal(view.diagnostics.open, false);
  assert.equal(view.summary.textContent, "Check the local service and try again.");
  assert.equal(view.status.textContent, "Roster couldn’t open this workspace.");
  assert.equal(view.details.textContent, diagnostic);
  assert.ok(diagnostic.length <= MAX_RUNTIME_DIAGNOSTIC_CHARACTERS);
  assert.match(diagnostic, /\[REDACTED\]/u);
  assert.match(diagnostic, /\[TRUNCATED\]/u);
  assert.match(diagnostic, /example\.com\/start/u);
  assert.match(diagnostic, /mode=local/u);
  assert.doesNotMatch(
    JSON.stringify(view),
    /authorization-secret|api-secret|password-secret|alice|hunter2|query-secret/iu,
  );
});

test("copy sanitizes retained diagnostics and announces success through live status", async () => {
  const view = presentation();
  view.details.textContent = `token=clipboard-secret ${"y".repeat(MAX_RUNTIME_DIAGNOSTIC_CHARACTERS * 2)}`;
  const copied = [];

  await copyRuntimeDiagnostic({
    details: view.details,
    status: view.status,
    writeText: async (value) => { copied.push(value); },
  });

  assert.equal(copied.length, 1);
  assert.equal(copied[0], view.details.textContent);
  assert.ok(copied[0].length <= MAX_RUNTIME_DIAGNOSTIC_CHARACTERS);
  assert.match(copied[0], /token=\[REDACTED\]/u);
  assert.doesNotMatch(copied[0], /clipboard-secret/u);
  assert.equal(view.status.textContent, "Diagnostics copied.");
});

test("prefixed environment and URL credentials are redacted without erasing benign diagnostics", async () => {
  const view = presentation();
  view.details.textContent = [
    "AWS_SESSION_TOKEN=session-secret",
    "NPM_TOKEN=npm-secret",
    "DATABASE_PASSWORD=database-secret",
    "STRIPE_API_KEY=stripe-secret",
    "WEBHOOK_SECRET=webhook-secret",
    "https://alice:hunter2@example.test/start?service_api_key=query-secret&mode=local",
    "tokenizer=enabled secretary=available DATABASE_POOL=12",
  ].join("\n");
  const copied = [];

  await copyRuntimeDiagnostic({
    details: view.details,
    status: view.status,
    writeText: async (value) => { copied.push(value); },
  });

  assert.equal(copied.length, 1);
  assert.equal(copied[0], view.details.textContent);
  assert.match(copied[0], /AWS_SESSION_TOKEN=\[REDACTED\]/u);
  assert.match(copied[0], /NPM_TOKEN=\[REDACTED\]/u);
  assert.match(copied[0], /DATABASE_PASSWORD=\[REDACTED\]/u);
  assert.match(copied[0], /STRIPE_API_KEY=\[REDACTED\]/u);
  assert.match(copied[0], /WEBHOOK_SECRET=\[REDACTED\]/u);
  assert.match(copied[0], /service_api_key=\[REDACTED\]/u);
  assert.match(copied[0], /tokenizer=enabled secretary=available DATABASE_POOL=12/u);
  assert.doesNotMatch(copied[0], /session-secret|npm-secret|database-secret|stripe-secret|webhook-secret|query-secret|alice|hunter2/u);
});

test("runtime retry is single-flight and permits reentry after completion", async () => {
  let invocationCount = 0;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const retry = createSingleFlightAction(async () => {
    invocationCount += 1;
    if (invocationCount === 1) await pending;
  });

  const first = retry();
  const duplicate = retry();
  assert.equal(first, duplicate);
  assert.equal(invocationCount, 1);

  finish();
  await first;
  await retry();
  assert.equal(invocationCount, 2);
});
