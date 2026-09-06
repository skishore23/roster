import type { EnqueueJobInput } from "../engine/runtime/job-queue.js";

type RuntimePhantom<Event, Config> = {
  readonly __event__?: Event;
  readonly __config__?: Config;
};

export type RuntimeOp<Cmd = unknown, Event = unknown, Config = unknown> = (
  | { readonly type: "fork"; readonly stream: string; readonly at: number; readonly newName: string }
  | { readonly type: "emit"; readonly stream: string; readonly cmd: Cmd }
  | { readonly type: "start_run"; readonly launcher: () => Promise<void> | void }
  | { readonly type: "enqueue_job"; readonly job: EnqueueJobInput }
  | { readonly type: "steer_job"; readonly jobId: string; readonly payload?: Record<string, unknown>; readonly by?: string }
  | { readonly type: "followup_job"; readonly jobId: string; readonly payload?: Record<string, unknown>; readonly by?: string }
  | { readonly type: "abort_job"; readonly jobId: string; readonly reason?: string; readonly by?: string }
  | { readonly type: "wait_job"; readonly jobId: string; readonly timeoutMs?: number }
  | { readonly type: "broadcast"; readonly topic: "theorem" | "writer" | "agent" | "receipt" | "jobs"; readonly stream?: string }
  | { readonly type: "redirect"; readonly url: string; readonly header: "Location" }
) & RuntimePhantom<Event, Config>;

type RuntimeOpHandlers<Cmd> = {
  readonly fork: (op: Extract<RuntimeOp<Cmd>, { type: "fork" }>) => Promise<void>;
  readonly emit: (op: Extract<RuntimeOp<Cmd>, { type: "emit" }>) => Promise<void>;
  readonly startRun: (op: Extract<RuntimeOp<Cmd>, { type: "start_run" }>) => Promise<void>;
  readonly enqueueJob?: (op: Extract<RuntimeOp<Cmd>, { type: "enqueue_job" }>) => Promise<void>;
  readonly steerJob?: (op: Extract<RuntimeOp<Cmd>, { type: "steer_job" }>) => Promise<void>;
  readonly followupJob?: (op: Extract<RuntimeOp<Cmd>, { type: "followup_job" }>) => Promise<void>;
  readonly abortJob?: (op: Extract<RuntimeOp<Cmd>, { type: "abort_job" }>) => Promise<void>;
  readonly waitJob?: (op: Extract<RuntimeOp<Cmd>, { type: "wait_job" }>) => Promise<void>;
  readonly broadcast: (op: Extract<RuntimeOp<Cmd>, { type: "broadcast" }>) => Promise<void>;
};

export const executeRuntimeOps = async <Cmd>(
  ops: ReadonlyArray<RuntimeOp<Cmd>>,
  handlers: RuntimeOpHandlers<Cmd>
): Promise<Extract<RuntimeOp<Cmd>, { type: "redirect" }> | undefined> => {
  let redirect: Extract<RuntimeOp<Cmd>, { type: "redirect" }> | undefined;
  const expectHandler = <T>(handler: T | undefined, opType: string): T => {
    if (!handler) throw new Error(`runtime op handler missing for ${opType}`);
    return handler;
  };

  for (const op of ops) {
    switch (op.type) {
      case "fork":
        await handlers.fork(op);
        break;
      case "emit":
        await handlers.emit(op);
        break;
      case "start_run":
        await handlers.startRun(op);
        break;
      case "enqueue_job":
        await expectHandler(handlers.enqueueJob, "enqueue_job")(op);
        break;
      case "steer_job":
        await expectHandler(handlers.steerJob, "steer_job")(op);
        break;
      case "followup_job":
        await expectHandler(handlers.followupJob, "followup_job")(op);
        break;
      case "abort_job":
        await expectHandler(handlers.abortJob, "abort_job")(op);
        break;
      case "wait_job":
        await expectHandler(handlers.waitJob, "wait_job")(op);
        break;
      case "broadcast":
        await handlers.broadcast(op);
        break;
      case "redirect":
        redirect = op;
        break;
      default: {
        const _exhaustive: never = op;
        throw new Error(`unknown runtime op: ${String(_exhaustive)}`);
      }
    }
  }

  return redirect;
};
