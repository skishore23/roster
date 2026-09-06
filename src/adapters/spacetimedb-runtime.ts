import type { Branch, BranchStore, Chain, Receipt, Store } from "../core/types.js";
import {
  CODING_CONVERSATION_MESSAGE_KIND,
  type CodingConversationMessage,
} from "../domains/coding-conversation.js";
import {
  codingRepositoryRoomId,
  type CodingDurableRoom,
  type CodingRoomDirectory,
  type CodingRoomState,
} from "../domains/coding-room.js";
import type { EventStreamProjection, StreamReceiptProjection } from "../spacetimedb-bindings/types.js";
import {
  SpacetimeControlPlane,
  type SpacetimeSubscription,
} from "./spacetimedb-control.js";

export type SpacetimeEventControl = Pick<
  SpacetimeControlPlane,
  | "ensureWorkspace"
  | "subscribeEventStreams"
  | "subscribeStreamReceipts"
  | "workspaceSnapshot"
  | "streamReceipts"
  | "ensureEventStream"
  | "appendStreamReceipt"
  | "appendCodingRoomReceipt"
>;

const DEFAULT_READY_TIMEOUT_MS = 10_000;

const withTimeout = async <Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  message: string,
): Promise<Value> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const timestampMs = (value: { readonly microsSinceUnixEpoch: bigint }): number =>
  Number(value.microsSinceUnixEpoch / 1_000n);

const parseRecord = (name: string, encoded: string): Readonly<Record<string, unknown>> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw new Error(`${name} contains invalid JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
};

const rowToReceipt = <Body>(row: StreamReceiptProjection): Receipt<Body> => ({
  id: row.receiptId,
  ts: Number(row.occurredAtMs),
  stream: row.streamId,
  prev: row.prevHash || undefined,
  body: parseRecord(`receipt ${row.receiptId}`, row.bodyJson) as Body,
  hash: row.hash,
  hints: parseRecord(`receipt hints ${row.receiptId}`, row.hintsJson),
});

const streamKind = (streamId: string): string => {
  const prefix = streamId.split("/", 2)[0]?.trim();
  return prefix ? prefix.slice(0, 80) : "agent";
};

const codingRoomReceiptMessage = <Body>(
  receipt: Receipt<Body>,
): CodingConversationMessage | undefined => {
  if (!receipt.body || typeof receipt.body !== "object" || Array.isArray(receipt.body)) return undefined;
  const event = receipt.body as Readonly<Record<string, unknown>>;
  if (event.type !== "artifact.published" || event.kind !== CODING_CONVERSATION_MESSAGE_KIND) {
    return undefined;
  }
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const encoded = payload as Readonly<Record<string, unknown>>;
  if (encoded.storage !== "inline" || typeof encoded.value !== "string") return undefined;
  try {
    const message = JSON.parse(encoded.value) as Partial<CodingConversationMessage>;
    if (typeof message.conversationId !== "string"
      || typeof message.messageId !== "string"
      || typeof message.text !== "string") return undefined;
    return message as CodingConversationMessage;
  } catch {
    return undefined;
  }
};

/**
 * Shared subscription/cache owner for all typed event-sourced runtimes.
 * SpacetimeDB is the only durable authority; the repository merely exposes the
 * SDK cache through the Store and BranchStore interfaces used by reducers.
 */
export class SpacetimeEventRepository implements CodingRoomDirectory {
  private catalog?: SpacetimeSubscription;
  private catalogReady?: Promise<void>;
  private readonly streamSubscriptions = new Map<string, SpacetimeSubscription>();
  private readonly streamReady = new Map<string, Promise<void>>();

  constructor(
    readonly controlPlane: SpacetimeEventControl,
    readonly workspaceId: string,
    readonly workspaceName = "Roster workspace",
    readonly readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  ) {}

  async initialize(): Promise<void> {
    if (this.catalogReady) return this.catalogReady;
    this.catalogReady = (async () => {
      await this.controlPlane.ensureWorkspace(this.workspaceId, this.workspaceName);
      this.catalog = this.controlPlane.subscribeEventStreams(this.workspaceId, []);
      await withTimeout(
        this.catalog.ready,
        this.readyTimeoutMs,
        `SpacetimeDB workspace catalog timed out after ${this.readyTimeoutMs}ms`,
      );
    })();
    try {
      await this.catalogReady;
    } catch (error) {
      this.catalog?.close();
      this.catalog = undefined;
      this.catalogReady = undefined;
      throw error;
    }
  }

  async subscribeStream(streamId: string): Promise<void> {
    await this.initialize();
    const existing = this.streamReady.get(streamId);
    if (existing) return existing;
    const subscription = this.controlPlane.subscribeStreamReceipts(this.workspaceId, streamId);
    this.streamSubscriptions.set(streamId, subscription);
    const ready = withTimeout(
      subscription.ready,
      this.readyTimeoutMs,
      `SpacetimeDB receipt stream ${streamId} timed out after ${this.readyTimeoutMs}ms`,
    );
    this.streamReady.set(streamId, ready);
    try {
      await ready;
    } catch (error) {
      subscription.close();
      this.streamSubscriptions.delete(streamId);
      this.streamReady.delete(streamId);
      throw error;
    }
  }

  streamMetadata(streamId: string): EventStreamProjection | undefined {
    return this.controlPlane.workspaceSnapshot(this.workspaceId).streams.find(
      (stream) => stream.streamId === streamId
    );
  }

  async ensureRootStream(streamId: string): Promise<void> {
    await this.initialize();
    if (this.streamMetadata(streamId)) return;
    await this.controlPlane.ensureEventStream({
      workspaceId: this.workspaceId,
      streamId,
      kind: streamKind(streamId),
    });
  }

  async append<Body>(receipt: Receipt<Body>): Promise<void> {
    const roomMessage = codingRoomReceiptMessage(receipt);
    if (roomMessage) {
      const codingWorkspaceId = roomMessage.workspaceId?.trim();
      if (!codingWorkspaceId) {
        throw new Error(
          `Coding conversation message ${roomMessage.messageId} is missing its durable workspaceId`,
        );
      }
      const expectedStream = `agents/coding-agent/runs/${roomMessage.conversationId}`;
      if (receipt.stream !== expectedStream) {
        throw new Error(`Coding conversation message ${roomMessage.messageId} used the wrong stream`);
      }
      await this.initialize();
      await this.subscribeStream(receipt.stream);
      await this.controlPlane.appendCodingRoomReceipt({
        workspaceId: this.workspaceId,
        codingWorkspaceId,
        roomId: codingRepositoryRoomId(roomMessage.conversationId),
        conversationId: roomMessage.conversationId,
        streamId: receipt.stream,
        receiptId: receipt.id,
        occurredAtMs: BigInt(receipt.ts),
        prevHash: receipt.prev ?? "",
        hash: receipt.hash,
        bodyJson: JSON.stringify(receipt.body),
        hintsJson: JSON.stringify(receipt.hints ?? {}),
      });
      return;
    }
    await this.ensureRootStream(receipt.stream);
    await this.subscribeStream(receipt.stream);
    await this.controlPlane.appendStreamReceipt({
      workspaceId: this.workspaceId,
      streamId: receipt.stream,
      receiptId: receipt.id,
      occurredAtMs: BigInt(receipt.ts),
      prevHash: receipt.prev ?? "",
      hash: receipt.hash,
      bodyJson: JSON.stringify(receipt.body),
      hintsJson: JSON.stringify(receipt.hints ?? {}),
    });
  }

  async list(codingWorkspaceId: string): Promise<ReadonlyArray<CodingDurableRoom>> {
    await this.initialize();
    return this.controlPlane.workspaceSnapshot(this.workspaceId).codingRooms
      .filter((room) => room.codingWorkspaceId === codingWorkspaceId)
      .map((room) => ({
        roomId: room.roomId,
        conversationId: room.conversationId,
        codingWorkspaceId: room.codingWorkspaceId,
        streamId: room.streamId,
        title: room.title,
        state: (
          room.state === "waiting" || room.state === "archived" ? room.state : "open"
        ) as CodingRoomState,
        firstMessageId: room.firstMessageId,
        messageCount: room.messageCount,
        createdAt: timestampMs(room.createdAt),
        updatedAt: timestampMs(room.updatedAt),
      }));
  }

  async read<Body>(streamId: string): Promise<Chain<Body>> {
    await this.subscribeStream(streamId);
    return this.controlPlane.streamReceipts(this.workspaceId, streamId).map(rowToReceipt<Body>);
  }

  async saveBranch(branch: Branch): Promise<void> {
    await this.initialize();
    if (branch.parent) {
      const parent = this.streamMetadata(branch.parent);
      if (!parent) throw new Error(`Cannot fork missing stream ${branch.parent}`);
      await this.controlPlane.ensureEventStream({
        workspaceId: this.workspaceId,
        streamId: branch.name,
        kind: "branch",
        parentStreamId: branch.parent,
        forkAt: branch.forkAt ?? 0,
      });
    } else {
      const existing = this.streamMetadata(branch.name);
      if (!existing) {
        await this.controlPlane.ensureEventStream({
          workspaceId: this.workspaceId,
          streamId: branch.name,
          kind: "branch-root",
        });
      }
    }
  }

  branches(): ReadonlyArray<Branch> {
    const streams = this.controlPlane.workspaceSnapshot(this.workspaceId).streams;
    const parents = new Set(streams
      .filter((stream) => stream.parentStreamId)
      .map((stream) => stream.parentStreamId));
    return streams
      .filter((stream) => stream.kind === "branch" || stream.kind === "branch-root" || parents.has(stream.streamId))
      .map((stream) => ({
        name: stream.streamId,
        parent: stream.parentStreamId || undefined,
        forkAt: stream.parentStreamId ? stream.forkAt : undefined,
        createdAt: timestampMs(stream.createdAt),
      }));
  }

  close(): void {
    this.catalog?.close();
    this.catalog = undefined;
    this.catalogReady = undefined;
    for (const subscription of this.streamSubscriptions.values()) subscription.close();
    this.streamSubscriptions.clear();
    this.streamReady.clear();
  }
}

export const spacetimeStore = <Body>(repository: SpacetimeEventRepository): Store<Body> => ({
  append: (receipt) => repository.append(receipt),
  read: (stream) => repository.read<Body>(stream),
  take: async (stream, count) => (await repository.read<Body>(stream)).slice(0, count),
  count: async (stream) => (await repository.read<Body>(stream)).length,
  head: async (stream) => (await repository.read<Body>(stream)).at(-1),
});

export const spacetimeBranchStore = (repository: SpacetimeEventRepository): BranchStore => ({
  save: (branch) => repository.saveBranch(branch),
  get: async (name) => {
    await repository.initialize();
    return repository.branches().find((branch) => branch.name === name);
  },
  list: async () => {
    await repository.initialize();
    return [...repository.branches()];
  },
  children: async (parent) => {
    await repository.initialize();
    return repository.branches().filter((branch) => branch.parent === parent);
  },
});
