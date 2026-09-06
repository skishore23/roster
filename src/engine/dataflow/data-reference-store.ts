import { canonicalize, hashCanonical } from "../../core/canonical.js";
import type { JsonValue } from "../orchestration/types.js";
import {
  ROSTER_DATA_REFERENCE_VERSION,
  type DataReference,
} from "../platform/protocol.js";

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_VALUE_BYTES = 16 * 1_048_576;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1_048_576;
const DEFAULT_MAX_REFERENCE_BYTES = 16_384;
const HARD_MAX_ENTRIES = 4_096;
const HARD_MAX_VALUE_BYTES = 64 * 1_048_576;
const HARD_MAX_TOTAL_BYTES = 512 * 1_048_576;
const HARD_MAX_REFERENCE_BYTES = 65_536;
const ROSTER_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

export type DataReferenceStoreDurability = "process-local" | "durable";

export type DataReferenceStoreLimits = {
  readonly maxEntries?: number;
  readonly maxValueBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxReferenceBytes?: number;
};

export type DataReferenceWrite = {
  readonly value: JsonValue;
  readonly mediaType?: string;
  readonly storage?: DataReference["storage"];
  readonly producerFunctionId?: string;
  readonly producerFunctionVersion?: string;
  readonly artifactId?: string;
  readonly uri?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export type DataReferenceStore = {
  /**
   * Process-local stores cannot satisfy replay after a worker or server
   * restart. Durable stores resolve immutable bodies from artifact/object
   * storage and may be paired with a durable TaskGraphControl.
   */
  readonly durability: DataReferenceStoreDurability;
  readonly put: (
    input: DataReferenceWrite,
    control?: { readonly signal?: AbortSignal },
  ) => Promise<DataReference>;
  readonly read: (
    reference: DataReference,
    control?: { readonly signal?: AbortSignal },
  ) => Promise<JsonValue>;
};

/**
 * Minimal provider boundary for S3, GCS, R2, content-addressed artifact stores,
 * or another immutable blob service. Implementations must atomically accept an
 * exact replay and reject replacement bytes for an existing locator.
 */
export type ImmutableDataReferenceBlobBackend = {
  readonly putImmutable: (
    reference: DataReference,
    bytes: Uint8Array,
    control?: { readonly signal?: AbortSignal },
  ) => Promise<void>;
  readonly read: (
    reference: DataReference,
    control?: { readonly signal?: AbortSignal },
  ) => Promise<Uint8Array | undefined>;
};

export type DurableDataReferenceLocation =
  | {
      readonly storage: "artifact";
      readonly artifactId: string;
    }
  | {
      readonly storage: "object";
      readonly uri: string;
    };

export type DurableDataReferenceLocatorInput = {
  readonly blobId: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly requestedStorage?: DataReference["storage"];
  readonly requestedArtifactId?: string;
  readonly requestedUri?: string;
};

export type DurableDataReferenceLocator = (
  input: DurableDataReferenceLocatorInput,
) => DurableDataReferenceLocation;

export type DurableBlobDataReferenceStoreOptions = {
  readonly backend: ImmutableDataReferenceBlobBackend;
  readonly locate: DurableDataReferenceLocator;
  readonly limits?: DataReferenceStoreLimits;
};

type ResolvedLimits = {
  readonly maxEntries: number;
  readonly maxValueBytes: number;
  readonly maxTotalBytes: number;
  readonly maxReferenceBytes: number;
};

type EncodedValue = {
  readonly value: JsonValue;
  readonly bytes: Uint8Array;
};

type StoredValue = {
  readonly reference: DataReference;
  readonly bytes: Uint8Array;
};

type NormalizedWrite = {
  readonly value: JsonValue;
  readonly mediaType: string;
  readonly producerFunctionId?: string;
  readonly producerFunctionVersion?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

const cloneJson = <Value extends JsonValue>(value: Value): Value =>
  JSON.parse(canonicalize(value)) as Value;

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return resolved;
};

const resolveLimits = (limits: DataReferenceStoreLimits): ResolvedLimits => {
  const resolved = {
    maxEntries: boundedInteger(
      limits.maxEntries,
      DEFAULT_MAX_ENTRIES,
      HARD_MAX_ENTRIES,
      "Data store maxEntries",
    ),
    maxValueBytes: boundedInteger(
      limits.maxValueBytes,
      DEFAULT_MAX_VALUE_BYTES,
      HARD_MAX_VALUE_BYTES,
      "Data store maxValueBytes",
    ),
    maxTotalBytes: boundedInteger(
      limits.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      HARD_MAX_TOTAL_BYTES,
      "Data store maxTotalBytes",
    ),
    maxReferenceBytes: boundedInteger(
      limits.maxReferenceBytes,
      DEFAULT_MAX_REFERENCE_BYTES,
      HARD_MAX_REFERENCE_BYTES,
      "Data store maxReferenceBytes",
    ),
  };
  if (resolved.maxValueBytes > resolved.maxTotalBytes) {
    throw new Error("Data store maxValueBytes must not exceed maxTotalBytes");
  }
  return resolved;
};

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error("Data reference operation was aborted");

const assertActive = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError(signal);
};

const cloneReference = (reference: DataReference): DataReference => ({
  ...reference,
  ...(reference.metadata ? { metadata: cloneJson(reference.metadata) } : {}),
});

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const isPlainText = (mediaType: string): boolean =>
  mediaType.split(";", 1)[0]?.trim() === "text/plain";

const normalizeWrite = (input: DataReferenceWrite): NormalizedWrite => {
  const mediaType = (input.mediaType ?? "application/json").trim().toLowerCase();
  if (!mediaType || mediaType.length > 160) {
    throw new Error("Data reference mediaType must be between 1 and 160 characters");
  }
  if (Boolean(input.producerFunctionId) !== Boolean(input.producerFunctionVersion)) {
    throw new Error("Data reference producer function id and version must be supplied together");
  }
  const producerFunctionId = input.producerFunctionId?.trim();
  const producerFunctionVersion = input.producerFunctionVersion?.trim();
  if (
    (producerFunctionId?.length ?? 0) > 240
    || (producerFunctionVersion?.length ?? 0) > 120
    || (input.artifactId?.length ?? 0) > 500
    || (input.uri?.length ?? 0) > 2_000
  ) {
    throw new Error("Data reference identity fields exceed their bounded lengths");
  }
  return {
    value: cloneJson(input.value),
    mediaType,
    ...(producerFunctionId ? { producerFunctionId } : {}),
    ...(producerFunctionVersion ? { producerFunctionVersion } : {}),
    ...(input.metadata ? { metadata: cloneJson(input.metadata) } : {}),
  };
};

const encodeValue = (value: JsonValue, mediaType: string): EncodedValue => {
  if (isPlainText(mediaType)) {
    if (typeof value !== "string") {
      throw new Error("text/plain data references require a string value");
    }
    return {
      value,
      bytes: new TextEncoder().encode(value),
    };
  }
  const canonical = canonicalize(value);
  return {
    value: JSON.parse(canonical) as JsonValue,
    bytes: new TextEncoder().encode(canonical),
  };
};

const decodeValue = (
  bytes: Uint8Array,
  mediaType: string,
  referenceId: string,
): JsonValue => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Data reference ${referenceId} contains invalid UTF-8`);
  }
  if (isPlainText(mediaType)) return text;
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch {
    throw new Error(`Data reference ${referenceId} contains invalid JSON`);
  }
  const canonicalBytes = new TextEncoder().encode(canonicalize(value));
  if (!bytesEqual(bytes, canonicalBytes)) {
    throw new Error(`Data reference ${referenceId} does not contain canonical JSON`);
  }
  return value;
};

const referenceIdentity = (
  reference: Omit<DataReference, "schemaVersion" | "referenceId">,
): Omit<DataReference, "schemaVersion" | "referenceId"> => ({
  contentHash: reference.contentHash,
  mediaType: reference.mediaType,
  byteLength: reference.byteLength,
  storage: reference.storage,
  ...(reference.producerFunctionId ? { producerFunctionId: reference.producerFunctionId } : {}),
  ...(reference.producerFunctionVersion ? { producerFunctionVersion: reference.producerFunctionVersion } : {}),
  ...(reference.artifactId ? { artifactId: reference.artifactId } : {}),
  ...(reference.uri ? { uri: reference.uri } : {}),
  ...(reference.metadata ? { metadata: cloneJson(reference.metadata) } : {}),
});

const createReference = (
  normalized: NormalizedWrite,
  encoded: EncodedValue,
  location: Pick<DataReference, "storage" | "artifactId" | "uri">,
): DataReference => {
  const content = referenceIdentity({
    contentHash: hashCanonical(encoded.value),
    mediaType: normalized.mediaType,
    byteLength: encoded.bytes.byteLength,
    storage: location.storage,
    ...(normalized.producerFunctionId ? { producerFunctionId: normalized.producerFunctionId } : {}),
    ...(normalized.producerFunctionVersion
      ? { producerFunctionVersion: normalized.producerFunctionVersion }
      : {}),
    ...(location.artifactId ? { artifactId: location.artifactId } : {}),
    ...(location.uri ? { uri: location.uri } : {}),
    ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
  });
  return {
    schemaVersion: ROSTER_DATA_REFERENCE_VERSION,
    referenceId: `data_${hashCanonical(content).slice(0, 32)}`,
    ...content,
  };
};

const validateReference = (
  reference: DataReference,
  options: {
    readonly requireDurable?: boolean;
    readonly maxReferenceBytes: number;
  },
): void => {
  if (reference.schemaVersion !== ROSTER_DATA_REFERENCE_VERSION) {
    throw new Error("Unsupported data reference schema version");
  }
  if (!reference.referenceId.trim()) throw new Error("Data reference id must not be blank");
  if (!reference.mediaType.trim()) throw new Error("Data reference mediaType must not be blank");
  if (!Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0) {
    throw new Error(`Data reference ${reference.referenceId} has an invalid byte length`);
  }
  if (!["ephemeral", "artifact", "object"].includes(reference.storage)) {
    throw new Error(`Data reference ${reference.referenceId} has invalid storage`);
  }
  if (
    (reference.artifactId?.length ?? 0) > 500
    || (reference.uri?.length ?? 0) > 2_000
  ) {
    throw new Error(`Data reference ${reference.referenceId} locator is too large`);
  }
  if (options.requireDurable && reference.storage === "ephemeral") {
    throw new Error(`Data reference ${reference.referenceId} is not durably located`);
  }
  if (reference.storage === "artifact" && !reference.artifactId?.trim()) {
    throw new Error(`Artifact data reference ${reference.referenceId} has no artifact id`);
  }
  if (reference.storage === "object" && !reference.uri?.trim()) {
    throw new Error(`Object data reference ${reference.referenceId} has no URI`);
  }
  const {
    schemaVersion: _schemaVersion,
    referenceId: _referenceId,
    ...identityInput
  } = reference;
  const expectedId = `data_${hashCanonical(referenceIdentity(identityInput)).slice(0, 32)}`;
  if (reference.referenceId !== expectedId) {
    throw new Error(`Data reference ${reference.referenceId} has an invalid reference identity`);
  }
  if (Buffer.byteLength(JSON.stringify(reference), "utf8") > options.maxReferenceBytes) {
    throw new Error(`Data reference metadata exceeds maxReferenceBytes=${options.maxReferenceBytes}`);
  }
};

const validateBody = (
  reference: DataReference,
  bytes: Uint8Array,
  maxValueBytes: number,
): JsonValue => {
  if (bytes.byteLength > maxValueBytes) {
    throw new Error(`Data reference ${reference.referenceId} exceeds maxValueBytes=${maxValueBytes}`);
  }
  if (bytes.byteLength !== reference.byteLength) {
    throw new Error(`Data reference ${reference.referenceId} has a changed byte length`);
  }
  const value = decodeValue(bytes, reference.mediaType, reference.referenceId);
  if (hashCanonical(value) !== reference.contentHash) {
    throw new Error(`Data reference ${reference.referenceId} has a changed content hash`);
  }
  return value;
};

const normalizePrefix = (value: string, label: string, maximum: number): string => {
  const normalized = value.trim().replace(/\/+$/u, "");
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} characters`);
  }
  return normalized;
};

export const createArtifactDataReferenceLocator = (
  artifactIdPrefix: string,
): DurableDataReferenceLocator => {
  const prefix = normalizePrefix(artifactIdPrefix, "Artifact data reference prefix", 194);
  if (!ROSTER_ARTIFACT_ID.test(prefix)) {
    throw new Error("Artifact data reference prefix contains unsafe characters");
  }
  return (input) => {
    if (input.requestedStorage && input.requestedStorage !== "artifact") {
      throw new Error("Artifact data reference store cannot satisfy non-artifact storage");
    }
    if (input.requestedUri) {
      throw new Error("Artifact data reference store does not accept an object URI");
    }
    const artifactId = input.requestedArtifactId?.trim() || `${prefix}:${input.blobId}`;
    if (!ROSTER_ARTIFACT_ID.test(artifactId)) {
      throw new Error("Artifact data reference id contains unsafe characters");
    }
    return {
      storage: "artifact",
      artifactId,
    };
  };
};

export const createObjectDataReferenceLocator = (
  objectBaseUri: string,
): DurableDataReferenceLocator => {
  const prefix = normalizePrefix(objectBaseUri, "Object data reference base URI", 1_800);
  return (input) => {
    if (input.requestedStorage && input.requestedStorage !== "object") {
      throw new Error("Object data reference store cannot satisfy non-object storage");
    }
    if (input.requestedArtifactId) {
      throw new Error("Object data reference store does not accept an artifact id");
    }
    return {
      storage: "object",
      uri: input.requestedUri?.trim() || `${prefix}/${input.blobId}`,
    };
  };
};

/**
 * A bounded execution-local implementation. It deliberately advertises that
 * values disappear with the process, even when a reference uses artifact or
 * object-shaped metadata for a local pipeline test.
 */
export class InMemoryDataReferenceStore implements DataReferenceStore {
  readonly durability = "process-local" as const;
  private readonly limits: ResolvedLimits;
  private readonly values = new Map<string, StoredValue>();
  private totalBytes = 0;

  constructor(limits: DataReferenceStoreLimits = {}) {
    this.limits = resolveLimits(limits);
  }

  async put(
    input: DataReferenceWrite,
    control: { readonly signal?: AbortSignal } = {},
  ): Promise<DataReference> {
    assertActive(control.signal);
    const normalized = normalizeWrite(input);
    const encoded = encodeValue(normalized.value, normalized.mediaType);
    if (encoded.bytes.byteLength > this.limits.maxValueBytes) {
      throw new Error(`Data reference value exceeds maxValueBytes=${this.limits.maxValueBytes}`);
    }
    const storage = input.storage ?? "ephemeral";
    if (storage === "artifact" && !input.artifactId?.trim()) {
      throw new Error("Artifact data references require artifactId");
    }
    if (storage === "object" && !input.uri?.trim()) {
      throw new Error("Object data references require uri");
    }
    const reference = createReference(normalized, encoded, {
      storage,
      ...(input.artifactId?.trim() ? { artifactId: input.artifactId.trim() } : {}),
      ...(input.uri?.trim() ? { uri: input.uri.trim() } : {}),
    });
    validateReference(reference, { maxReferenceBytes: this.limits.maxReferenceBytes });
    const existing = this.values.get(reference.referenceId);
    if (existing) return cloneReference(existing.reference);
    if (this.values.size >= this.limits.maxEntries) {
      throw new Error(`Data reference store exceeds maxEntries=${this.limits.maxEntries}`);
    }
    if (this.totalBytes + encoded.bytes.byteLength > this.limits.maxTotalBytes) {
      throw new Error(`Data reference store exceeds maxTotalBytes=${this.limits.maxTotalBytes}`);
    }
    this.values.set(reference.referenceId, {
      reference,
      bytes: encoded.bytes.slice(),
    });
    this.totalBytes += encoded.bytes.byteLength;
    assertActive(control.signal);
    return cloneReference(reference);
  }

  async read(
    reference: DataReference,
    control: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonValue> {
    assertActive(control.signal);
    validateReference(reference, { maxReferenceBytes: this.limits.maxReferenceBytes });
    const stored = this.values.get(reference.referenceId);
    if (!stored || hashCanonical(stored.reference) !== hashCanonical(reference)) {
      throw new Error(`Data reference ${reference.referenceId} is unavailable or changed`);
    }
    const value = validateBody(reference, stored.bytes, this.limits.maxValueBytes);
    assertActive(control.signal);
    return cloneJson(value);
  }
}

/**
 * Durable, provider-neutral data plane backed by immutable artifact or object
 * blobs. A fresh store instance can resolve any valid reference through the
 * same backend; no process-local reference catalog is required for replay.
 */
export class DurableBlobDataReferenceStore implements DataReferenceStore {
  readonly durability = "durable" as const;
  private readonly backend: ImmutableDataReferenceBlobBackend;
  private readonly locate: DurableDataReferenceLocator;
  private readonly limits: ResolvedLimits;
  private readonly written = new Set<string>();
  private totalWrittenBytes = 0;

  constructor(options: DurableBlobDataReferenceStoreOptions) {
    this.backend = options.backend;
    this.locate = options.locate;
    this.limits = resolveLimits(options.limits ?? {});
  }

  async put(
    input: DataReferenceWrite,
    control: { readonly signal?: AbortSignal } = {},
  ): Promise<DataReference> {
    assertActive(control.signal);
    if (input.storage === "ephemeral") {
      throw new Error("Durable data reference stores cannot write ephemeral values");
    }
    const normalized = normalizeWrite(input);
    const encoded = encodeValue(normalized.value, normalized.mediaType);
    if (encoded.bytes.byteLength > this.limits.maxValueBytes) {
      throw new Error(`Data reference value exceeds maxValueBytes=${this.limits.maxValueBytes}`);
    }
    const contentHash = hashCanonical(encoded.value);
    const blobId = `blob_${hashCanonical({
      contentHash,
      mediaType: normalized.mediaType,
      byteLength: encoded.bytes.byteLength,
    }).slice(0, 40)}`;
    const location = this.locate({
      blobId,
      contentHash,
      mediaType: normalized.mediaType,
      byteLength: encoded.bytes.byteLength,
      ...(input.storage ? { requestedStorage: input.storage } : {}),
      ...(input.artifactId ? { requestedArtifactId: input.artifactId } : {}),
      ...(input.uri ? { requestedUri: input.uri } : {}),
    });
    if (
      (input.storage && input.storage !== location.storage)
      || (input.artifactId && (
        location.storage !== "artifact" || location.artifactId !== input.artifactId.trim()
      ))
      || (input.uri && (location.storage !== "object" || location.uri !== input.uri.trim()))
    ) {
      throw new Error("Durable data reference locator changed the requested storage identity");
    }
    const reference = createReference(normalized, encoded, location);
    validateReference(reference, {
      requireDurable: true,
      maxReferenceBytes: this.limits.maxReferenceBytes,
    });
    const isNewWrite = !this.written.has(reference.referenceId);
    if (isNewWrite && this.written.size >= this.limits.maxEntries) {
      throw new Error(`Data reference store exceeds maxEntries=${this.limits.maxEntries}`);
    }
    if (
      isNewWrite
      && this.totalWrittenBytes + encoded.bytes.byteLength > this.limits.maxTotalBytes
    ) {
      throw new Error(`Data reference store exceeds maxTotalBytes=${this.limits.maxTotalBytes}`);
    }
    await this.backend.putImmutable(reference, encoded.bytes.slice(), control);
    assertActive(control.signal);
    if (isNewWrite) {
      this.written.add(reference.referenceId);
      this.totalWrittenBytes += encoded.bytes.byteLength;
    }
    return cloneReference(reference);
  }

  async read(
    reference: DataReference,
    control: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonValue> {
    assertActive(control.signal);
    validateReference(reference, {
      requireDurable: true,
      maxReferenceBytes: this.limits.maxReferenceBytes,
    });
    const bytes = await this.backend.read(reference, control);
    assertActive(control.signal);
    if (!bytes) {
      throw new Error(`Data reference ${reference.referenceId} is unavailable`);
    }
    return cloneJson(validateBody(reference, bytes, this.limits.maxValueBytes));
  }
}
