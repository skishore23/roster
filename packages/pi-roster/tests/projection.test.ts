import assert from "node:assert/strict";
import test from "node:test";
import { ROSTER_CONTROL_API_VERSION, terminalRosterRunStatus, type RosterRunSummary } from "../src/contracts.js";
import { formatRunList, formatRunResult, projectRosterRun } from "../src/projection.js";

const run: RosterRunSummary = {
  apiVersion: ROSTER_CONTROL_API_VERSION,
  id: "run-1",
  objective: "Implement a versioned API",
  status: "running",
  createdAt: "2026-07-12T00:00:00Z",
  updatedAt: "2026-07-12T00:01:00Z",
  branch: "roster/run-1",
  commit: "1234567890abcdef",
  reviewPolicy: "reviewed",
  receiptCount: 12,
  result: {
    status: "verified",
    summary: "Implemented the versioned API.",
    changedFiles: ["src/api.ts", "docs/api.md"],
    validation: ["npm test"],
    frontierHash: "frontier-1",
  },
  tasks: [
    { id: "task-1", nodeId: "worker", nodeName: "Implementation Agent", model: "gpt-5", status: "completed" },
    { id: "task-2", nodeId: "reviewer", nodeName: "Quality Supervisor", model: "opus", status: "running" },
  ],
  frontier: {
    summary: "3 files changed, 42 insertions(+), 5 deletions(-)",
    changedFiles: 3,
    insertions: 42,
    deletions: 5,
    certified: false,
    files: [
      { status: "M", path: "src/api.ts" },
      { status: "M", path: "docs/api.md" },
    ],
  },
};

test("projectRosterRun renders task, node, and frontier state", () => {
  const projection = projectRosterRun(run);
  assert.equal(projection.status, "Roster run-1 · running · 1/2");
  assert.deepEqual(projection.widget, [
    "Roster  run-1 · running · 1/2",
    "Mode   reviewed",
    "Worker pi-agent",
    "Branch roster/run-1",
    "Node   Quality Supervisor · opus",
    "Result verified",
    "Files  src/api.ts, docs/api.md",
    "Git    3 files · +42/-5",
  ]);
});

test("formatRunResult renders the terminal outcome and inspection hint", () => {
  assert.equal(formatRunResult({ ...run, status: "completed" }), [
    "Run run-1",
    "Status: completed (verified)",
    "Branch: roster/run-1 @ 1234567890ab",
    "Summary: Implemented the versioned API.",
    "Changed files:",
    "  - src/api.ts",
    "  - docs/api.md",
    "Validation:",
    "  - npm test",
    "Frontier: frontier-1",
    "Git: 3 files changed, 42 insertions(+), 5 deletions(-) · +42/-5",
    "Use /roster-diff to inspect the patch.",
  ].join("\n"));
});

test("formatRunList is compact and terminal states are explicit", () => {
  assert.equal(formatRunList([run]), "run-1\trunning\treviewed\tImplement a versioned API");
  assert.equal(terminalRosterRunStatus("completed"), true);
  assert.equal(terminalRosterRunStatus("failed"), true);
  assert.equal(terminalRosterRunStatus("aborted"), true);
  assert.equal(terminalRosterRunStatus("blocked"), false);
});
