import { hashCanonical } from "../core/canonical.js";
import type { Receipt } from "../core/types.js";
import type { DurableMemoryTools } from "../adapters/memory-tools.js";
import { createDurableRosterMemoryRepository } from "../adapters/roster-memory.js";
import {
  createCompositeRosterMemoryRepository,
  createDocumentRosterMemoryRepository,
  nodePrivateMemoryScopeId,
  rosterMemoryDocument,
  type RosterMemoryRepository,
  type RosterMemoryRepositoryControl,
  type RosterMemoryScope,
} from "../engine/runtime/node-memory-plane.js";
import type { OrchestrationEvent } from "../modules/orchestration.js";
import { codingConversationFromEvents } from "./coding-conversation.js";

const MAX_DOCUMENT_TEXT_CHARS = 60_000;

const boundedText = (value: string): string =>
  value.length <= MAX_DOCUMENT_TEXT_CHARS
    ? value
    : `${value.slice(0, MAX_DOCUMENT_TEXT_CHARS)}\n[truncated; use the source reference for the complete artifact]`;

/** Creates the exact current-room, run-receipt, run-artifact, and workspace-memory scopes for one coding run. */
export const createCodingRosterMemoryRepository = (input: {
  readonly memory: DurableMemoryTools;
  readonly workspaceScopeId: string;
  readonly nodePrivateMemory?: {
    readonly workspaceId: string;
    readonly nodeIds: ReadonlyArray<string>;
  };
  readonly conversationId: string;
  readonly runId: string;
  readonly conversationReceipts: () => Promise<ReadonlyArray<Receipt<OrchestrationEvent>>>;
  readonly runReceipts: () => Promise<ReadonlyArray<Receipt<OrchestrationEvent>>>;
}): RosterMemoryRepository => {
  const roomScopeId = `room:${input.conversationId}`;
  const receiptScopeId = `receipts:${input.runId}`;
  const artifactScopeId = `artifacts:${input.runId}`;
  const scopes = async (): Promise<ReadonlyArray<RosterMemoryScope>> => {
    const [conversation, run] = await Promise.all([
      input.conversationReceipts(),
      input.runReceipts(),
    ]);
    return [{
      scopeId: roomScopeId,
      kind: "room",
      label: "Current room history",
      description: "Complete chronological messages from the current authorized room.",
      snapshotVersion: conversation.at(-1)?.hash ?? hashCanonical([]),
    }, {
      scopeId: receiptScopeId,
      kind: "receipts",
      label: "Current run receipts",
      description: "Ordered control and evidence receipts for this exact coding run.",
      snapshotVersion: run.at(-1)?.hash ?? hashCanonical([]),
    }, {
      scopeId: artifactScopeId,
      kind: "artifact",
      label: "Current run artifacts",
      description: "Accepted inline values and external references published by this coding run.",
      snapshotVersion: run.at(-1)?.hash ?? hashCanonical([]),
    }];
  };
  const documents = async (scopeId: string) => {
    if (scopeId === roomScopeId) {
      const receipts = await input.conversationReceipts();
      const sourceVersion = receipts.at(-1)?.hash ?? hashCanonical([]);
      return codingConversationFromEvents(receipts.map((receipt) => receipt.body)).messages.map((message) =>
        rosterMemoryDocument({
          documentId: message.messageId,
          scopeId,
          kind: "room-message",
          text: message.text,
          timestamp: message.createdAt,
          metadata: {
            author: message.author,
            source: message.source,
            tags: [...message.tags],
            mentions: [...message.mentions],
            ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          },
          sourceVersion,
        }));
    }
    const receipts = await input.runReceipts();
    const sourceVersion = receipts.at(-1)?.hash ?? hashCanonical([]);
    if (scopeId === receiptScopeId) {
      return receipts.map((receipt) => rosterMemoryDocument({
        documentId: receipt.id,
        scopeId,
        kind: receipt.body.type,
        text: boundedText(JSON.stringify(receipt.body)),
        timestamp: receipt.ts,
        metadata: {
          stream: receipt.stream,
          previousReceiptId: receipt.prev ?? null,
        },
        references: [receipt.hash],
        contentHash: receipt.hash,
        sourceVersion,
      }));
    }
    if (scopeId === artifactScopeId) {
      return receipts.flatMap((receipt) => {
        const event = receipt.body;
        if (event.type !== "artifact.published") return [];
        const completeValue = event.payload.storage === "inline"
          ? event.payload.value
          : event.payload.uri;
        return [rosterMemoryDocument({
          documentId: event.artifactId,
          scopeId,
          kind: event.kind,
          text: boundedText(completeValue),
          timestamp: receipt.ts,
          metadata: {
            outputKey: event.outputKey,
            nodeId: event.nodeId,
            taskId: event.taskId ?? null,
            storage: event.payload.storage,
            inputVersions: event.inputVersions,
          },
          references: event.payload.storage === "external" ? [event.payload.uri] : [],
          contentHash: event.contentHash,
          sourceVersion,
        })];
      });
    }
    throw new Error(`Memory scope ${scopeId} is not authorized for this coding run`);
  };
  const privateScopeOwners = new Map<string, string>();
  for (const nodeId of input.nodePrivateMemory?.nodeIds ?? []) {
    privateScopeOwners.set(nodePrivateMemoryScopeId(input.nodePrivateMemory!.workspaceId, nodeId), nodeId);
  }
  const repository = createCompositeRosterMemoryRepository([
    createDurableRosterMemoryRepository(input.memory, {
      scopeIds: [input.workspaceScopeId, ...privateScopeOwners.keys()],
    }),
    createDocumentRosterMemoryRepository({
      scopes: async () => scopes(),
      documents: async (scopeId) => documents(scopeId),
    }),
  ]);
  const assertPrivateScopeAccess = (
    scopeId: string,
    control: RosterMemoryRepositoryControl,
  ): void => {
    const owner = privateScopeOwners.get(scopeId);
    if (owner && owner !== control.nodeId) {
      throw new Error(`Node ${control.nodeId} cannot access private memory owned by ${owner}`);
    }
  };
  const record = async (
    operation: "search" | "open" | "diff",
    scopeId: string,
    selected: Awaited<ReturnType<RosterMemoryRepository["search"]>>,
    control: Parameters<RosterMemoryRepository["search"]>[1],
    query?: string,
  ): Promise<void> => {
    await input.memory.recordAccess({
      runId: control.runId ?? input.runId,
      taskId: control.taskId ?? "unbound-memory-task",
      nodeId: control.nodeId,
      operation,
      scopeId,
      ...(query ? { queryHash: hashCanonical(query) } : {}),
      documents: selected.map((document) => ({
        documentId: document.documentId,
        contentHash: document.contentHash,
        sourceVersion: document.sourceVersion,
      })),
    });
  };
  return {
    scopes: async (control) => (await repository.scopes(control)).filter((scope) => {
      const owner = privateScopeOwners.get(scope.scopeId);
      return !owner || owner === control.nodeId;
    }),
    search: async (value, control) => {
      assertPrivateScopeAccess(value.scopeId, control);
      const selected = await repository.search(value, control);
      await record("search", value.scopeId, selected, control, value.query);
      return selected;
    },
    open: async (value, control) => {
      assertPrivateScopeAccess(value.scopeId, control);
      const selected = await repository.open(value, control);
      await record("open", value.scopeId, selected, control);
      return selected;
    },
    diff: async (value, control) => {
      assertPrivateScopeAccess(value.scopeId, control);
      const selected = await repository.diff(value, control);
      await record("diff", value.scopeId, selected, control);
      return selected;
    },
    ...(repository.propose ? {
      propose: async (value, control) => {
        assertPrivateScopeAccess(value.scopeId, control);
        return repository.propose!(value, control);
      },
    } : {}),
  };
};
