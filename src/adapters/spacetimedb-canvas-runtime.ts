import { computeHash, fold } from "../core/chain.js";
import { hashCanonical } from "../core/canonical.js";
import type { Runtime } from "../core/runtime.js";
import type { Branch, Chain, Receipt } from "../core/types.js";
import type { CanvasCmd, CanvasEvent, CanvasState } from "../modules/canvas.js";
import { decideCanvas, initialCanvas, reduceCanvas } from "../modules/canvas.js";
import type { SpacetimeControlPlane } from "./spacetimedb-control.js";

const CANVAS_EVENT_TYPES = new Set<string>([
  "prompt.set",
  "run.configured",
  "run.status",
  "scene.planned",
  "scene.patch.applied",
  "scene.reviewed",
  "scene.finalized",
  "orchestration.configured",
  "node.spawned",
  "node.retired",
  "node.runtime.bound",
  "reflection.recorded",
  "topology.selected",
  "task.graph.projected",
  "function.activity.recorded",
  "prompt.compiled",
  "artifact.published",
  "evidence.recorded",
  "composition.proposed",
  "composition.certified",
  "composition.rejected",
  "control.update.published",
  "control.frontier.projected",
  "control.frontier.certified",
]);

const eventAuthorId = (event: CanvasEvent): string => {
  if ("nodeId" in event && typeof event.nodeId === "string") return event.nodeId;
  if (event.type === "node.spawned") return event.node.id;
  if (event.type === "node.runtime.bound") return event.binding.nodeId;
  if ("agentId" in event && typeof event.agentId === "string") return event.agentId;
  return "orchestrator";
};

const parseCanvasEvent = (kind: string, encoded: string): CanvasEvent | undefined => {
  if (!CANVAS_EVENT_TYPES.has(kind)) return undefined;
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const type = (parsed as { readonly type?: unknown }).type;
    if (type !== kind || typeof type !== "string" || !CANVAS_EVENT_TYPES.has(type)) return undefined;
    return parsed as CanvasEvent;
  } catch {
    return undefined;
  }
};

const receiptTimestampMs = (value: { readonly microsSinceUnixEpoch: bigint }): number =>
  Number(value.microsSinceUnixEpoch / 1_000n);

/**
 * Present the durable SpacetimeDB receipt projection through the Runtime API
 * used by the Canvas workflow. SpacetimeDB remains authoritative; this adapter
 * only reconstructs deterministic local receipt hashes for folding/time travel.
 */
export const createSpacetimeCanvasRuntime = (
  controlPlane: SpacetimeControlPlane,
  runId: string,
  coordinator: { readonly taskId: string; readonly fence: bigint }
): Runtime<CanvasCmd, CanvasEvent, CanvasState> => {
  let executionTail = Promise.resolve();

  const chain = async (_stream: string): Promise<Chain<CanvasEvent>> => {
    const output: Receipt<CanvasEvent>[] = [];
    let prev: string | undefined;
    for (const row of controlPlane.canvasReceipts(runId)) {
      const body = parseCanvasEvent(row.kind, row.payloadJson);
      if (!body) continue;
      const base = {
        id: row.eventId,
        ts: receiptTimestampMs(row.createdAt),
        stream: runId,
        prev,
        body,
        hints: {
          eventId: row.eventId,
          spacetimeHash: row.hash,
          spacetimePrevHash: row.prevHash,
          spacetimeSeq: row.seq.toString(),
        },
      };
      const next: Receipt<CanvasEvent> = { ...base, hash: computeHash(base) };
      output.push(next);
      prev = next.hash;
    }
    return output;
  };

  const executeUnlocked = async (cmd: CanvasCmd): Promise<CanvasEvent[]> => {
    const [event] = decideCanvas(cmd);
    const eventJson = JSON.stringify(event);
    const eventHash = hashCanonical({ eventId: cmd.eventId, event });
    const existing = controlPlane.canvasReceipts(runId).find((row) => row.eventId === cmd.eventId);
    if (existing) {
      if (existing.hash !== eventHash || existing.payloadJson !== eventJson || existing.kind !== event.type) {
        throw new Error(`Canvas event ${cmd.eventId} changed after publication`);
      }
      return [];
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const receipts = controlPlane.canvasReceipts(runId);
      const currentHead = receipts.at(-1)?.hash ?? "";
      if (cmd.expectedPrev !== undefined && cmd.expectedPrev !== currentHead) {
        throw new Error(`Expected prev hash ${cmd.expectedPrev} but SpacetimeDB head is ${currentHead || "<genesis>"}`);
      }
      try {
        await controlPlane.projectCanvasEvent({
          runId,
          coordinatorTaskId: coordinator.taskId,
          coordinatorFence: coordinator.fence,
          eventId: cmd.eventId,
          expectedPrev: currentHead,
          eventHash,
          kind: event.type,
          agentId: eventAuthorId(event),
          eventJson,
          summary: summarizeCanvasEvent(event),
        });
        return [event];
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!/expected previous hash/i.test(message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(80, 8 * (attempt + 1))));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Canvas receipt head kept changing while publishing an event");
  };

  const execute = async (_stream: string, cmd: CanvasCmd): Promise<CanvasEvent[]> => {
    const pending = executionTail.then(() => executeUnlocked(cmd));
    executionTail = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const stateFrom = async (stream: string, count?: number): Promise<CanvasState> => {
    const receipts = await chain(stream);
    return fold(count === undefined ? receipts : receipts.slice(0, count), reduceCanvas, initialCanvas);
  };

  return {
    execute,
    state: (stream) => stateFrom(stream),
    stateAt: (stream, count) => stateFrom(stream, count),
    chain,
    chainAt: async (stream, count) => (await chain(stream)).slice(0, count),
    verify: async () => {
      const rows = controlPlane.canvasReceipts(runId);
      let previous = "";
      let canvasCount = 0;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        if (row.prevHash !== previous) {
          return { ok: false as const, at: index, reason: "broken SpacetimeDB receipt link" };
        }
        const event = parseCanvasEvent(row.kind, row.payloadJson);
        if (event) {
          canvasCount += 1;
          if (row.hash !== hashCanonical({ eventId: row.eventId, event })) {
            return { ok: false as const, at: index, reason: "Canvas event hash mismatch" };
          }
        }
        previous = row.hash;
      }
      return { ok: true as const, count: canvasCount, head: previous || undefined };
    },
    fork: async (): Promise<Branch> => {
      throw new Error("Canvas runs are immutable SpacetimeDB streams and cannot be forked through the local Runtime API");
    },
    branch: async () => undefined,
    branches: async () => [],
    children: async () => [],
  };
};

export const summarizeCanvasEvent = (event: CanvasEvent): string => {
  switch (event.type) {
    case "prompt.set": return event.prompt;
    case "run.configured": return `${event.config.maxParallel} studio artists · role-aware model routing`;
    case "run.status": return event.note ?? event.status;
    case "scene.planned": return `${event.plan.painterCount} feature-owned painter responsibilities and a shared composition scaffold planned`;
    case "scene.patch.applied": return `${event.patch.partId} published ${event.patch.objects.length} visual marks${event.patch.supersedesPatchId ? " as a repair" : ""}`;
    case "scene.reviewed": return `${event.review.qualityStatus === "accepted-with-notes" ? "accepted-with-notes" : event.review.verdict}: ${event.review.checks.length} ${event.review.scope === "rendered-visual" ? "rendered visual" : "structural"} checks`;
    case "scene.finalized": return `${event.objectCount} objects certified`;
    case "orchestration.configured": return `${event.domainId} domain configured`;
    case "node.spawned": return `${event.node.name} joined the scene`;
    case "node.retired": return `${event.nodeId} retired`;
    case "node.runtime.bound": return `${event.binding.nodeId} bound ${event.binding.runtime.kind}`;
    case "reflection.recorded": return event.reason;
    case "topology.selected": return event.reason;
    case "task.graph.projected": return `${event.graph.tasks.length} durable graph tasks projected`;
    case "function.activity.recorded": return `${event.activity.operation} by ${event.activity.nodeId}`;
    case "prompt.compiled": return `${event.capability} prompt compiled`;
    case "artifact.published": return `${event.outputKey} published`;
    case "evidence.recorded": return `${event.evidence.kind}: ${event.evidence.verdict}`;
    case "composition.proposed": return `${event.compositionId} proposed`;
    case "composition.certified": return `${event.compositionId} certified`;
    case "composition.rejected": return event.detail;
    case "control.update.published": {
      const payload = event.payload;
      if (payload.kind === "proposal") return `${payload.authorRole} proposed ${payload.action.type.replaceAll("_", " ")}`;
      if (payload.kind === "endorsement") return `${payload.nodeRole} ${payload.verdict}d ${payload.proposalId}`;
      return `${payload.nodeId} withdrew ${payload.proposalId}`;
    }
    case "control.frontier.projected": return `${event.acceptedProposalIds.length} proposal(s) eligible · ${event.conflictCount} conflict(s)`;
    case "control.frontier.certified": return `${event.acceptedProposalIds.length} distributed decision(s) certified`;
  }
};
