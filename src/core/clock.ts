export type ClockTimer = {
  readonly id: number;
};

export type Clock = {
  readonly now: () => number;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly setTimeout: (callback: () => void, delayMs: number) => ClockTimer;
  readonly clearTimeout: (timer: ClockTimer) => void;
  readonly setInterval: (callback: () => void, intervalMs: number) => ClockTimer;
  readonly clearInterval: (timer: ClockTimer) => void;
};

const boundedDelay = (value: number, label: string, minimum = 0): number => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  const normalized = Math.floor(value);
  if (normalized < minimum || normalized > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} must be between ${minimum} and ${Number.MAX_SAFE_INTEGER}`);
  }
  return normalized;
};

const addTimestamp = (timestamp: number, delayMs: number, label: string): number => {
  const result = timestamp + delayMs;
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the safe timestamp range`);
  return result;
};

const MAX_VIRTUAL_TIMER_EXECUTIONS_PER_ADVANCE = 100_000;

class SystemClock implements Clock {
  private nextTimerId = 1;
  private readonly timeouts = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly intervals = new Map<number, ReturnType<typeof setInterval>>();

  readonly now = (): number => Date.now();

  readonly sleep = (delayMs: number): Promise<void> =>
    new Promise((resolve) => {
      void this.setTimeout(resolve, delayMs);
    });

  readonly setTimeout = (callback: () => void, delayMs: number): ClockTimer => {
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    const native = setTimeout(() => {
      this.timeouts.delete(id);
      callback();
    }, boundedDelay(delayMs, "Clock timeout"));
    this.timeouts.set(id, native);
    return { id };
  };

  readonly clearTimeout = (timer: ClockTimer): void => {
    const native = this.timeouts.get(timer.id);
    if (!native) return;
    clearTimeout(native);
    this.timeouts.delete(timer.id);
  };

  readonly setInterval = (callback: () => void, intervalMs: number): ClockTimer => {
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    const native = setInterval(callback, boundedDelay(intervalMs, "Clock interval", 1));
    this.intervals.set(id, native);
    return { id };
  };

  readonly clearInterval = (timer: ClockTimer): void => {
    const native = this.intervals.get(timer.id);
    if (!native) return;
    clearInterval(native);
    this.intervals.delete(timer.id);
  };
}

type VirtualTimer = {
  readonly id: number;
  readonly order: number;
  readonly callback: () => void;
  readonly intervalMs?: number;
  dueAt: number;
};

/**
 * Deterministic, manually advanced clock for long-horizon simulations.
 *
 * Advancing runs timers in due-time and registration order. Timer callbacks
 * may schedule or cancel other timers; each callback receives a microtask
 * checkpoint so async queue and lease transitions can progress without real
 * waits.
 */
export class VirtualClock implements Clock {
  private currentTimeMs: number;
  private nextTimerId = 1;
  private nextOrder = 1;
  private readonly timers = new Map<number, VirtualTimer>();

  constructor(startTimeMs = 0) {
    this.currentTimeMs = boundedDelay(startTimeMs, "Virtual clock start time");
  }

  readonly now = (): number => this.currentTimeMs;

  readonly sleep = (delayMs: number): Promise<void> =>
    new Promise((resolve) => {
      void this.setTimeout(resolve, delayMs);
    });

  readonly setTimeout = (callback: () => void, delayMs: number): ClockTimer =>
    this.schedule(callback, boundedDelay(delayMs, "Virtual clock timeout"));

  readonly clearTimeout = (timer: ClockTimer): void => {
    this.timers.delete(timer.id);
  };

  readonly setInterval = (callback: () => void, intervalMs: number): ClockTimer =>
    this.schedule(
      callback,
      boundedDelay(intervalMs, "Virtual clock interval", 1),
      boundedDelay(intervalMs, "Virtual clock interval", 1),
    );

  readonly clearInterval = (timer: ClockTimer): void => {
    this.timers.delete(timer.id);
  };

  pendingTimerCount(): number {
    return this.timers.size;
  }

  async advanceBy(delayMs: number): Promise<void> {
    const delay = boundedDelay(delayMs, "Virtual clock advance");
    await this.advanceTo(addTimestamp(this.currentTimeMs, delay, "Virtual clock advance"));
  }

  async advanceTo(timestampMs: number): Promise<void> {
    const target = boundedDelay(timestampMs, "Virtual clock target");
    if (target < this.currentTimeMs) {
      throw new Error("Virtual clock cannot move backwards");
    }
    let executed = 0;
    while (true) {
      const next = this.nextDueTimer(target);
      if (!next) break;
      executed += 1;
      if (executed > MAX_VIRTUAL_TIMER_EXECUTIONS_PER_ADVANCE) {
        throw new Error(
          `Virtual clock advance exceeds ${MAX_VIRTUAL_TIMER_EXECUTIONS_PER_ADVANCE} timer executions`,
        );
      }
      this.currentTimeMs = next.dueAt;
      if (next.intervalMs === undefined) {
        this.timers.delete(next.id);
      } else if (this.timers.has(next.id)) {
        next.dueAt += next.intervalMs;
      }
      next.callback();
      await Promise.resolve();
    }
    this.currentTimeMs = target;
    await Promise.resolve();
  }

  private schedule(
    callback: () => void,
    delayMs: number,
    intervalMs?: number,
  ): ClockTimer {
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    const timer: VirtualTimer = {
      id,
      order: this.nextOrder,
      callback,
      dueAt: addTimestamp(this.currentTimeMs, delayMs, "Virtual clock timer"),
      ...(intervalMs === undefined ? {} : { intervalMs }),
    };
    this.nextOrder += 1;
    this.timers.set(id, timer);
    return { id };
  }

  private nextDueTimer(target: number): VirtualTimer | undefined {
    return [...this.timers.values()]
      .filter((timer) => timer.dueAt <= target)
      .sort((left, right) => left.dueAt - right.dueAt || left.order - right.order)[0];
  }
}

export const systemClock: Clock = new SystemClock();
