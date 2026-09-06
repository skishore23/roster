import type { RosterRunSummary, RosterTaskSummary } from "./contracts.js";

export type RosterUiProjection = {
  readonly status: string;
  readonly widget: ReadonlyArray<string>;
};

const clip = (value: string, length: number): string =>
  value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…`;

const currentTask = (tasks: ReadonlyArray<RosterTaskSummary>): RosterTaskSummary | undefined =>
  tasks.find((task) => task.status === "running") ?? tasks.find((task) => task.status === "blocked");

const joinList = (values: ReadonlyArray<string>, length: number): string =>
  clip(values.join(", "), length);

export const projectRosterRun = (run: RosterRunSummary): RosterUiProjection => {
  const tasks = run.tasks ?? [];
  const done = tasks.filter((task) => task.status === "completed").length;
  const active = currentTask(tasks);
  const status = `Roster ${run.id} · ${run.status}${tasks.length ? ` · ${done}/${tasks.length}` : ""}`;
  const worker = active
    ? `${active.nodeName ?? active.nodeId}${active.model ? ` · ${active.model}` : active.runtime ? ` · ${active.runtime}` : ""}`
    : run.status === "completed" ? "All required nodes settled" : "Waiting for Roster scheduling";
  const mode = run.reviewPolicy ?? "auto";
  const workerRuntime = run.workerRuntime ?? "pi-agent";
  const frontier = run.frontier
    ? `${run.frontier.changedFiles ?? 0} files · +${run.frontier.insertions ?? 0}/-${run.frontier.deletions ?? 0}${run.frontier.certified ? " · certified" : ""}`
    : `${run.receiptCount ?? 0} receipts · frontier pending`;
  const changedFiles = run.result?.changedFiles ?? run.frontier?.files?.map((file) => file.path);
  return {
    status,
    widget: [
      `Roster  ${clip(run.id, 48)} · ${run.status}${tasks.length ? ` · ${done}/${tasks.length}` : ""}`,
      `Mode   ${mode}`,
      `Worker ${workerRuntime}`,
      ...(run.branch ? [`Branch ${clip(run.branch, 72)}`] : []),
      `Node   ${clip(worker, 72)}`,
      ...(run.result?.status ? [`Result ${clip(run.result.status, 72)}`] : []),
      ...(changedFiles?.length ? [`Files  ${joinList(changedFiles, 72)}`] : []),
      `Git    ${frontier}`,
      ...(run.error ? [`Error  ${clip(run.error, 72)}`] : []),
    ],
  };
};

export const formatRunResult = (run: RosterRunSummary): string => {
  const changedFiles = run.result?.changedFiles ?? run.frontier?.files?.map((file) => file.path) ?? [];
  const validation = run.result?.validation ?? [];
  return [
    `Run ${run.id}`,
    `Status: ${run.status}${run.result?.status ? ` (${run.result.status})` : ""}`,
    run.branch ? `Branch: ${run.branch}${run.commit ? ` @ ${run.commit.slice(0, 12)}` : ""}` : undefined,
    run.result?.summary ? `Summary: ${run.result.summary}` : undefined,
    changedFiles.length ? ["Changed files:", ...changedFiles.map((file) => `  - ${file}`)].join("\n") : undefined,
    validation.length ? ["Validation:", ...validation.map((item) => `  - ${item}`)].join("\n") : undefined,
    run.result?.frontierHash ? `Frontier: ${run.result.frontierHash}` : undefined,
    run.frontier ? `Git: ${run.frontier.summary || `${run.frontier.changedFiles ?? 0} files changed`} · +${run.frontier.insertions ?? 0}/-${run.frontier.deletions ?? 0}` : undefined,
    run.frontier?.truncated ? "Diff summary was truncated by Roster." : undefined,
    "Use /roster-diff to inspect the patch.",
  ].filter((line): line is string => Boolean(line)).join("\n");
};

export const formatRunList = (runs: ReadonlyArray<RosterRunSummary>): string => {
  if (runs.length === 0) return "No Roster coding runs found.";
  return runs.map((run) => `${run.id}\t${run.status}\t${run.reviewPolicy ?? "auto"}\t${clip(run.objective, 72)}`).join("\n");
};
