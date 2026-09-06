import { fold } from "../core/chain.js";
import type { Branch, Chain, Receipt } from "../core/types.js";
import {
  buildAxiomSimpleRuns,
} from "../agents/axiom-simple.runs.js";
import { buildTheoremRuns } from "../agents/theorem.runs.js";
import { buildWriterRuns } from "../agents/writer.runs.js";
import type { AgentEvent } from "../modules/agent.js";
import {
  initial as initialAgent,
  reduce as reduceAgent,
} from "../modules/agent.js";
import type { AxiomSimpleEvent } from "../modules/axiom-simple.js";
import {
  initial as initialAxiomSimple,
  reduce as reduceAxiomSimple,
} from "../modules/axiom-simple.js";
import type { TheoremEvent } from "../modules/theorem.js";
import {
  initial as initialTheorem,
  reduce as reduceTheorem,
} from "../modules/theorem.js";
import type { WriterEvent } from "../modules/writer.js";
import {
  initial as initialWriter,
  reduce as reduceWriter,
} from "../modules/writer.js";
import { initialOrchestrationState } from "../modules/orchestration.js";
import {
  axiomSimpleConversationHtml,
  axiomSimpleChatHtml,
  axiomSimpleFoldsHtml,
  axiomSimpleSideHtml,
} from "../views/axiom-simple.js";
import { axiomChatHtml, axiomSideHtml } from "../views/axiom.js";
import { esc } from "../views/agent-framework.js";
import {
  theoremChatHtml,
  theoremFoldsHtml,
  theoremSideHtml,
} from "../views/theorem.js";
import {
  writerChatHtml,
  writerFoldsHtml,
  writerSideHtml,
} from "../views/writer.js";
import { orchestrationConversationHtml } from "../views/room-conversation.js";

export type RealtimeReceiptRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly streamId: string;
  readonly seq: bigint;
  readonly receiptId: string;
  readonly occurredAtMs: bigint;
  readonly prevHash: string;
  readonly hash: string;
  readonly bodyJson: string;
  readonly hintsJson: string;
};

export type RealtimeBranchRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly streamId: string;
  readonly parentStreamId: string;
  readonly forkAt: number;
  readonly createdAtMs: bigint;
};

export type ReplayCursor = {
  /** `null` is the live frontier. */
  readonly seq: bigint | null;
};

export type RosterPanels = {
  readonly conversationHtml: string;
  readonly chatHtml: string;
  readonly foldsHtml: string;
  readonly sideHtml: string;
  readonly replay: {
    readonly position: number;
    readonly total: number;
    readonly seq: bigint | null;
    readonly label: string;
  };
};

const parseRecord = (encoded: string): Readonly<Record<string, unknown>> | undefined => {
  try {
    const parsed: unknown = JSON.parse(encoded);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : undefined;
  } catch {
    return undefined;
  }
};

export const rowsToChain = <Event extends { readonly type: string }>(
  rows: ReadonlyArray<RealtimeReceiptRow>,
  cursor: ReplayCursor = { seq: null },
): Chain<Event> => rows
  .filter((row) => cursor.seq === null || row.seq <= cursor.seq)
  .sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0)
  .flatMap((row): ReadonlyArray<Receipt<Event>> => {
    const body = parseRecord(row.bodyJson);
    if (!body || typeof body.type !== "string") return [];
    const hints = parseRecord(row.hintsJson);
    return [{
      id: row.receiptId,
      ts: Number(row.occurredAtMs),
      stream: row.streamId,
      prev: row.prevHash || undefined,
      body: body as Event,
      hash: row.hash,
      hints,
    }];
  });

export const branchRowsToBranches = (
  rows: ReadonlyArray<RealtimeBranchRow>,
): ReadonlyArray<Branch> => rows.map((row) => ({
  name: row.streamId,
  parent: row.parentStreamId || undefined,
  forkAt: row.forkAt,
  createdAt: Number(row.createdAtMs),
}));

const replayState = (
  rows: ReadonlyArray<RealtimeReceiptRow>,
  cursor: ReplayCursor,
): RosterPanels["replay"] => {
  const ordered = [...rows].sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
  const position = cursor.seq === null
    ? ordered.length
    : ordered.filter((row) => row.seq <= cursor.seq!).length;
  const current = position > 0 ? ordered[position - 1] : undefined;
  const body = current ? parseRecord(current.bodyJson) : undefined;
  const kind = typeof body?.type === "string" ? body.type.replace(/[._:-]+/g, " ") : "before orchestration";
  return {
    position,
    total: ordered.length,
    seq: cursor.seq,
    label: cursor.seq === null
      ? `Live ${ordered.length}/${ordered.length}`
      : `${position}/${ordered.length} · ${kind}`,
  };
};

export const renderTheoremPanels = (input: {
  readonly basePath: "/theorem" | "/axiom";
  readonly stream: string;
  readonly runId?: string;
  readonly runStream?: string;
  readonly indexRows: ReadonlyArray<RealtimeReceiptRow>;
  readonly runRows: ReadonlyArray<RealtimeReceiptRow>;
  readonly branchRows?: ReadonlyArray<RealtimeBranchRow>;
  readonly branchStream?: string;
  readonly cursor: ReplayCursor;
}): RosterPanels => {
  const indexChain = rowsToChain<TheoremEvent>(input.indexRows);
  const completeChain = rowsToChain<TheoremEvent>(input.runRows);
  const viewChain = rowsToChain<TheoremEvent>(input.runRows, input.cursor);
  const state = fold(viewChain, reduceTheorem, initialTheorem);
  const replay = replayState(input.runRows, input.cursor);
  return {
    conversationHtml: orchestrationConversationHtml({
      state: state.orchestration,
      receipts: viewChain,
      objective: state.problem,
      humanRole: "Mathematical partner",
      emptyLabel: "State a theorem or question to invite proof specialists into the room.",
    }),
    chatHtml: theoremChatHtml(viewChain, input.cursor.seq === null ? null : replay.position),
    foldsHtml: theoremFoldsHtml(
      input.stream,
      buildTheoremRuns(indexChain),
      input.runId,
      input.cursor.seq === null ? null : replay.position,
      { basePath: input.basePath },
    ),
    sideHtml: theoremSideHtml(
      state,
      viewChain,
      input.cursor.seq === null ? null : replay.position,
      completeChain.length,
      input.stream,
      input.runId,
      [],
      input.runStream,
      input.branchStream,
      completeChain,
      branchRowsToBranches(input.branchRows ?? []),
    ),
    replay,
  };
};

export const renderWriterPanels = (input: {
  readonly stream: string;
  readonly runId?: string;
  readonly runStream?: string;
  readonly indexRows: ReadonlyArray<RealtimeReceiptRow>;
  readonly runRows: ReadonlyArray<RealtimeReceiptRow>;
  readonly branchRows?: ReadonlyArray<RealtimeBranchRow>;
  readonly branchStream?: string;
  readonly cursor: ReplayCursor;
}): RosterPanels => {
  const indexChain = rowsToChain<WriterEvent>(input.indexRows);
  const completeChain = rowsToChain<WriterEvent>(input.runRows);
  const viewChain = rowsToChain<WriterEvent>(input.runRows, input.cursor);
  const state = fold(viewChain, reduceWriter, initialWriter);
  const replay = replayState(input.runRows, input.cursor);
  return {
    conversationHtml: orchestrationConversationHtml({
      state: state.orchestration,
      receipts: viewChain,
      objective: state.problem,
      humanRole: "Author",
      emptyLabel: "Share a brief to bring the editorial roster into the room.",
    }),
    chatHtml: writerChatHtml(viewChain, input.cursor.seq === null ? null : replay.position),
    foldsHtml: writerFoldsHtml(
      input.stream,
      buildWriterRuns(indexChain),
      input.runId,
      input.cursor.seq === null ? null : replay.position,
    ),
    sideHtml: writerSideHtml(
      state,
      viewChain,
      input.cursor.seq === null ? null : replay.position,
      completeChain.length,
      input.stream,
      input.runId,
      [],
      input.runStream,
      input.branchStream,
      branchRowsToBranches(input.branchRows ?? []),
      completeChain,
    ),
    replay,
  };
};

export const renderAxiomSimplePanels = (input: {
  readonly stream: string;
  readonly runId?: string;
  readonly runStream?: string;
  readonly indexRows: ReadonlyArray<RealtimeReceiptRow>;
  readonly runRows: ReadonlyArray<RealtimeReceiptRow>;
  readonly cursor: ReplayCursor;
}): RosterPanels => {
  const indexChain = rowsToChain<AxiomSimpleEvent>(input.indexRows);
  const viewChain = rowsToChain<AxiomSimpleEvent>(input.runRows, input.cursor);
  const state = fold(viewChain, reduceAxiomSimple, initialAxiomSimple);
  const replay = replayState(input.runRows, input.cursor);
  const runs = buildAxiomSimpleRuns(indexChain);
  const visibleRuns = input.runId && !runs.some((run) => run.runId === input.runId)
    ? [{
        runId: input.runId,
        problem: "Waiting for first orchestration receipt…",
        status: "running" as const,
        count: 0,
        startedAt: undefined,
      }, ...runs]
    : runs;
  const pending = input.runId
    ? `<div class="empty">Run <code translate="no">${esc(input.runId)}</code> is queued. Waiting for durable orchestration receipts…</div>`
    : `<div class="empty">No run selected.</div>`;
  return {
    conversationHtml: axiomSimpleConversationHtml(state),
    chatHtml: viewChain.length > 0 ? axiomSimpleChatHtml(state, viewChain) : pending,
    foldsHtml: axiomSimpleFoldsHtml(
      input.stream,
      visibleRuns,
      input.runId,
      input.cursor.seq === null ? null : replay.position,
    ),
    sideHtml: viewChain.length > 0 ? axiomSimpleSideHtml(state, viewChain) : pending,
    replay,
  };
};

export const renderAxiomWorkerPanels = (input: {
  readonly stream: string;
  readonly runId: string;
  readonly runRows: ReadonlyArray<RealtimeReceiptRow>;
  readonly cursor: ReplayCursor;
}): RosterPanels => {
  const completeChain = rowsToChain<AgentEvent>(input.runRows);
  const viewChain = rowsToChain<AgentEvent>(input.runRows, input.cursor);
  const state = fold(viewChain, reduceAgent, initialAgent);
  const replay = replayState(input.runRows, input.cursor);
  const pending = `<div class="empty">Run <code translate="no">${esc(input.runId)}</code> is queued. Waiting for durable AXLE receipts…</div>`;
  const currentPosition = input.cursor.seq === null ? null : replay.position;
  const overview = `<section class="aw-run-overview">
    <div><span>Child run</span><code translate="no">${esc(input.runId)}</code></div>
    <div><span>Stream</span><code translate="no">${esc(input.stream)}</code></div>
    <div><span>Status</span><strong>${esc(state.status)}</strong></div>
    <div><span>Receipts</span><strong>${replay.position} / ${completeChain.length}</strong></div>
    ${state.statusNote ? `<p>${esc(state.statusNote)}</p>` : ""}
  </section>
  <style>
    .aw-run-overview{min-width:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;padding:13px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--panel)}
    .aw-run-overview>div{min-width:0;display:grid;gap:5px;padding:10px;border:1px solid var(--line-soft);border-radius:var(--radius-sm);background:var(--panel-2)}
    .aw-run-overview span{color:var(--muted);font:800 8px/1.2 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}
    .aw-run-overview code,.aw-run-overview strong{min-width:0;overflow-wrap:anywhere;color:var(--ink);font-size:11px}
    .aw-run-overview p{grid-column:1/-1;margin:0;color:var(--muted);font-size:11px;line-height:1.5}
    @media(max-width:620px){.aw-run-overview{grid-template-columns:1fr}}
  </style>`;

  return {
    conversationHtml: orchestrationConversationHtml({
      state: initialOrchestrationState,
      receipts: [],
      emptyLabel: "This worker contributes to its parent proof room.",
    }),
    chatHtml: viewChain.length > 0 ? axiomChatHtml(viewChain, input.runId) : pending,
    foldsHtml: completeChain.length > 0 ? overview : pending,
    sideHtml: viewChain.length > 0
      ? axiomSideHtml({
          state,
          chain: viewChain,
          at: currentPosition,
          total: completeChain.length,
          runId: input.runId,
        })
      : pending,
    replay,
  };
};
