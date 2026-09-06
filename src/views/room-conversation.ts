import type { OrchestrationState } from "../modules/orchestration.js";
import { orchestrationOutputValues } from "../modules/orchestration.js";
import { esc } from "./agent-framework.js";

type ConversationReceipt = {
  readonly ts: number;
  readonly body: { readonly type: string };
};

type ConversationMessage = {
  readonly id: string;
  readonly author: string;
  readonly role: string;
  readonly kind: "human" | "agent" | "system";
  readonly text: string;
  readonly ts?: number;
  readonly tone?: "attention" | "resolved";
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const pretty = (value: string): string => value
  .replace(/[._:-]+/g, " ")
  .replace(/\b\w/g, (character) => character.toUpperCase());

const truncate = (value: string, maximum = 260): string =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 1).trimEnd()}…`;

const readableValue = (encoded: string | undefined): string | undefined => {
  if (!encoded) return undefined;
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (typeof parsed === "string") return truncate(parsed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Readonly<Record<string, unknown>>;
      for (const key of ["summary", "content", "message", "text", "result"]) {
        const candidate = text(record[key]);
        if (candidate) return truncate(candidate);
      }
    }
  } catch {
    // Output values may already be plain text.
  }
  return truncate(encoded);
};

const memberName = (state: OrchestrationState, nodeId: string | undefined): string =>
  (nodeId ? state.nodes[nodeId]?.name : undefined)
  ?? (nodeId ? pretty(nodeId) : "Roster");

const memberRole = (state: OrchestrationState, nodeId: string | undefined): string => {
  if (!nodeId) return "Facilitator";
  const node = state.nodes[nodeId];
  const role = text(node?.metadata?.role);
  return role ? pretty(role) : pretty(node?.capabilities[0] ?? "Agent");
};

const configuredMessage = (
  state: OrchestrationState,
  receipt: ConversationReceipt,
): ConversationMessage | undefined => {
  const body = receipt.body as { readonly type: string } & Readonly<Record<string, unknown>>;
  const configured = Array.isArray(body.nodes)
    ? body.nodes
      .flatMap((candidate) => candidate && typeof candidate === "object"
        ? [candidate as Readonly<Record<string, unknown>>]
        : [])
      .map((candidate) => text(candidate.name))
      .filter((name): name is string => Boolean(name))
    : Object.values(state.nodes).map((node) => node.name);
  const names = [...new Set(configured)].filter((name) => name !== "Roster");
  if (names.length === 0) return undefined;
  return {
    id: `configured-${String(receipt.ts)}`,
    author: "Roster",
    role: "Facilitator",
    kind: "system",
    text: `I brought ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${String(names.length - 5)} more` : ""} into the room. Everyone is working from the same goal and shared artifact.`,
    ts: receipt.ts,
  };
};

const projectReceipt = (
  state: OrchestrationState,
  outputs: Readonly<Record<string, string>>,
  receipt: ConversationReceipt,
): ConversationMessage | undefined => {
  const body = receipt.body as { readonly type: string } & Readonly<Record<string, unknown>>;
  switch (body.type) {
    case "orchestration.configured":
      return configuredMessage(state, receipt);
    case "node.spawned": {
      const node = body.node && typeof body.node === "object"
        ? body.node as Readonly<Record<string, unknown>>
        : undefined;
      const nodeId = text(node?.id);
      const name = text(node?.name) ?? memberName(state, nodeId);
      const reason = text(body.reason);
      return {
        id: `joined-${nodeId ?? name}-${String(receipt.ts)}`,
        author: name,
        role: memberRole(state, nodeId),
        kind: "agent",
        text: reason ? `I joined the room to ${reason.replace(/\.$/, "")}.` : "I joined the room and picked up the shared context.",
        ts: receipt.ts,
      };
    }
    case "node.retired": {
      const nodeId = text(body.nodeId);
      return {
        id: `left-${nodeId ?? "member"}-${String(receipt.ts)}`,
        author: "Roster",
        role: "Facilitator",
        kind: "system",
        text: `${memberName(state, nodeId)} finished their part and left the active roster.`,
        ts: receipt.ts,
      };
    }
    case "artifact.published": {
      if (body.origin !== "task") return undefined;
      const nodeId = text(body.nodeId);
      const outputKey = text(body.outputKey) ?? "contribution";
      const preview = readableValue(outputs[outputKey]);
      return {
        id: `artifact-${text(body.artifactId) ?? outputKey}-${String(receipt.ts)}`,
        author: memberName(state, nodeId),
        role: memberRole(state, nodeId),
        kind: "agent",
        text: `I added ${pretty(outputKey)} to the shared work${preview ? `: ${preview}` : "."}`,
        ts: receipt.ts,
      };
    }
    case "reflection.recorded": {
      const reason = text(body.reason);
      if (!reason) return undefined;
      return {
        id: `reflection-${text(body.reflectionId) ?? String(receipt.ts)}`,
        author: "Roster",
        role: "Facilitator",
        kind: "system",
        text: `I adjusted who is in the room and how they are collaborating: ${reason}`,
        ts: receipt.ts,
      };
    }
    case "composition.proposed": {
      const nodeId = text(body.nodeId);
      return {
        id: `proposal-${text(body.proposalId) ?? String(receipt.ts)}`,
        author: memberName(state, nodeId),
        role: memberRole(state, nodeId),
        kind: "agent",
        text: `I proposed a combined result for ${pretty(text(body.compositionId) ?? "the room")}. The room is checking it against the shared evidence.`,
        ts: receipt.ts,
      };
    }
    case "composition.certified":
      return {
        id: `certified-${text(body.certificationId) ?? String(receipt.ts)}`,
        author: "Roster",
        role: "Facilitator",
        kind: "system",
        text: `The room accepted ${pretty(text(body.compositionId) ?? "the combined result")}. Its evidence and exact contributing frontier remain available under How we got here.`,
        ts: receipt.ts,
        tone: "resolved",
      };
    case "composition.rejected":
      return {
        id: `rejected-${text(body.compositionId) ?? String(receipt.ts)}-${String(receipt.ts)}`,
        author: "Roster",
        role: "Facilitator",
        kind: "system",
        text: `The room kept an objection open: ${text(body.detail) ?? pretty(text(body.reason) ?? "the proposal did not satisfy acceptance")}.`,
        ts: receipt.ts,
        tone: "attention",
      };
    default:
      return undefined;
  }
};

const messageHtml = (message: ConversationMessage): string => {
  const initial = message.kind === "human" ? "Y" : message.author.slice(0, 1).toUpperCase();
  return `<li class="room-message room-message-${message.kind}" data-message-id="${esc(message.id)}"${message.tone ? ` data-tone="${message.tone}"` : ""}>
    <span class="room-message-avatar" aria-hidden="true">${esc(initial)}</span>
    <article><header><strong>${esc(message.author)}</strong><span>${esc(message.role)}</span>${message.ts === undefined ? "" : `<time datetime="${new Date(message.ts).toISOString()}">${esc(new Date(message.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))}</time>`}</header><p>${esc(message.text)}</p></article>
  </li>`;
};

export const orchestrationConversationHtml = (input: {
  readonly state: OrchestrationState;
  readonly receipts: ReadonlyArray<ConversationReceipt>;
  readonly objective?: string;
  readonly humanRole?: string;
  readonly emptyLabel?: string;
}): string => {
  const outputs = orchestrationOutputValues(input.state);
  const firstTimestamp = input.receipts[0]?.ts;
  const messages: ConversationMessage[] = [];
  if (input.objective?.trim()) {
    messages.push({
      id: "room-objective",
      author: "You",
      role: input.humanRole ?? "Room participant",
      kind: "human",
      text: input.objective.trim(),
      ts: firstTimestamp,
    });
  }
  for (const receipt of input.receipts) {
    const message = projectReceipt(input.state, outputs, receipt);
    if (message) messages.push(message);
  }
  if (messages.length === 0) {
    return `<div class="room-thread-empty"><span aria-hidden="true">+</span><strong>Start the conversation</strong><p>${esc(input.emptyLabel ?? "Share an outcome or question. Named agents will join this room around the work.")}</p></div>`;
  }
  return `<ol class="room-thread" aria-label="Room conversation">${messages.slice(-80).map(messageHtml).join("")}</ol>`;
};
