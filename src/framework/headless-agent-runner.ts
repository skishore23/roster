import { createRuntime } from "../core/runtime.js";
import type { BranchStore, Store } from "../core/types.js";
import { runAgentLoop } from "../engine/runtime/agent-loop.js";
import type {
  HeadlessAgentRequest,
  HeadlessAgentResult,
  HeadlessAgentSpec,
} from "./agent-types.js";

export type HeadlessAgentEvent = Record<string, unknown> & { readonly type: string };

type HeadlessAgentCommand = {
  readonly type: "emit";
  readonly event: HeadlessAgentEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type HeadlessAgentRunInput = HeadlessAgentRequest & {
  readonly store: Store<HeadlessAgentEvent>;
  readonly branchStore: BranchStore;
  readonly deps?: Record<string, unknown>;
  readonly now?: () => number;
  readonly createRunId?: () => string;
};

export type HeadlessAgentRunResult = HeadlessAgentResult;

export type HeadlessAgentSeedType = "task.requested" | "prompt.received";

export const selectHeadlessAgentSeedType = (spec: HeadlessAgentSpec): HeadlessAgentSeedType => {
  const receiptTypes = Object.keys(spec.receipts);
  if (receiptTypes.includes("task.requested")) return "task.requested";
  if (receiptTypes.includes("prompt.received")) return "prompt.received";
  throw new Error(`Headless agent '${spec.id}' must declare task.requested or prompt.received`);
};

const defaultRunId = (): string =>
  `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

export const runHeadlessAgent = async (
  input: HeadlessAgentRunInput,
): Promise<HeadlessAgentRunResult> => {
  const runId = input.runId ?? (input.createRunId ?? defaultRunId)();
  const stream = input.stream ?? `agents/${input.spec.id}`;
  const runStream = input.runStream ?? `${stream}/runs/${runId}`;
  const seedType = selectHeadlessAgentSeedType(input.spec);
  const runtime = createRuntime<HeadlessAgentCommand, HeadlessAgentEvent, { readonly ok: true }>(
    input.store,
    input.branchStore,
    (command) => [command.event],
    (state) => state,
    { ok: true },
  );

  await runtime.execute(runStream, {
    type: "emit",
    eventId: `seed:${runId}`,
    event: { type: seedType, prompt: input.problem },
  });
  await runAgentLoop({
    spec: input.spec,
    runtime,
    stream: runStream,
    runId,
    deps: input.deps ?? {},
    wrap: (event, meta) => ({
      type: "emit" as const,
      event,
      eventId: meta.eventId,
      expectedPrev: meta.expectedPrev,
    }),
    now: input.now,
  });

  return { runId, stream, runStream };
};
