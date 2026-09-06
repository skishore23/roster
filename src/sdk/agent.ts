import type { Runtime } from "../core/runtime.js";
import { runAgentLoop, type ModernAgentSpec } from "../engine/runtime/agent-loop.js";
import { runWorkflow, type RunEvent, type RunLifecycle, type RunState, type WorkflowContext } from "../engine/runtime/workflow.js";
import type { ReceiptDeclaration } from "./receipt.js";

type LifecycleShape<Deps, Event extends RunEvent, State extends RunState, Config> =
  Omit<RunLifecycle<Deps, Event, State, Config>, "reducer" | "initial">;

type ReceiptMap = Readonly<Record<string, ReceiptDeclaration<unknown>>>;

type AgentEvent = {
  readonly type: string;
  readonly [key: string]: unknown;
};

export type WorkflowAgentSpec<
  Cmd,
  Deps extends { runtime: Runtime<Cmd, Event, State> },
  Event extends RunEvent,
  State extends RunState,
  Config
> = {
  readonly id: string;
  readonly version: string;
  readonly reducer: RunLifecycle<Deps, Event, State, Config>["reducer"];
  readonly initial: State;
  readonly lifecycle: LifecycleShape<Deps, Event, State, Config>;
  readonly run: (ctx: WorkflowContext<Deps, Event, State>, config: Config) => Promise<void>;
};

export type AgentSpec<
  Receipts extends ReceiptMap,
  View,
  Deps extends Record<string, unknown> = Record<string, unknown>
> = ModernAgentSpec<Receipts, View, Deps>;

export type RunAgentInput<
  Cmd,
  Event extends AgentEvent,
  State,
  Receipts extends ReceiptMap,
  View,
  Deps extends Record<string, unknown>
> = {
  readonly spec: AgentSpec<Receipts, View, Deps>;
  readonly runtime: Runtime<Cmd, Event, State>;
  readonly stream: string;
  readonly runId: string;
  readonly wrap: (event: Event, meta: { readonly eventId: string; readonly expectedPrev?: string }) => Cmd;
  readonly deps: Deps;
  readonly now?: () => number;
};

export type RunWorkflowAgentInput<
  Cmd,
  Deps extends { runtime: Runtime<Cmd, Event, State> },
  Event extends RunEvent,
  State extends RunState,
  Config
> = {
  readonly spec: WorkflowAgentSpec<Cmd, Deps, Event, State, Config>;
  readonly ctx: WorkflowContext<Deps, Event, State>;
  readonly config: Config;
};

export function defineAgent<
  Receipts extends Readonly<Record<string, ReceiptDeclaration<unknown>>>,
  View,
  Deps extends Record<string, unknown>
>(
  spec: AgentSpec<Receipts, View, Deps>
): AgentSpec<Receipts, View, Deps> {
  return spec;
}

export function defineWorkflowAgent<
  Cmd,
  Deps extends { runtime: Runtime<Cmd, Event, State> },
  Event extends RunEvent,
  State extends RunState,
  Config
>(
  spec: WorkflowAgentSpec<Cmd, Deps, Event, State, Config>
): WorkflowAgentSpec<Cmd, Deps, Event, State, Config> {
  return spec;
}

export async function runDefinedAgent<
  Cmd,
  Event extends AgentEvent,
  State,
  Receipts extends ReceiptMap,
  View,
  Deps extends Record<string, unknown>
>(
  input: RunAgentInput<Cmd, Event, State, Receipts, View, Deps>
): Promise<void> {
  await runAgentLoop(input);
}

export async function runDefinedWorkflowAgent<
  Cmd,
  Deps extends { runtime: Runtime<Cmd, Event, State> },
  Event extends RunEvent,
  State extends RunState,
  Config
>(
  input: RunWorkflowAgentInput<Cmd, Deps, Event, State, Config>
): Promise<void> {
  const { spec, ctx, config } = input;
  const lifecycle: RunLifecycle<Deps, Event, State, Config> = {
    reducer: spec.reducer,
    initial: spec.initial,
    init: spec.lifecycle.init,
    resume: spec.lifecycle.resume,
    shouldIndex: spec.lifecycle.shouldIndex,
  };

  await runWorkflow<Cmd, Deps, Config, Event, State>(
    {
      id: spec.id,
      version: spec.version,
      lifecycle,
      run: spec.run,
    },
    ctx,
    config
  );
}

export const goal = <View>(fn: (ctx: { readonly view: View }) => boolean): ((ctx: { readonly view: View }) => boolean) => fn;
