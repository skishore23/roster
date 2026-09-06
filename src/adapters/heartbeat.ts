// ============================================================================
// Heartbeat - interval-based autonomous job enqueuer
// ============================================================================

export type HeartbeatSpec = {
  readonly id: string;
  readonly agentId: string;
  readonly intervalMs: number;
  readonly payload: Record<string, unknown>;
};

export type HeartbeatDeps = {
  readonly enqueue: (opts: {
    readonly agentId: string;
    readonly payload: Record<string, unknown>;
  }) => Promise<{ readonly id: string }>;
};

export type Heartbeat = {
  readonly start: () => void;
  readonly stop: () => void;
};

export const createHeartbeat = (spec: HeartbeatSpec, deps: HeartbeatDeps): Heartbeat => {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start: () => {
      if (timer) return;
      timer = setInterval(() => {
        void deps.enqueue({ agentId: spec.agentId, payload: spec.payload }).catch((err) => {
          console.error(`heartbeat enqueue failed (${spec.id})`, err);
          if (timer) {
            clearInterval(timer);
            timer = undefined;
          }
        });
      }, spec.intervalMs);
    },
    stop: () => {
      if (timer) { clearInterval(timer); timer = undefined; }
    },
  };
};
