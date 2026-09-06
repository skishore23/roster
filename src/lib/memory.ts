// ============================================================================
// Ranked memory context helpers
// ============================================================================

export type RankedContextResult<T> = {
  readonly text: string;
  readonly items: ReadonlyArray<T>;
  readonly truncated: boolean;
  readonly chars: number;
};

export type BuildRankedContextOptions<T> = {
  readonly items: ReadonlyArray<T>;
  readonly score: (item: T) => number;
  readonly ts: (item: T) => number;
  readonly line: (item: T) => string;
  readonly maxChars: number;
  readonly maxItems: number;
  readonly maxLineChars?: number;
  readonly pinned?: ReadonlyArray<T>;
  readonly key?: (item: T) => string | undefined;
};

const truncateLine = (line: string, max: number): { text: string; truncated: boolean } => {
  if (line.length <= max) return { text: line, truncated: false };
  if (max <= 3) return { text: line.slice(0, Math.max(0, max)), truncated: true };
  return { text: `${line.slice(0, max - 3)}...`, truncated: true };
};

export const buildRankedContext = <T>(opts: BuildRankedContextOptions<T>): RankedContextResult<T> => {
  const maxChars = Math.max(0, opts.maxChars);
  const maxItems = Math.max(0, opts.maxItems);
  const maxLineChars = Math.max(8, opts.maxLineChars ?? 320);
  if (maxChars === 0 || maxItems === 0 || opts.items.length === 0) {
    return { text: "", items: [], truncated: false, chars: 0 };
  }

  const keyFor = opts.key ?? (() => undefined);
  const seen = new Set<string>();
  const selected: T[] = [];

  const trySelect = (item: T): boolean => {
    if (selected.length >= maxItems) return false;
    const key = keyFor(item);
    if (key && seen.has(key)) return false;
    selected.push(item);
    if (key) seen.add(key);
    return true;
  };

  (opts.pinned ?? []).forEach((item) => {
    trySelect(item);
  });

  const ranked = [...opts.items].sort((a, b) => {
    const scoreDelta = opts.score(b) - opts.score(a);
    if (scoreDelta !== 0) return scoreDelta;
    return opts.ts(b) - opts.ts(a);
  });
  ranked.forEach((item) => {
    trySelect(item);
  });

  let truncated = false;
  const lines: string[] = [];
  for (const item of selected) {
    const raw = opts.line(item);
    const compact = truncateLine(raw, maxLineChars);
    lines.push(compact.text);
    if (compact.truncated) truncated = true;
  }

  let keptCount = lines.length;
  let text = lines.join("\n").trim();
  while (text.length > maxChars && keptCount > 1) {
    truncated = true;
    keptCount -= 1;
    text = lines.slice(0, keptCount).join("\n").trim();
  }
  if (text.length > maxChars) {
    truncated = true;
    if (maxChars <= 3) text = text.slice(0, maxChars);
    else text = `${text.slice(0, maxChars - 3)}...`;
  }

  return {
    text,
    items: selected.slice(0, keptCount),
    truncated,
    chars: text.length,
  };
};
