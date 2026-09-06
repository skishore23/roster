export type CodingExecutionSnapshot = {
  readonly status: string;
  readonly totalTasks: number;
  readonly readyTasks: number;
  readonly blockedTasks: number;
  readonly inflightTasks: number;
  readonly acceptedTasks: number;
  readonly failedTasks: number;
  readonly canceledTasks: number;
  readonly skippedTasks: number;
  readonly terminalReason: string;
};

export type CodingTaskSnapshot = {
  readonly taskId: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly status: string;
  readonly displayName?: string;
  readonly failureCategory?: CodingPublicFailureCategory | "";
  readonly failureReason?: string;
};

export type CodingPublicFailureCategory =
  | "budget-exhausted"
  | "runtime-unavailable"
  | "task-failed"
  | "validation-failed"
  | "worker-timeout";

export type CodingRunAttentionDetail = {
  readonly taskId: string;
  readonly nodeId: string;
  readonly taskLabel: string;
  readonly status: string;
  readonly headline: string;
  readonly explanation: string;
};

export type CodingLiveActivityPresentation = {
  readonly nodeId: string;
  readonly displayName: string;
  readonly activity: string;
  readonly signalCount: number;
  readonly lastSignalAt?: number;
};

export type CodingRunPresentationState =
  | "preparing"
  | "queued"
  | "working"
  | "waiting"
  | "complete"
  | "needs-attention"
  | "stopped";

export type CodingRunPresentation = {
  readonly state: CodingRunPresentationState;
  readonly label: string;
  readonly summary: string;
  readonly progress: string;
  readonly needsAttention: boolean;
};

export type CodingNodePresentationState = "working" | "waiting" | "done" | "blocked";

export type CodingNodePresentation = {
  readonly state: CodingNodePresentationState;
  readonly task?: CodingTaskSnapshot;
};

export type CodingNodeBlockedStatus = {
  readonly label: "Blocked" | "Stopped with run" | "Not completed";
  readonly message: string;
};

const failureStatuses = new Set(["failed", "budget_exhausted"]);
const successfulTaskStatuses = new Set(["accepted", "skipped"]);
const activeTaskStatuses = new Set(["running", "leased"]);
const failedTaskStatuses = new Set(["failed", "canceled"]);

const normalizedReason = (value: string): string => {
  const reason = value.trim().replace(/[.!?]+$/u, "");
  if (!reason) return "";
  return `${reason[0]?.toUpperCase() ?? ""}${reason.slice(1)}.`;
};

const publicExecutionReason = (value: string): string => {
  switch (value) {
    case "completed-with-notes":
      return "The team finished and preserved its review notes.";
    case "budget-exhausted":
      return "The run stopped after reaching its execution budget.";
    case "run-failed":
      return "The run stopped before every step could be accepted.";
    case "worker-timeout":
      return "The assigned runtime stopped responding before it returned an accepted result.";
    case "runtime-unavailable":
      return "The assigned runtime was unavailable for the unfinished step.";
    case "validation-failed":
      return "Validation did not pass for the unfinished step.";
    case "task-failed":
      return "Roster did not receive an accepted result for the unfinished step.";
    case "run-canceled":
      return "The run was stopped and its accepted work was preserved.";
    default:
      return "";
  }
};

export const isCodingUserVisibleTask = (
  task: Pick<CodingTaskSnapshot, "nodeId" | "capability">,
): boolean => task.nodeId !== "coordinator"
  && task.capability !== "coordinate"
  && task.capability !== "room";

const publicTaskLabel = (taskId: string, capability: string): string => {
  if (capability === "room" && taskId.startsWith("announce-")) {
    const next = publicTaskLabel(taskId.slice("announce-".length), "");
    return `Introduction before ${next[0]?.toLowerCase() ?? ""}${next.slice(1)}`;
  }
  const source = taskId.trim() || capability.trim() || "assigned work";
  const words = source.replaceAll(/[._:-]+/gu, " ").replace(/\s+/gu, " ").trim();
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
};

export const codingRunAttentionDetail = (
  tasks: ReadonlyArray<CodingTaskSnapshot>,
  terminalReason: string,
): CodingRunAttentionDetail | undefined => {
  const statusPriority = new Map([
    ["failed", 0],
    ["canceled", 1],
    ["running", 2],
    ["leased", 2],
    ["ready", 3],
    ["blocked", 4],
    ["pending", 5],
  ]);
  const task = tasks
    .filter((candidate) => candidate.capability === "room" || isCodingUserVisibleTask(candidate))
    .map((candidate, index) => ({ candidate, index, priority: statusPriority.get(candidate.status) }))
    .filter((entry): entry is { candidate: CodingTaskSnapshot; index: number; priority: number } =>
      entry.priority !== undefined)
    .sort((left, right) => left.priority - right.priority || left.index - right.index)[0]?.candidate;
  if (!task) return undefined;
  const taskLabel = publicTaskLabel(task.taskId, task.capability);
  const owner = task.displayName?.trim();
  const subject = `${owner ? `${owner}’s ` : "The "}${taskLabel} step`;
  const terminalBudgetFailure = terminalReason === "budget-exhausted";
  const code = terminalBudgetFailure ? terminalReason : task.failureCategory || terminalReason;
  const explanation = task.capability === "room"
    ? "Roster did not receive a valid model-authored start update, so the repository task did not begin."
    : terminalBudgetFailure
      ? "The run reached its execution budget before this step could return an accepted result."
      : task.failureReason?.trim()
      || (code === "budget-exhausted"
        ? "The run reached its execution budget before this step could return an accepted result."
        : publicExecutionReason(code) || "Roster did not receive an accepted result for this step.");
  const headline = task.status === "failed"
    ? `${subject} failed.`
    : task.status === "canceled"
      ? `${subject} stopped when the run ended.`
      : `${subject} did not finish before the run stopped.`;
  return {
    taskId: task.taskId,
    nodeId: task.nodeId,
    taskLabel,
    status: task.status,
    headline,
    explanation,
  };
};

const liveActivityLabel = (capability: string): string => {
  const normalized = capability.toLowerCase();
  if (normalized.includes("investigat")) return "Investigating the repository";
  if (normalized.includes("implement") || normalized.includes("mutate")) return "Implementing the change";
  if (normalized.includes("review")) return "Reviewing the accepted work";
  if (normalized.includes("validat") || normalized.includes("test")) return "Running validation";
  if (normalized.includes("certif")) return "Checking the final result";
  if (normalized.includes("synth")) return "Preparing the room answer";
  if (normalized.includes("propos")) return "Shaping the design direction";
  if (normalized.includes("resolv")) return "Resolving the open decisions";
  return "Working on the assigned step";
};

const queuedLiveActivityLabel = (capability: string): string => {
  const normalized = capability.toLowerCase();
  if (normalized.includes("investigat")) return "Queued to investigate the repository";
  if (normalized.includes("implement") || normalized.includes("mutate")) return "Queued to implement the change";
  if (normalized.includes("review")) return "Queued to review the accepted work";
  if (normalized.includes("validat") || normalized.includes("test")) return "Queued to run validation";
  if (normalized.includes("certif")) return "Queued to check the final result";
  if (normalized.includes("synth")) return "Queued to prepare the room answer";
  if (normalized.includes("propos")) return "Queued to shape the design direction";
  if (normalized.includes("resolv")) return "Queued to resolve the open decisions";
  return "Queued for the assigned step";
};

export const codingLiveActivityPresentation = (input: {
  readonly nodeId: string;
  readonly displayName: string;
  readonly capability: string;
  readonly phase?: "active" | "queued";
  readonly signalCount: number;
  readonly lastSignalAt?: number;
}): CodingLiveActivityPresentation => ({
  nodeId: input.nodeId,
  displayName: input.displayName.trim() || input.nodeId,
  activity: input.phase === "queued"
    ? queuedLiveActivityLabel(input.capability)
    : liveActivityLabel(input.capability),
  signalCount: Math.max(0, Math.floor(input.signalCount)),
  ...(input.lastSignalAt !== undefined ? { lastSignalAt: input.lastSignalAt } : {}),
});

export const codingNodeBlockedStatus = (input: {
  readonly taskLabel: string;
  readonly taskStatus?: string;
  readonly taskError?: string;
  readonly runReason?: string;
}): CodingNodeBlockedStatus => {
  const label = input.taskLabel.trim() || "Assigned work";
  const subject = `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}`;
  const taskReason = normalizedReason(input.taskError ?? "");
  const runReason = normalizedReason(input.runReason ?? "");
  if (input.taskStatus === "failed") {
    return {
      label: "Blocked",
      message: taskReason
        ? `${subject} failed. Reason: ${taskReason}`
        : `${subject} failed without a recorded reason.`,
    };
  }
  if (input.taskStatus === "canceled") {
    return {
      label: "Stopped with run",
      message: `${subject} stopped when the run ended.${taskReason || runReason ? ` Reason: ${taskReason || runReason}` : ""}`,
    };
  }
  return {
    label: "Not completed",
    message: `${subject} did not finish before the run stopped.${taskReason || runReason ? ` Reason: ${taskReason || runReason}` : ""}`,
  };
};

const progressLabel = (execution: CodingExecutionSnapshot): string =>
  execution.totalTasks > 0
    ? `${execution.acceptedTasks + execution.skippedTasks} of ${execution.totalTasks} steps completed`
    : "Preparing the first step";

const visibleExecution = (
  execution: CodingExecutionSnapshot,
  tasks: ReadonlyArray<CodingTaskSnapshot>,
): CodingExecutionSnapshot => {
  const visible = tasks.filter(isCodingUserVisibleTask);
  if (
    tasks.length === 0
    || visible.length === tasks.length
    || tasks.length !== execution.totalTasks
  ) return execution;
  const count = (...statuses: string[]): number => visible
    .filter((task) => statuses.includes(task.status)).length;
  return {
    ...execution,
    totalTasks: visible.length,
    readyTasks: count("ready"),
    blockedTasks: count("blocked", "pending"),
    inflightTasks: count("running", "leased"),
    acceptedTasks: count("accepted"),
    failedTasks: count("failed"),
    canceledTasks: count("canceled"),
    skippedTasks: count("skipped"),
  };
};

export const codingRunPresentation = (
  execution: CodingExecutionSnapshot | undefined,
  tasks: ReadonlyArray<CodingTaskSnapshot> = [],
  jobStatus?: string,
): CodingRunPresentation => {
  // A durable queued job is the authority for the next attempt. The previous
  // attempt's execution projection may remain available briefly during retry
  // handoff, but it must not make the fresh attempt look failed or active.
  if (jobStatus === "queued") {
    return {
      state: "queued",
      label: "Queued",
      summary: "Waiting for an available workspace agent.",
      progress: "Queued before the first step",
      needsAttention: false,
    };
  }
  if (!execution) {
    return {
      state: "preparing",
      label: "Preparing",
      summary: "Connecting the room to its live execution.",
      progress: "Preparing the first step",
      needsAttention: false,
    };
  }

  const announcementInflight = tasks.some((task) => task.capability === "room"
    && (task.status === "running" || task.status === "leased"));
  const announcementReady = tasks.some((task) => task.capability === "room" && task.status === "ready");
  execution = visibleExecution(execution, tasks);

  const progress = progressLabel(execution);
  const reason = publicExecutionReason(execution.terminalReason);
  if (execution.status === "completed" || execution.status === "completed_with_notes") {
    const successfulTasks = execution.acceptedTasks + execution.skippedTasks;
    const contradictoryCompletion = execution.totalTasks > 0 && (
      successfulTasks !== execution.totalTasks
      || execution.readyTasks > 0
      || execution.blockedTasks > 0
      || execution.inflightTasks > 0
      || execution.failedTasks > 0
      || execution.canceledTasks > 0
    );
    if (contradictoryCompletion) {
      return {
        state: "needs-attention",
        label: "Needs attention",
        summary: "The run is marked complete, but its task projection is incomplete or contradictory. Reload the room or inspect the run before taking action.",
        progress,
        needsAttention: true,
      };
    }
    return {
      state: "complete",
      label: execution.status === "completed_with_notes" ? "Complete with notes" : "Complete",
      summary: execution.status === "completed_with_notes"
        ? reason || "The team finished and preserved its review notes."
        : "The team finished and accepted the run.",
      progress,
      needsAttention: false,
    };
  }
  if (failureStatuses.has(execution.status)) {
    const attention = codingRunAttentionDetail(tasks, execution.terminalReason);
    return {
      state: "needs-attention",
      label: "Needs attention",
      summary: attention
        ? `${attention.headline} ${attention.explanation}`
        : reason || "The run stopped before every step could be accepted.",
      progress,
      needsAttention: true,
    };
  }
  if (execution.status === "canceled") {
    return {
      state: "stopped",
      label: "Stopped",
      summary: reason || "The run was stopped and its accepted work was preserved.",
      progress,
      needsAttention: false,
    };
  }
  if (execution.status === "queued") {
    return {
      state: "queued",
      label: "Queued",
      summary: "The team is assembling the first executable steps.",
      progress,
      needsAttention: false,
    };
  }
  if (announcementInflight) {
    return {
      state: "working",
      label: "Working",
      summary: "A teammate is preparing the next room update.",
      progress,
      needsAttention: false,
    };
  }
  if (announcementReady) {
    return {
      state: "queued",
      label: "Queued",
      summary: "A teammate is queued to prepare the next room update.",
      progress,
      needsAttention: false,
    };
  }
  if (execution.inflightTasks > 0) {
    return {
      state: "working",
      label: "Working",
      summary: `${execution.inflightTasks} ${execution.inflightTasks === 1 ? "step is" : "steps are"} in progress now.`,
      progress,
      needsAttention: false,
    };
  }
  if (execution.readyTasks > 0) {
    return {
      state: "waiting",
      label: "Ready to continue",
      summary: `${execution.readyTasks} ${execution.readyTasks === 1 ? "step is" : "steps are"} ready for an agent.`,
      progress,
      needsAttention: false,
    };
  }
  if (execution.blockedTasks > 0) {
    return {
      state: "waiting",
      label: "Waiting on inputs",
      summary: `${execution.blockedTasks} ${execution.blockedTasks === 1 ? "step is" : "steps are"} waiting for accepted input.`,
      progress,
      needsAttention: false,
    };
  }
  return {
    state: "waiting",
    label: "Finalizing",
    summary: "All runnable work is settled; Roster is finalizing the run.",
    progress,
    needsAttention: false,
  };
};

const preferredTask = (
  tasks: ReadonlyArray<CodingTaskSnapshot>,
  statuses: ReadonlySet<string>,
): CodingTaskSnapshot | undefined =>
  [...tasks]
    .filter((task) => statuses.has(task.status))
    .sort((left, right) => left.taskId.localeCompare(right.taskId))[0];

export const codingNodePresentation = (
  tasks: ReadonlyArray<CodingTaskSnapshot>,
  run: CodingRunPresentation,
): CodingNodePresentation => {
  if (tasks.length === 0) return { state: "waiting" };

  const accepted = tasks.every((task) => successfulTaskStatuses.has(task.status));
  if (run.state === "complete") {
    return {
      state: "done",
      task: preferredTask(tasks, successfulTaskStatuses) ?? tasks[0],
    };
  }
  if (run.state === "needs-attention" || run.state === "stopped") {
    if (accepted) {
      return {
        state: "done",
        task: preferredTask(tasks, successfulTaskStatuses) ?? tasks[0],
      };
    }
    return {
      state: "blocked",
      task: preferredTask(tasks, failedTaskStatuses)
        ?? tasks.find((task) => !successfulTaskStatuses.has(task.status))
        ?? tasks[0],
    };
  }

  const active = preferredTask(tasks, activeTaskStatuses);
  if (active) return { state: "working", task: active };
  const failed = preferredTask(tasks, failedTaskStatuses);
  if (failed) return { state: "blocked", task: failed };
  const waiting = tasks
    .filter((task) => !successfulTaskStatuses.has(task.status))
    .sort((left, right) => left.taskId.localeCompare(right.taskId))[0];
  if (waiting) return { state: "waiting", task: waiting };
  return {
    state: "done",
    task: preferredTask(tasks, successfulTaskStatuses) ?? tasks[0],
  };
};
