import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedCodingTimelineRows,
  codingTimelinePage,
} from "../../spacetimedb/src/coding-timeline-pagination.ts";
import * as codingTimelinePagination from "../../spacetimedb/src/coding-timeline-pagination.ts";

const rows = Array.from({ length: 600 }, (_, index) => ({
  id: `timeline-${String(index + 1).padStart(4, "0")}`,
  runId: "run-current",
  roomId: "room-current",
  seq: BigInt(index + 1),
}));

test("unfiltered Coding timeline and cursor pages remain bounded, stable, and duplicate-free", () => {
  const newest = boundedCodingTimelineRows([...rows].reverse(), 256);
  assert.equal(newest.length, 256, "SELECT * can never expose more than the public cap");
  assert.deepEqual(newest.map((row) => row.seq), rows.slice(344).map((row) => row.seq));

  const first = codingTimelinePage([
    ...rows,
    { id: "foreign-run", runId: "run-foreign", roomId: "room-current", seq: 344n },
    { id: "foreign-room", runId: "run-current", roomId: "room-foreign", seq: 344n },
  ].reverse(), {
    runId: "run-current",
    roomId: "room-current",
    beforeSeq: newest[0]!.seq,
    maxRows: 64,
  });
  const second = codingTimelinePage(rows, {
    runId: "run-current",
    roomId: "room-current",
    beforeSeq: first[0]!.seq,
    maxRows: 64,
  });
  assert.deepEqual(first.map((row) => row.seq), rows.slice(280, 344).map((row) => row.seq));
  assert.deepEqual(second.map((row) => row.seq), rows.slice(216, 280).map((row) => row.seq));
  assert.equal(new Set([...newest, ...first, ...second].map((row) => row.id)).size, 384);
  assert.deepEqual(
    codingTimelinePage([...rows].reverse(), {
      runId: "run-current",
      roomId: "room-current",
      beforeSeq: newest[0]!.seq,
      maxRows: 64,
    }),
    first,
    "page order must be independent of storage iteration order",
  );
});

test("selected Coding timeline filters the exact run and room before applying its head cap", () => {
  const selectedHead = (codingTimelinePagination as unknown as {
    readonly codingTimelineHead?: <Row extends {
      readonly id: string;
      readonly runId: string;
      readonly roomId: string;
      readonly seq: bigint;
    }>(rows: Iterable<Row>, input: {
      readonly runId: string;
      readonly roomId: string;
      readonly maxRows: number;
    }) => ReadonlyArray<Row>;
  }).codingTimelineHead;
  assert.equal(typeof selectedHead, "function");
  const foreign = Array.from({ length: 300 }, (_, index) => ({
    id: `foreign-${String(index + 1).padStart(4, "0")}`,
    runId: "aa-foreign",
    roomId: "room-foreign",
    seq: BigInt(index + 1),
  }));
  const selected = Array.from({ length: 400 }, (_, index) => ({
    id: `selected-${String(index + 1).padStart(4, "0")}`,
    runId: "zz-selected",
    roomId: "room-selected",
    seq: BigInt(index + 1),
  }));

  const head = selectedHead!([...foreign, ...selected].reverse(), {
    runId: "zz-selected",
    roomId: "room-selected",
    maxRows: 256,
  });
  assert.equal(head.length, 256);
  assert.deepEqual(head.map((row) => row.seq), selected.slice(144).map((row) => row.seq));
  assert.ok(head.every((row) => row.runId === "zz-selected" && row.roomId === "room-selected"));
});
