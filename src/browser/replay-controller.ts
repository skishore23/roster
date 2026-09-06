export type ReplaySnapshot = {
  readonly sequences: ReadonlyArray<bigint>;
  readonly cursor: bigint | null;
  readonly label: string;
};

export type ReplayController = {
  readonly update: (snapshot: ReplaySnapshot) => void;
  readonly stop: () => void;
  readonly dispose: () => void;
};

export type ReplayControllerOptions = {
  readonly root: HTMLElement;
  readonly onCursorChange: (cursor: bigint | null) => void;
  readonly updateUrl?: boolean;
};

const find = <ElementType extends Element>(
  root: ParentNode,
  selector: string,
  constructor: { new (...args: never[]): ElementType },
): ElementType | undefined => {
  const candidate = root.querySelector(selector);
  return candidate instanceof constructor ? candidate : undefined;
};

export const createReplayController = (
  options: ReplayControllerOptions,
): ReplayController => {
  const { root } = options;
  const start = find(root, '[data-replay-action="start"]', HTMLButtonElement);
  const previous = find(root, '[data-replay-action="previous"]', HTMLButtonElement);
  const play = find(root, '[data-replay-action="play"]', HTMLButtonElement);
  const next = find(root, '[data-replay-action="next"]', HTMLButtonElement);
  const live = find(root, '[data-replay-action="live"]', HTMLButtonElement);
  const slider = find(root, "[data-replay-scrub], .travel-slider", HTMLInputElement);
  const speed = find(root, "[data-replay-speed]", HTMLSelectElement);
  const output = find(root, ".travel-state", HTMLOutputElement);

  let snapshot: ReplaySnapshot = { sequences: [], cursor: null, label: "No run selected" };
  let playing = false;
  let timer = 0;

  const position = (): number => {
    if (snapshot.cursor === null) return snapshot.sequences.length;
    let count = 0;
    for (const sequence of snapshot.sequences) {
      if (sequence > snapshot.cursor) break;
      count += 1;
    }
    return count;
  };

  const writeUrl = (cursor: bigint | null): void => {
    if (options.updateUrl === false) return;
    const url = new URL(window.location.href);
    if (cursor === null) url.searchParams.delete("at");
    else url.searchParams.set("at", cursor.toString());
    window.history.replaceState(window.history.state, "", url);
  };

  const render = (): void => {
    const current = position();
    const total = snapshot.sequences.length;
    const enabled = total > 0;
    const historical = snapshot.cursor !== null;
    if (start) start.disabled = !enabled || current === 0;
    if (previous) previous.disabled = !enabled || current === 0;
    if (play) {
      play.disabled = !enabled;
      play.textContent = playing ? "Pause" : "Play";
      play.setAttribute("aria-pressed", String(playing));
    }
    if (next) next.disabled = !enabled || !historical || current >= total;
    if (live) live.disabled = !enabled || !historical;
    if (slider) {
      slider.disabled = !enabled;
      slider.min = "0";
      slider.max = String(total);
      slider.value = String(current);
      slider.setAttribute(
        "aria-valuetext",
        historical ? `Replay event ${current} of ${total}` : `Live at event ${total}`,
      );
    }
    if (speed) speed.disabled = !enabled;
    if (output) output.value = snapshot.label;
    root.dataset.current = String(current);
    root.dataset.maximum = String(total);
    root.dataset.mode = historical ? "replay" : "live";
  };

  const setCursor = (cursor: bigint | null): void => {
    writeUrl(cursor);
    options.onCursorChange(cursor);
  };

  const stop = (): void => {
    playing = false;
    window.clearTimeout(timer);
    timer = 0;
    render();
  };

  const schedule = (): void => {
    window.clearTimeout(timer);
    if (!playing) return;
    const delay = Number(speed?.value ?? 700) || 700;
    timer = window.setTimeout(() => {
      const current = position();
      if (current >= snapshot.sequences.length) {
        stop();
        return;
      }
      const sequence = snapshot.sequences[current];
      if (sequence === undefined) {
        stop();
        return;
      }
      setCursor(sequence);
      schedule();
    }, delay);
  };

  const listen = <EventType extends Event>(
    target: EventTarget | undefined,
    type: string,
    listener: (event: EventType) => void,
  ): (() => void) => {
    if (!target) return () => undefined;
    const wrapped = listener as EventListener;
    target.addEventListener(type, wrapped);
    return () => target.removeEventListener(type, wrapped);
  };

  const disposers = [
    listen(start, "click", () => {
      stop();
      setCursor(0n);
    }),
    listen(previous, "click", () => {
      stop();
      const current = position();
      setCursor(current <= 1 ? 0n : snapshot.sequences[current - 2] ?? 0n);
    }),
    listen(play, "click", () => {
      if (playing) {
        stop();
        return;
      }
      if (snapshot.sequences.length === 0) return;
      if (snapshot.cursor === null || position() >= snapshot.sequences.length) setCursor(0n);
      playing = true;
      render();
      schedule();
    }),
    listen(next, "click", () => {
      stop();
      const sequence = snapshot.sequences[position()];
      if (sequence !== undefined) setCursor(sequence);
    }),
    listen(live, "click", () => {
      stop();
      setCursor(null);
    }),
    listen<InputEvent>(slider, "input", () => {
      stop();
      const requested = Math.max(0, Math.min(Number(slider?.value ?? 0), snapshot.sequences.length));
      setCursor(requested === snapshot.sequences.length
        ? null
        : requested === 0
          ? 0n
          : snapshot.sequences[requested - 1] ?? 0n);
    }),
    listen(speed, "change", () => {
      if (playing) schedule();
    }),
    listen(document, "visibilitychange", () => {
      if (document.hidden) stop();
    }),
  ];

  render();
  return {
    update: (nextSnapshot) => {
      snapshot = {
        sequences: [...nextSnapshot.sequences].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
        cursor: nextSnapshot.cursor,
        label: nextSnapshot.label,
      };
      if (playing && position() >= snapshot.sequences.length) playing = false;
      render();
    },
    stop,
    dispose: () => {
      stop();
      for (const dispose of disposers) dispose();
    },
  };
};
