export type CodingTimelineCursorRow = {
  readonly id: string;
  readonly runId: string;
  readonly roomId: string;
  readonly seq: bigint;
};

const positiveLimit = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Coding timeline limit must be a positive safe integer");
  }
  return value;
};

const scopeOrder = (left: CodingTimelineCursorRow, right: CodingTimelineCursorRow): number =>
  left.runId.localeCompare(right.runId) || left.roomId.localeCompare(right.roomId);

const newestFirst = (left: CodingTimelineCursorRow, right: CodingTimelineCursorRow): number =>
  scopeOrder(left, right)
  || (left.seq < right.seq ? 1 : left.seq > right.seq ? -1 : left.id.localeCompare(right.id));

const oldestFirst = (left: CodingTimelineCursorRow, right: CodingTimelineCursorRow): number =>
  scopeOrder(left, right)
  || (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : left.id.localeCompare(right.id));

/** Stable server-side suffix for every unfiltered exact-run public timeline. */
export const boundedCodingTimelineRows = <Row extends CodingTimelineCursorRow>(
  rows: Iterable<Row>,
  maxRows: number,
): ReadonlyArray<Row> => [...rows]
  .sort(newestFirst)
  .slice(0, positiveLimit(maxRows))
  .sort(oldestFirst);

/** Stable bounded head after selecting exactly one authorized run and room. */
export const codingTimelineHead = <Row extends CodingTimelineCursorRow>(
  rows: Iterable<Row>,
  input: {
    readonly runId: string;
    readonly roomId: string;
    readonly maxRows: number;
  },
): ReadonlyArray<Row> => boundedCodingTimelineRows(
  [...rows].filter((row) => row.runId === input.runId && row.roomId === input.roomId),
  input.maxRows,
);

/** Stable exclusive-cursor page scoped to exactly one authorized run and room. */
export const codingTimelinePage = <Row extends CodingTimelineCursorRow>(
  rows: Iterable<Row>,
  input: {
    readonly runId: string;
    readonly roomId: string;
    readonly beforeSeq: bigint;
    readonly maxRows: number;
  },
): ReadonlyArray<Row> => [...rows]
  .filter((row) => row.runId === input.runId
    && row.roomId === input.roomId
    && row.seq < input.beforeSeq)
  .sort(newestFirst)
  .slice(0, positiveLimit(input.maxRows))
  .sort(oldestFirst);
