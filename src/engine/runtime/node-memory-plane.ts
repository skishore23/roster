import { hashCanonical } from "../../core/canonical.js";
import type {
  RosterFunctionDescriptor,
  RosterFunctionDirectory,
  RosterFunctionProviderControl,
} from "../functions/function-directory.js";
import type { JsonValue } from "../orchestration/types.js";

export const ROSTER_MEMORY_SCOPE_FUNCTION_ID = "roster::memory.scopes" as const;
export const ROSTER_MEMORY_SEARCH_FUNCTION_ID = "roster::memory.search" as const;
export const ROSTER_MEMORY_OPEN_FUNCTION_ID = "roster::memory.open" as const;
export const ROSTER_MEMORY_DIFF_FUNCTION_ID = "roster::memory.diff" as const;
export const ROSTER_MEMORY_PROPOSE_FUNCTION_ID = "roster::memory.propose" as const;

const MAX_SCOPES = 128;
const MAX_DOCUMENTS = 200;
const MAX_DOCUMENT_TEXT_BYTES = 64 * 1_024;
const MAX_RESULT_BYTES = 8 * 1_048_576;

export type RosterMemoryScopeKind =
  | "memory"
  | "room"
  | "receipts"
  | "artifact"
  | "trajectory"
  | "git";

export type RosterMemoryScope = {
  readonly scopeId: string;
  readonly kind: RosterMemoryScopeKind;
  readonly label: string;
  readonly description: string;
  readonly snapshotVersion?: string;
  readonly writable?: boolean;
};

export type RosterMemoryDocument = {
  readonly documentId: string;
  readonly scopeId: string;
  readonly kind: string;
  readonly text: string;
  readonly contentHash: string;
  readonly sourceVersion: string;
  readonly timestamp?: number;
  readonly metadata?: JsonValue;
  readonly references?: ReadonlyArray<string>;
};

export type RosterMemoryProposalInput = {
  readonly scopeId: string;
  readonly text: string;
  readonly tags?: ReadonlyArray<string>;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly sourceReferences?: ReadonlyArray<{
    readonly sourceId: string;
    readonly contentHash: string;
    readonly kind?: string;
  }>;
};

export type RosterMemoryProposalResult = {
  readonly proposalId: string;
  readonly scopeId: string;
  readonly contentHash: string;
  readonly status: "pending";
  readonly proposedBy: string;
};

export type RosterMemoryRepositoryControl = {
  readonly nodeId: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly signal: AbortSignal;
};

export type RosterMemoryRepository = {
  readonly scopes: (
    control: RosterMemoryRepositoryControl,
  ) => Promise<ReadonlyArray<RosterMemoryScope>>;
  readonly search: (
    input: { readonly scopeId: string; readonly query: string; readonly limit: number },
    control: RosterMemoryRepositoryControl,
  ) => Promise<ReadonlyArray<RosterMemoryDocument>>;
  readonly open: (
    input: { readonly scopeId: string; readonly documentIds: ReadonlyArray<string> },
    control: RosterMemoryRepositoryControl,
  ) => Promise<ReadonlyArray<RosterMemoryDocument>>;
  readonly diff: (
    input: {
      readonly scopeId: string;
      readonly fromTimestamp: number;
      readonly toTimestamp?: number;
      readonly limit: number;
    },
    control: RosterMemoryRepositoryControl,
  ) => Promise<ReadonlyArray<RosterMemoryDocument>>;
  readonly propose?: (
    input: RosterMemoryProposalInput,
    control: RosterMemoryRepositoryControl,
  ) => Promise<RosterMemoryProposalResult>;
};

export const nodePrivateMemoryScopeId = (workspaceId: string, nodeId: string): string => {
  const workspace = workspaceId.trim();
  const node = nodeId.trim();
  if (!workspace || !node || workspace.length > 160 || node.length > 160) {
    throw new Error("Node-private memory requires bounded workspaceId and nodeId");
  }
  return `node:${workspace}:${node}`;
};

/** Enforces one node-owned memory scope at the repository boundary. */
export const scopeRosterMemoryRepositoryToNode = (input: {
  readonly repository: RosterMemoryRepository;
  readonly workspaceId: string;
  readonly nodeId: string;
}): RosterMemoryRepository => {
  const scopeId = nodePrivateMemoryScopeId(input.workspaceId, input.nodeId);
  const assertControl = (control: RosterMemoryRepositoryControl): void => {
    if (control.nodeId !== input.nodeId) {
      throw new Error(`Node ${control.nodeId} cannot access private memory owned by ${input.nodeId}`);
    }
  };
  const assertScope = (selected: string): void => {
    if (selected !== scopeId) throw new Error(`Memory scope ${selected} is not authorized for node ${input.nodeId}`);
  };
  return {
    scopes: async (control) => {
      assertControl(control);
      return (await input.repository.scopes(control)).filter((scope) => scope.scopeId === scopeId);
    },
    search: async (value, control) => {
      assertControl(control);
      assertScope(value.scopeId);
      return input.repository.search(value, control);
    },
    open: async (value, control) => {
      assertControl(control);
      assertScope(value.scopeId);
      return input.repository.open(value, control);
    },
    diff: async (value, control) => {
      assertControl(control);
      assertScope(value.scopeId);
      return input.repository.diff(value, control);
    },
    ...(input.repository.propose ? {
      propose: async (value: RosterMemoryProposalInput, control: RosterMemoryRepositoryControl) => {
        assertControl(control);
        assertScope(value.scopeId);
        return input.repository.propose!(value, control);
      },
    } : {}),
  };
};

const functionControl = (
  control: RosterFunctionProviderControl,
): RosterMemoryRepositoryControl => ({
  nodeId: control.nodeId,
  signal: control.signal,
  ...(typeof control.metadata?.roster_run_id === "string"
    ? { runId: control.metadata.roster_run_id }
    : {}),
  ...(typeof control.metadata?.roster_task_id === "string"
    ? { taskId: control.metadata.roster_task_id }
    : {}),
});

const asObject = (value: JsonValue): Readonly<Record<string, JsonValue>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Roster memory function input must be an object");
  }
  return value as Readonly<Record<string, JsonValue>>;
};

const stringValue = (
  value: JsonValue | undefined,
  label: string,
  maximum: number,
): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized) > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
  return normalized;
};

const integerValue = (
  value: JsonValue | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number => {
  const normalized = value === undefined ? fallback : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return Math.max(minimum, Math.min(maximum, normalized));
};

const normalizedDocument = (
  document: RosterMemoryDocument,
): RosterMemoryDocument => {
  const documentId = stringValue(document.documentId, "Memory document id", 512);
  const scopeId = stringValue(document.scopeId, "Memory document scope", 512);
  const kind = stringValue(document.kind, "Memory document kind", 120);
  const text = stringValue(document.text, "Memory document text", MAX_DOCUMENT_TEXT_BYTES);
  const contentHash = stringValue(document.contentHash, "Memory document content hash", 256);
  const sourceVersion = stringValue(document.sourceVersion, "Memory document source version", 256);
  if (document.timestamp !== undefined && (!Number.isFinite(document.timestamp) || document.timestamp < 0)) {
    throw new Error(`Memory document ${documentId} has an invalid timestamp`);
  }
  const normalized: RosterMemoryDocument = {
    documentId,
    scopeId,
    kind,
    text,
    contentHash,
    sourceVersion,
    ...(document.timestamp !== undefined ? { timestamp: Math.floor(document.timestamp) } : {}),
    ...(document.metadata !== undefined ? { metadata: document.metadata } : {}),
    ...(document.references?.length
      ? { references: [...new Set(document.references.map((reference) =>
          stringValue(reference, "Memory document reference", 2_048)))].sort().slice(0, 64) }
      : {}),
  };
  return normalized;
};

const boundedDocuments = (
  documents: ReadonlyArray<RosterMemoryDocument>,
  scopeId: string,
  limit: number,
): ReadonlyArray<RosterMemoryDocument> => {
  const normalized = documents.slice(0, Math.min(limit, MAX_DOCUMENTS)).map(normalizedDocument);
  if (normalized.some((document) => document.scopeId !== scopeId)) {
    throw new Error(`Roster memory repository returned a document outside scope ${scopeId}`);
  }
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded) > MAX_RESULT_BYTES) {
    throw new Error(`Roster memory result exceeded ${MAX_RESULT_BYTES} bytes`);
  }
  return normalized;
};

const scopeSchema = {
  type: "string",
  minLength: 1,
  maxLength: 512,
} as const;

export const createRosterMemoryFunctionDescriptors = (input: {
  readonly capability?: string;
  readonly readScope?: string;
  readonly proposeScope?: string;
} = {}): ReadonlyArray<RosterFunctionDescriptor> => {
  const capability = input.capability ?? "memory";
  const readScopes = input.readScope ? [input.readScope] : [];
  const proposeScopes = input.proposeScope ? [input.proposeScope] : [];
  return [
    {
      id: ROSTER_MEMORY_SCOPE_FUNCTION_ID,
      version: "1",
      capability,
      description: "List the durable memory, room, receipt, artifact, trajectory, and Git scopes authorized for this execution.",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: true,
      effects: ["read"],
      requiredScopes: readScopes,
      idempotency: "supported",
    },
    {
      id: ROSTER_MEMORY_SEARCH_FUNCTION_ID,
      version: "1",
      capability,
      description: "Search one authorized durable context scope and return bounded provenance-bearing documents.",
      inputSchema: {
        type: "object",
        required: ["scopeId", "query"],
        additionalProperties: false,
        properties: {
          scopeId: scopeSchema,
          query: { type: "string", minLength: 1, maxLength: 2_000 },
          limit: { type: "integer", minimum: 1, maximum: MAX_DOCUMENTS },
        },
      },
      outputSchema: true,
      effects: ["read"],
      requiredScopes: readScopes,
      idempotency: "supported",
    },
    {
      id: ROSTER_MEMORY_OPEN_FUNCTION_ID,
      version: "1",
      capability,
      description: "Open exact document identities from one authorized context scope.",
      inputSchema: {
        type: "object",
        required: ["scopeId", "documentIds"],
        additionalProperties: false,
        properties: {
          scopeId: scopeSchema,
          documentIds: {
            type: "array",
            minItems: 1,
            maxItems: MAX_DOCUMENTS,
            items: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
      },
      outputSchema: true,
      effects: ["read"],
      requiredScopes: readScopes,
      idempotency: "supported",
    },
    {
      id: ROSTER_MEMORY_DIFF_FUNCTION_ID,
      version: "1",
      capability,
      description: "Read a bounded timestamp interval from one authorized context scope.",
      inputSchema: {
        type: "object",
        required: ["scopeId", "fromTimestamp"],
        additionalProperties: false,
        properties: {
          scopeId: scopeSchema,
          fromTimestamp: { type: "integer", minimum: 0 },
          toTimestamp: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: MAX_DOCUMENTS },
        },
      },
      outputSchema: true,
      effects: ["read"],
      requiredScopes: readScopes,
      idempotency: "supported",
    },
    {
      id: ROSTER_MEMORY_PROPOSE_FUNCTION_ID,
      version: "1",
      capability,
      description: "Propose bounded durable memory with exact source hashes; Roster must accept it before it becomes memory.",
      inputSchema: {
        type: "object",
        required: ["scopeId", "text"],
        additionalProperties: false,
        properties: {
          scopeId: scopeSchema,
          text: { type: "string", minLength: 1, maxLength: 65_536 },
          tags: {
            type: "array",
            maxItems: 32,
            items: { type: "string", minLength: 1, maxLength: 160 },
          },
          metadata: { type: "object" },
          sourceReferences: {
            type: "array",
            maxItems: 64,
            items: {
              type: "object",
              required: ["sourceId", "contentHash"],
              additionalProperties: false,
              properties: {
                sourceId: { type: "string", minLength: 1, maxLength: 512 },
                contentHash: { type: "string", minLength: 1, maxLength: 256 },
                kind: { type: "string", minLength: 1, maxLength: 120 },
              },
            },
          },
        },
      },
      outputSchema: true,
      effects: ["write"],
      requiredScopes: proposeScopes,
      idempotency: "required",
    },
  ];
};

export const bindRosterMemoryFunctionProviders = (input: {
  readonly directory: RosterFunctionDirectory;
  readonly repository: RosterMemoryRepository;
  readonly providerId?: string;
  readonly epoch?: number;
}): (() => void) => {
  const providerId = input.providerId ?? "roster-memory";
  const epoch = input.epoch ?? 1;
  const generation = input.directory.bindProviderGeneration({
    providers: [{
      providerId,
      functionId: ROSTER_MEMORY_SCOPE_FUNCTION_ID,
      epoch,
      invoke: async (_value, control) => {
        const scopes = (await input.repository.scopes(functionControl(control)))
          .slice(0, MAX_SCOPES)
          .map((scope) => ({
            ...scope,
            scopeId: stringValue(scope.scopeId, "Memory scope id", 512),
            label: stringValue(scope.label, "Memory scope label", 240),
            description: stringValue(scope.description, "Memory scope description", 2_000),
          }));
        return { scopes } as JsonValue;
      },
    }, {
      providerId,
      functionId: ROSTER_MEMORY_SEARCH_FUNCTION_ID,
      epoch,
      invoke: async (value, control) => {
        const object = asObject(value);
        const scopeId = stringValue(object.scopeId, "Memory scope id", 512);
        const query = stringValue(object.query, "Memory search query", 2_000);
        const limit = integerValue(object.limit, 20, 1, MAX_DOCUMENTS, "Memory search limit");
        const documents = boundedDocuments(
          await input.repository.search({ scopeId, query, limit }, functionControl(control)),
          scopeId,
          limit,
        );
        return { scopeId, query, documents } as JsonValue;
      },
    }, {
      providerId,
      functionId: ROSTER_MEMORY_OPEN_FUNCTION_ID,
      epoch,
      invoke: async (value, control) => {
        const object = asObject(value);
        const scopeId = stringValue(object.scopeId, "Memory scope id", 512);
        const rawIds = object.documentIds;
        if (!Array.isArray(rawIds)) throw new Error("Memory documentIds must be an array");
        const documentIds = [...new Set(rawIds.map((id) =>
          stringValue(id, "Memory document id", 512)))].slice(0, MAX_DOCUMENTS);
        const documents = boundedDocuments(
          await input.repository.open({ scopeId, documentIds }, functionControl(control)),
          scopeId,
          documentIds.length,
        );
        return { scopeId, documents } as JsonValue;
      },
    }, {
      providerId,
      functionId: ROSTER_MEMORY_DIFF_FUNCTION_ID,
      epoch,
      invoke: async (value, control) => {
        const object = asObject(value);
        const scopeId = stringValue(object.scopeId, "Memory scope id", 512);
        const fromTimestamp = integerValue(
          object.fromTimestamp,
          0,
          0,
          Number.MAX_SAFE_INTEGER,
          "Memory diff fromTimestamp",
        );
        const toTimestamp = object.toTimestamp === undefined
          ? undefined
          : integerValue(
              object.toTimestamp,
              fromTimestamp,
              fromTimestamp,
              Number.MAX_SAFE_INTEGER,
              "Memory diff toTimestamp",
            );
        const limit = integerValue(object.limit, 50, 1, MAX_DOCUMENTS, "Memory diff limit");
        const documents = boundedDocuments(
          await input.repository.diff({
            scopeId,
            fromTimestamp,
            ...(toTimestamp !== undefined ? { toTimestamp } : {}),
            limit,
          }, functionControl(control)),
          scopeId,
          limit,
        );
        return {
          scopeId,
          fromTimestamp,
          ...(toTimestamp !== undefined ? { toTimestamp } : {}),
          documents,
        } as JsonValue;
      },
    }, {
      providerId,
      functionId: ROSTER_MEMORY_PROPOSE_FUNCTION_ID,
      epoch,
      invoke: async (value, control) => {
        if (!input.repository.propose) throw new Error("This memory repository is read-only");
        const object = asObject(value);
        const scopeId = stringValue(object.scopeId, "Memory scope id", 512);
        const text = stringValue(object.text, "Memory proposal text", 64 * 1_024);
        const tags = Array.isArray(object.tags)
          ? object.tags.map((tag) => stringValue(tag, "Memory proposal tag", 160))
          : undefined;
        const metadata = object.metadata && typeof object.metadata === "object" && !Array.isArray(object.metadata)
          ? object.metadata as Readonly<Record<string, JsonValue>>
          : undefined;
        const sourceReferences = Array.isArray(object.sourceReferences)
          ? object.sourceReferences.map((reference) => {
              const source = asObject(reference);
              return {
                sourceId: stringValue(source.sourceId, "Memory proposal source id", 512),
                contentHash: stringValue(source.contentHash, "Memory proposal source hash", 256),
                ...(source.kind !== undefined
                  ? { kind: stringValue(source.kind, "Memory proposal source kind", 120) }
                  : {}),
              };
            })
          : undefined;
        return await input.repository.propose({
          scopeId,
          text,
          ...(tags?.length ? { tags } : {}),
          ...(metadata ? { metadata } : {}),
          ...(sourceReferences?.length ? { sourceReferences } : {}),
        }, functionControl(control)) as JsonValue;
      },
    }],
  });
  return () => {
    void generation.withdraw();
  };
};

export const createCompositeRosterMemoryRepository = (
  repositories: ReadonlyArray<RosterMemoryRepository>,
): RosterMemoryRepository => {
  const select = async (
    scopeId: string,
    control: RosterMemoryRepositoryControl,
  ): Promise<RosterMemoryRepository> => {
    const owners: RosterMemoryRepository[] = [];
    for (const repository of repositories) {
      if ((await repository.scopes(control)).some((scope) => scope.scopeId === scopeId)) {
        owners.push(repository);
      }
    }
    if (owners.length === 0) throw new Error(`Memory scope ${scopeId} is not authorized for this execution`);
    if (owners.length > 1) throw new Error(`Memory scope ${scopeId} has multiple providers`);
    return owners[0]!;
  };
  return {
    scopes: async (control) => {
      const scopes = (await Promise.all(repositories.map((repository) =>
        repository.scopes(control)))).flat();
      const byId = new Map<string, RosterMemoryScope>();
      for (const scope of scopes) {
        if (byId.has(scope.scopeId)) throw new Error(`Memory scope ${scope.scopeId} has multiple providers`);
        byId.set(scope.scopeId, scope);
      }
      return [...byId.values()].sort((left, right) => left.scopeId.localeCompare(right.scopeId));
    },
    search: async (value, control) => (await select(value.scopeId, control)).search(value, control),
    open: async (value, control) => (await select(value.scopeId, control)).open(value, control),
    diff: async (value, control) => (await select(value.scopeId, control)).diff(value, control),
    propose: async (value, control) => {
      const repository = await select(value.scopeId, control);
      if (!repository.propose) throw new Error(`Memory scope ${value.scopeId} is read-only`);
      return repository.propose(value, control);
    },
  };
};

export const createDocumentRosterMemoryRepository = (input: {
  readonly scopes: (
    control: RosterMemoryRepositoryControl,
  ) => Promise<ReadonlyArray<RosterMemoryScope>>;
  readonly documents: (
    scopeId: string,
    control: RosterMemoryRepositoryControl,
  ) => Promise<ReadonlyArray<RosterMemoryDocument>>;
}): RosterMemoryRepository => {
  const documents = async (
    scopeId: string,
    control: RosterMemoryRepositoryControl,
  ): Promise<ReadonlyArray<RosterMemoryDocument>> => {
    const authorized = (await input.scopes(control)).some((scope) => scope.scopeId === scopeId);
    if (!authorized) throw new Error(`Memory scope ${scopeId} is not authorized for this execution`);
    return input.documents(scopeId, control);
  };
  return {
    scopes: input.scopes,
    search: async ({ scopeId, query, limit }, control) => {
      const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
      return (await documents(scopeId, control))
        .filter((document) => terms.every((term) =>
          `${document.text} ${JSON.stringify(document.metadata ?? null)}`.toLowerCase().includes(term)))
        .slice(0, limit);
    },
    open: async ({ scopeId, documentIds }, control) => {
      const ids = new Set(documentIds);
      return (await documents(scopeId, control)).filter((document) => ids.has(document.documentId));
    },
    diff: async ({ scopeId, fromTimestamp, toTimestamp, limit }, control) =>
      (await documents(scopeId, control))
        .filter((document) => document.timestamp !== undefined
          && document.timestamp >= fromTimestamp
          && document.timestamp <= (toTimestamp ?? Number.MAX_SAFE_INTEGER))
        .sort((left, right) =>
          (left.timestamp ?? 0) - (right.timestamp ?? 0)
          || left.documentId.localeCompare(right.documentId))
        .slice(0, limit),
  };
};

export const rosterMemoryDocument = (input: Omit<
RosterMemoryDocument,
"contentHash" | "sourceVersion"
> & {
  readonly contentHash?: string;
  readonly sourceVersion?: string;
}): RosterMemoryDocument => {
  const content = {
    documentId: input.documentId,
    scopeId: input.scopeId,
    kind: input.kind,
    text: input.text,
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.references?.length ? { references: [...input.references] } : {}),
  };
  const contentHash = input.contentHash ?? hashCanonical(content);
  return {
    ...content,
    contentHash,
    sourceVersion: input.sourceVersion ?? contentHash,
  };
};
