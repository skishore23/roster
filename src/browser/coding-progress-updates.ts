export type CodingRuntimeProgressLog = {
  readonly runId: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly sequence: number;
  readonly at: number;
};

export type CodingRuntimeCommandKind =
  | "command"
  | "lifecycle"
  | "result"
  | "stderr"
  | "stdout"
  | "tool";

export type CodingRuntimeTelemetry = {
  readonly commandKind: CodingRuntimeCommandKind;
  readonly nodeId: string;
  readonly taskId: string;
  readonly at: number;
  readonly rawLogRef: string;
};

const runtimeCommandKind = (log: CodingRuntimeProgressLog): CodingRuntimeCommandKind => {
  if (log.stream === "stderr") return "stderr";
  const text = log.text.trim();
  if (/^Tool [A-Za-z0-9_.-]+:/u.test(text)) return "tool";
  if (/^item\.(?:started|completed):/u.test(text)) return "command";
  if (/^(?:Pi agent|Claude Code(?: session)?|Hermes agent) started\b/iu.test(text)
    || /^Session\s+\S+\s+started\b/iu.test(text)
    || text === "Oversized incremental provider snapshot compacted") return "lifecycle";
  if (/^\s*\{/u.test(text)) return "result";
  return "stdout";
};

/**
 * Returns bounded Workbench metadata which points back to the raw log record.
 * It deliberately carries no synthesized body text and is never a room post.
 */
export const codingRuntimeTelemetry = (
  logs: ReadonlyArray<CodingRuntimeProgressLog>,
  limit = 120,
): ReadonlyArray<CodingRuntimeTelemetry> => [...logs]
  .filter((log) => log.runId && log.nodeId && log.taskId
    && Number.isSafeInteger(log.sequence) && log.sequence > 0
    && Number.isFinite(log.at))
  .sort((left, right) => left.sequence - right.sequence)
  .slice(-Math.max(1, Math.min(limit, 500)))
  .map((log) => ({
    commandKind: runtimeCommandKind(log),
    nodeId: log.nodeId,
    taskId: log.taskId,
    at: log.at,
    rawLogRef: `runtime-log:${log.runId}:${log.sequence}`,
  }));
