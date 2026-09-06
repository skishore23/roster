import {
  SimulationImpl,
  type EntropySource,
  type Logger,
} from "determined";

import type {
  DynamicTaskHandlerContext,
  DynamicTaskReadyBatchRunner,
  DynamicTaskTransitionPhase,
} from "../engine/orchestration/task-graph.js";
import { DynamicTaskSchedulingError } from "../engine/orchestration/task-graph.js";

export type DeterminedTaskTransition = {
  readonly index: number;
  readonly batch: number;
  readonly taskId: string;
  readonly phase: DynamicTaskTransitionPhase;
};

export type DeterminedTaskRuntimeSnapshot = {
  readonly peakParallel: number;
  readonly faultMatches: number;
  readonly completionOrder: ReadonlyArray<string>;
  readonly batches: number;
  readonly transitions: ReadonlyArray<DeterminedTaskTransition>;
};

export type DeterminedTaskRuntimeOptions = {
  readonly entropy: EntropySource;
  readonly faultTaskId?: string;
  readonly maxTransitions?: number;
};

export type DeterminedTaskRuntime = {
  readonly execute: <Output>(
    context: Pick<DynamicTaskHandlerContext, "definition" | "attempt" | "signal">,
    run: () => Promise<Output>,
  ) => Promise<Output>;
  readonly runReadyBatch: DynamicTaskReadyBatchRunner;
  readonly snapshot: () => DeterminedTaskRuntimeSnapshot;
};

const quietLogger: Logger = {
  log: () => {},
  error: () => {},
};

/**
 * Determined cooperatively interleaves graph transitions that the dispatcher
 * has already selected as ready. It cannot select, claim, retry, expand, or
 * accept work: every supplied closure still performs those mutations through
 * the single TaskGraphControl authority.
 */
export const createDeterminedTaskRuntime = (
  options: DeterminedTaskRuntimeOptions,
): DeterminedTaskRuntime => {
  const maxTransitions = options.maxTransitions ?? 16_384;
  if (
    !Number.isSafeInteger(maxTransitions)
    || maxTransitions < 1
    || maxTransitions > 1_000_000
  ) {
    throw new Error("Determined task runtime maxTransitions must be between 1 and 1000000");
  }
  let peakParallel = 0;
  let faultMatches = 0;
  let batches = 0;
  const completionOrder: string[] = [];
  const transitions: DeterminedTaskTransition[] = [];
  const injectedFaults = new Set<string>();

  const recordTransition = (
    batch: number,
    taskId: string,
    phase: DynamicTaskTransitionPhase,
  ): void => {
    if (transitions.length >= maxTransitions) {
      throw new Error(`Determined task runtime exceeded maxTransitions=${maxTransitions}`);
    }
    transitions.push({
      index: transitions.length,
      batch,
      taskId,
      phase,
    });
  };

  return {
    execute: async (context, run) => {
      const taskId = context.definition.taskId;
      if (context.signal.aborted) {
        throw context.signal.reason instanceof Error
          ? context.signal.reason
          : new Error(`Task ${taskId} was aborted`);
      }
      if (
        options.faultTaskId === taskId
        && context.attempt === 1
        && !injectedFaults.has(taskId)
      ) {
        injectedFaults.add(taskId);
        faultMatches += 1;
        throw new Error(`Injected deterministic task failure for ${taskId}`);
      }
      const output = await run();
      completionOrder.push(taskId);
      return output;
    },
    runReadyBatch: async (entries) => {
      if (entries.length === 0) return;
      const batch = batches;
      batches += 1;
      peakParallel = Math.max(peakParallel, entries.length);
      const simulation = new SimulationImpl(quietLogger, options.entropy, () => 0);
      const result = await simulation.runTasks(entries.map((entry) => ({
        name: `task:${entry.taskId}:batch:${batch}`,
        f: async (task) => entry.run(async (phase) => {
          recordTransition(batch, entry.taskId, phase);
          try {
            await task.checkpoint(`task:${entry.taskId}:${phase}`);
          } catch (error) {
            throw new DynamicTaskSchedulingError(
              `Determined scheduler failed at ${entry.taskId}:${phase}`,
              { cause: error },
            );
          }
        }),
      })));
      if (result.isErr()) throw result.error;
    },
    snapshot: () => ({
      peakParallel,
      faultMatches,
      completionOrder: [...completionOrder],
      batches,
      transitions: [...transitions],
    }),
  };
};
