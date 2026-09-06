import { hashCanonical } from "../../core/canonical.js";
import {
  createChildExecutionTrace,
  createRootExecutionTrace,
  executionTraceMetadata,
} from "../observability/trace.js";
import type {
  RosterCapabilityCatalogSearchResult,
  RosterFunctionAccess,
  RosterFunctionDirectory,
  RosterFunctionEffect,
} from "../functions/function-directory.js";
import type { JsonValue, WorkspaceNode } from "../orchestration/types.js";
import type {
  DataReference,
  ExecutionTraceContext,
} from "../platform/protocol.js";
import type { DataReferenceStore } from "./data-reference-store.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DEFAULT_MAX_STEPS = 16;
const DEFAULT_MAX_VALUE_BYTES = 16 * 1_048_576;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1_048_576;
const DEFAULT_MAX_REFERENCE_BYTES = 16_384;
const DEFAULT_MAX_WALL_TIME_MS = 120_000;
const DEFAULT_MAX_STEP_TIME_MS = 30_000;
const DEFAULT_MAX_PREVIEW_BYTES = 1_024;
const HARD_MAX_STEPS = 64;
const HARD_MAX_VALUE_BYTES = 64 * 1_048_576;
const HARD_MAX_TOTAL_BYTES = 512 * 1_048_576;
const HARD_MAX_REFERENCE_BYTES = 65_536;
const HARD_MAX_WALL_TIME_MS = 15 * 60_000;
const HARD_MAX_PREVIEW_BYTES = 16_384;

export const ROSTER_WORKER_PIPELINE_VERSION = "roster.worker-pipeline.v1" as const;

export type WorkerPipelineReferenceProjection = {
  readonly mediaType?: string;
  readonly storage?: DataReference["storage"];
  readonly artifactId?: string;
  readonly uri?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export type WorkerPipelineStep = {
  readonly stepId: string;
  readonly functionId: string;
  readonly functionVersion: string;
  readonly providerId: string;
  readonly providerEpoch: number;
  /**
   * Optional bounded template for the worker input. Exact
   * `{"$pipeline":"value"}` placeholders resolve to the previous opaque
   * value; `{"$pipeline":"pointer","pointer":"/path"}` selects one JSON
   * pointer. Without a template the previous value is passed directly.
   */
  readonly input?: JsonValue;
  /** A step may only narrow the caller's scopes and effects. */
  readonly access?: RosterFunctionAccess;
  readonly timeoutMs?: number;
  readonly output?: WorkerPipelineReferenceProjection;
};

export type WorkerPipelineFinalProjection = {
  /** RFC 6901 JSON pointer into the last worker output; blank selects all. */
  readonly pointer?: string;
  /** May only lower the executor/pipeline preview bound. */
  readonly maxPreviewBytes?: number;
  readonly output?: WorkerPipelineReferenceProjection;
};

export type WorkerPipelineDefinition = {
  readonly schemaVersion: typeof ROSTER_WORKER_PIPELINE_VERSION;
  readonly pipelineId: string;
  /** Pins function versions and live provider epochs before execution begins. */
  readonly catalogVersion: string;
  readonly initialReference: DataReference;
  readonly steps: ReadonlyArray<WorkerPipelineStep>;
  readonly limits?: WorkerPipelineLimits;
  readonly finalProjection?: WorkerPipelineFinalProjection;
};

export type WorkerPipelineLimits = {
  readonly maxSteps?: number;
  readonly maxValueBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxReferenceBytes?: number;
  readonly maxWallTimeMs?: number;
  readonly maxStepTimeMs?: number;
  readonly maxPreviewBytes?: number;
};

export type WorkerPipelineStepTrace = {
  readonly pipelineId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly catalogVersion: string;
  readonly functionId: string;
  readonly functionVersion: string;
  readonly providerId: string;
  readonly providerEpoch: number;
  readonly inputTemplateHash?: string;
  readonly execution: ExecutionTraceContext;
};

export type WorkerPipelineStepReceipt = {
  readonly receiptId: string;
  readonly trace: WorkerPipelineStepTrace;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly inputReference: DataReference;
  readonly outputReference: DataReference;
};

export type WorkerPipelinePreview = {
  readonly text: string;
  readonly byteLength: number;
  readonly sourceByteLength: number;
  readonly truncated: boolean;
};

export type WorkerPipelineResult = {
  readonly schemaVersion: typeof ROSTER_WORKER_PIPELINE_VERSION;
  readonly pipelineId: string;
  readonly catalogVersion: string;
  readonly finalReference: DataReference;
  readonly preview: WorkerPipelinePreview;
  readonly receipts: ReadonlyArray<WorkerPipelineStepReceipt>;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly transferredBytes: number;
};

export type WorkerPipelineExecutorOptions = {
  readonly directory: RosterFunctionDirectory;
  readonly store: DataReferenceStore;
  readonly limits?: WorkerPipelineLimits;
  readonly now?: () => number;
};

type ResolvedLimits = Required<WorkerPipelineLimits>;

type ValidatedStep = {
  readonly step: WorkerPipelineStep;
  readonly access: RosterFunctionAccess;
};

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

const resolveLimits = (limits: WorkerPipelineLimits = {}): ResolvedLimits => {
  const resolved = {
    maxSteps: boundedInteger(limits.maxSteps, DEFAULT_MAX_STEPS, HARD_MAX_STEPS, "Pipeline maxSteps"),
    maxValueBytes: boundedInteger(
      limits.maxValueBytes,
      DEFAULT_MAX_VALUE_BYTES,
      HARD_MAX_VALUE_BYTES,
      "Pipeline maxValueBytes",
    ),
    maxTotalBytes: boundedInteger(
      limits.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      HARD_MAX_TOTAL_BYTES,
      "Pipeline maxTotalBytes",
    ),
    maxReferenceBytes: boundedInteger(
      limits.maxReferenceBytes,
      DEFAULT_MAX_REFERENCE_BYTES,
      HARD_MAX_REFERENCE_BYTES,
      "Pipeline maxReferenceBytes",
    ),
    maxWallTimeMs: boundedInteger(
      limits.maxWallTimeMs,
      DEFAULT_MAX_WALL_TIME_MS,
      HARD_MAX_WALL_TIME_MS,
      "Pipeline maxWallTimeMs",
    ),
    maxStepTimeMs: boundedInteger(
      limits.maxStepTimeMs,
      DEFAULT_MAX_STEP_TIME_MS,
      HARD_MAX_WALL_TIME_MS,
      "Pipeline maxStepTimeMs",
    ),
    maxPreviewBytes: boundedInteger(
      limits.maxPreviewBytes,
      DEFAULT_MAX_PREVIEW_BYTES,
      HARD_MAX_PREVIEW_BYTES,
      "Pipeline maxPreviewBytes",
    ),
  };
  if (resolved.maxValueBytes > resolved.maxTotalBytes) {
    throw new Error("Pipeline maxValueBytes must not exceed maxTotalBytes");
  }
  if (resolved.maxStepTimeMs > resolved.maxWallTimeMs) {
    throw new Error("Pipeline maxStepTimeMs must not exceed maxWallTimeMs");
  }
  return resolved;
};

const restrictLimits = (
  base: ResolvedLimits,
  requested: WorkerPipelineLimits | undefined,
): ResolvedLimits => {
  if (!requested) return base;
  const candidate = resolveLimits({
    maxSteps: requested.maxSteps ?? base.maxSteps,
    maxValueBytes: requested.maxValueBytes ?? base.maxValueBytes,
    maxTotalBytes: requested.maxTotalBytes ?? base.maxTotalBytes,
    maxReferenceBytes: requested.maxReferenceBytes ?? base.maxReferenceBytes,
    maxWallTimeMs: requested.maxWallTimeMs ?? base.maxWallTimeMs,
    maxStepTimeMs: requested.maxStepTimeMs ?? base.maxStepTimeMs,
    maxPreviewBytes: requested.maxPreviewBytes ?? base.maxPreviewBytes,
  });
  for (const key of Object.keys(base) as ReadonlyArray<keyof ResolvedLimits>) {
    if (candidate[key] > base[key]) {
      throw new Error(`Pipeline ${key} may only lower the executor bound of ${base[key]}`);
    }
  }
  return candidate;
};

const normalizedAuthority = (access: RosterFunctionAccess): {
  readonly functionGrants: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<string>;
  readonly allowedEffects: ReadonlyArray<RosterFunctionEffect>;
} => ({
  functionGrants: [...new Set(access.functionGrants ?? [])].sort(),
  scopes: [...new Set(access.scopes ?? [])].sort(),
  allowedEffects: [...new Set<RosterFunctionEffect>(access.allowedEffects ?? ["read"])].sort(),
});

const intersectAuthority = (
  caller: RosterFunctionAccess,
  step: RosterFunctionAccess | undefined,
): RosterFunctionAccess => {
  const outer = normalizedAuthority(caller);
  if (!step) return outer;
  const innerGrants = step.functionGrants ? new Set(step.functionGrants) : undefined;
  const innerScopes = step.scopes ? new Set(step.scopes) : undefined;
  const innerEffects = step.allowedEffects ? new Set(step.allowedEffects) : undefined;
  return {
    functionGrants: innerGrants
      ? outer.functionGrants.filter((functionId) => innerGrants.has(functionId))
      : outer.functionGrants,
    scopes: innerScopes ? outer.scopes.filter((scope) => innerScopes.has(scope)) : outer.scopes,
    allowedEffects: innerEffects
      ? outer.allowedEffects.filter((effect) => innerEffects.has(effect))
      : outer.allowedEffects,
  };
};

const cloneReference = (reference: DataReference): DataReference => ({
  ...reference,
  ...(reference.metadata ? {
    metadata: JSON.parse(JSON.stringify(reference.metadata)) as Readonly<Record<string, JsonValue>>,
  } : {}),
});

const validateReferenceProjection = (
  projection: WorkerPipelineReferenceProjection | undefined,
  label: string,
  limits: ResolvedLimits,
): void => {
  if (!projection) return;
  if (projection.storage === "artifact" && !projection.artifactId?.trim()) {
    throw new Error(`${label} artifact storage requires artifactId`);
  }
  if (projection.storage === "object" && !projection.uri?.trim()) {
    throw new Error(`${label} object storage requires uri`);
  }
  if (
    (projection.mediaType?.length ?? 0) > 160
    || (projection.artifactId?.length ?? 0) > 500
    || (projection.uri?.length ?? 0) > 2_000
    || Buffer.byteLength(JSON.stringify(projection.metadata ?? {}), "utf8") > limits.maxReferenceBytes
  ) {
    throw new Error(`${label} reference metadata is too large`);
  }
};

const decodePointerToken = (token: string): string => {
  if (/~(?:[^01]|$)/u.test(token)) throw new Error("Pipeline final projection contains an invalid JSON pointer");
  return token.replace(/~1/gu, "/").replace(/~0/gu, "~");
};

const projectValue = (value: JsonValue, pointer: string | undefined): JsonValue => {
  if (!pointer) return value;
  if (!pointer.startsWith("/") || pointer.length > 1_000) {
    throw new Error("Pipeline final projection pointer must be a bounded RFC 6901 JSON pointer");
  }
  let current: JsonValue = value;
  for (const encodedToken of pointer.slice(1).split("/")) {
    const token = decodePointerToken(encodedToken);
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(token)) {
        throw new Error(`Pipeline final projection array token "${token}" is invalid`);
      }
      const next = current[Number(token)];
      if (next === undefined) throw new Error(`Pipeline final projection token "${token}" does not exist`);
      current = next;
      continue;
    }
    if (current && typeof current === "object") {
      const next = (current as Readonly<Record<string, JsonValue>>)[token];
      if (next === undefined) throw new Error(`Pipeline final projection token "${token}" does not exist`);
      current = next;
      continue;
    }
    throw new Error(`Pipeline final projection cannot traverse token "${token}"`);
  }
  return current;
};

const resolveStepInput = (
  template: JsonValue | undefined,
  value: JsonValue,
): JsonValue => {
  if (template === undefined) return value;
  let visited = 0;
  const resolve = (candidate: JsonValue, depth: number): JsonValue => {
    visited += 1;
    if (depth > 32 || visited > 4_096) {
      throw new Error("Pipeline step input template exceeds its structural bound");
    }
    if (Array.isArray(candidate)) return candidate.map((entry) => resolve(entry, depth + 1));
    if (!candidate || typeof candidate !== "object") return candidate;
    const record = candidate as Readonly<Record<string, JsonValue>>;
    if (record.$pipeline !== undefined) {
      if (record.$pipeline === "value" && Object.keys(record).length === 1) return value;
      if (
        record.$pipeline === "pointer"
        && typeof record.pointer === "string"
        && Object.keys(record).length === 2
      ) {
        return projectValue(value, record.pointer);
      }
      throw new Error("Pipeline step input contains an invalid $pipeline placeholder");
    }
    return Object.fromEntries(Object.entries(record)
      .map(([key, entry]) => [key, resolve(entry, depth + 1)]));
  };
  return resolve(template, 0);
};

const boundedPreview = (value: JsonValue, maxBytes: number): WorkerPipelinePreview => {
  const source = typeof value === "string" ? value : JSON.stringify(value);
  const sourceByteLength = Buffer.byteLength(source, "utf8");
  if (sourceByteLength <= maxBytes) {
    return {
      text: source,
      byteLength: sourceByteLength,
      sourceByteLength,
      truncated: false,
    };
  }
  let text = "";
  let byteLength = 0;
  for (const character of source) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteLength + characterBytes > maxBytes) break;
    text += character;
    byteLength += characterBytes;
  }
  return { text, byteLength, sourceByteLength, truncated: true };
};

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error("Worker pipeline was aborted");

/**
 * Executes a prevalidated worker chain over opaque DataReferences. Function
 * bodies are materialized only inside the trusted data plane; the caller sees
 * bounded trace receipts, a preview, and the final immutable reference.
 */
export class WorkerPipelineExecutor {
  private readonly directory: RosterFunctionDirectory;
  private readonly store: DataReferenceStore;
  private readonly limits: ResolvedLimits;
  private readonly now: () => number;

  constructor(options: WorkerPipelineExecutorOptions) {
    this.directory = options.directory;
    this.store = options.store;
    this.limits = resolveLimits(options.limits);
    this.now = options.now ?? Date.now;
  }

  async execute(input: {
    readonly node: WorkspaceNode;
    readonly access?: RosterFunctionAccess;
    readonly pipeline: WorkerPipelineDefinition;
    readonly catalogSnapshot: RosterCapabilityCatalogSearchResult;
    readonly trace?: ExecutionTraceContext;
    readonly signal?: AbortSignal;
  }): Promise<WorkerPipelineResult> {
    const startedAt = this.now();
    const access = normalizedAuthority(input.access ?? {});
    const limits = restrictLimits(this.limits, input.pipeline.limits);
    const steps = this.validatePipeline(
      input.node,
      access,
      input.pipeline,
      input.catalogSnapshot,
      limits,
      startedAt,
    );
    if (input.pipeline.initialReference.byteLength > limits.maxValueBytes) {
      throw new Error(`Pipeline initial reference exceeds maxValueBytes=${limits.maxValueBytes}`);
    }
    if (input.pipeline.initialReference.byteLength > limits.maxTotalBytes) {
      throw new Error(`Pipeline initial reference exceeds maxTotalBytes=${limits.maxTotalBytes}`);
    }
    if (
      Buffer.byteLength(JSON.stringify(input.pipeline.initialReference), "utf8")
      > limits.maxReferenceBytes
    ) {
      throw new Error(`Pipeline initial reference exceeds maxReferenceBytes=${limits.maxReferenceBytes}`);
    }

    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(
      input.signal?.reason instanceof Error ? input.signal.reason : new Error("Worker pipeline was aborted"),
    );
    if (input.signal?.aborted) abortFromCaller();
    else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`Worker pipeline timed out after ${limits.maxWallTimeMs}ms`)),
      limits.maxWallTimeMs,
    );

    let transferredBytes = input.pipeline.initialReference.byteLength;
    let currentReference = cloneReference(input.pipeline.initialReference);
    let executionTrace = input.trace ?? createRootExecutionTrace({
      kind: "worker-pipeline",
      pipelineId: input.pipeline.pipelineId,
      catalogVersion: input.pipeline.catalogVersion,
      initialContentHash: input.pipeline.initialReference.contentHash,
    });
    let finalValue: JsonValue | undefined;
    const receipts: WorkerPipelineStepReceipt[] = [];
    try {
      for (const [stepIndex, validated] of steps.entries()) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        const stepStartedAt = this.now();
        const elapsed = Math.max(0, stepStartedAt - startedAt);
        const remainingMs = limits.maxWallTimeMs - elapsed;
        if (remainingMs < 1) throw new Error(`Worker pipeline timed out after ${limits.maxWallTimeMs}ms`);
        const inputValue = await this.store.read(currentReference, { signal: controller.signal });
        const invocationInput = resolveStepInput(validated.step.input, inputValue);
        const invocationBytes = Buffer.byteLength(JSON.stringify(invocationInput), "utf8");
        if (invocationBytes > limits.maxValueBytes) {
          throw new Error(
            `Pipeline step ${validated.step.stepId} input exceeds maxValueBytes=${limits.maxValueBytes}`,
          );
        }
        transferredBytes += Math.max(0, invocationBytes - currentReference.byteLength);
        if (transferredBytes > limits.maxTotalBytes) {
          throw new Error(`Worker pipeline exceeds maxTotalBytes=${limits.maxTotalBytes}`);
        }
        const timeoutMs = Math.min(
          validated.step.timeoutMs ?? limits.maxStepTimeMs,
          limits.maxStepTimeMs,
          remainingMs,
        );
        const traceBase = {
          pipelineId: input.pipeline.pipelineId,
          stepId: validated.step.stepId,
          stepIndex,
          catalogVersion: input.pipeline.catalogVersion,
          inputReferenceId: currentReference.referenceId,
          inputContentHash: currentReference.contentHash,
        };
        executionTrace = createChildExecutionTrace(executionTrace, {
          pipelineId: input.pipeline.pipelineId,
          stepId: validated.step.stepId,
          stepIndex,
          functionId: validated.step.functionId,
          ...(validated.step.input
            ? { inputTemplateHash: hashCanonical(validated.step.input) }
            : {}),
        });
        const invocation = await this.directory.invokeWithTrace({
          node: input.node,
          functionId: validated.step.functionId,
          value: invocationInput,
          access: validated.access,
          timeoutMs,
          signal: controller.signal,
          expectedProvider: {
            providerId: validated.step.providerId,
            epoch: validated.step.providerEpoch,
          },
          now: this.now(),
          metadata: {
            ...traceBase,
            ...executionTraceMetadata(executionTrace),
          },
        });
        if (invocation.result.status !== "completed") {
          throw new Error(`Pipeline step ${validated.step.stepId} did not return a completed result`);
        }
        finalValue = invocation.result.output;
        const outputReference = await this.store.put({
          value: finalValue,
          mediaType: validated.step.output?.mediaType,
          storage: validated.step.output?.storage,
          producerFunctionId: invocation.trace.functionId,
          producerFunctionVersion: invocation.trace.functionVersion,
          artifactId: validated.step.output?.artifactId,
          uri: validated.step.output?.uri,
          metadata: validated.step.output?.metadata,
        }, { signal: controller.signal });
        if (outputReference.byteLength > limits.maxValueBytes) {
          throw new Error(
            `Pipeline step ${validated.step.stepId} output exceeds maxValueBytes=${limits.maxValueBytes}`,
          );
        }
        if (
          Buffer.byteLength(JSON.stringify(outputReference), "utf8")
          > limits.maxReferenceBytes
        ) {
          throw new Error(
            `Pipeline step ${validated.step.stepId} reference exceeds maxReferenceBytes=${limits.maxReferenceBytes}`,
          );
        }
        transferredBytes += outputReference.byteLength;
        if (transferredBytes > limits.maxTotalBytes) {
          throw new Error(`Worker pipeline exceeds maxTotalBytes=${limits.maxTotalBytes}`);
        }
        const completedAt = this.now();
        const trace: WorkerPipelineStepTrace = {
          pipelineId: input.pipeline.pipelineId,
          stepId: validated.step.stepId,
          stepIndex,
          catalogVersion: input.pipeline.catalogVersion,
          functionId: invocation.trace.functionId,
          functionVersion: invocation.trace.functionVersion,
          providerId: invocation.trace.providerId,
          providerEpoch: invocation.trace.providerEpoch,
          ...(validated.step.input
            ? { inputTemplateHash: hashCanonical(validated.step.input) }
            : {}),
          execution: executionTrace,
        };
        const receiptContent = {
          trace,
          startedAt: stepStartedAt,
          completedAt,
          inputReference: currentReference,
          outputReference,
        };
        receipts.push({
          receiptId: `pipeline_receipt_${hashCanonical(receiptContent).slice(0, 24)}`,
          trace,
          startedAt: stepStartedAt,
          completedAt,
          durationMs: Math.max(0, completedAt - stepStartedAt),
          inputReference: cloneReference(currentReference),
          outputReference: cloneReference(outputReference),
        });
        currentReference = outputReference;
      }
      if (finalValue === undefined) throw new Error("Worker pipeline produced no final value");
      const projectedValue = projectValue(finalValue, input.pipeline.finalProjection?.pointer);
      let finalReference = currentReference;
      if (input.pipeline.finalProjection?.pointer || input.pipeline.finalProjection?.output) {
        const lastTrace = receipts[receipts.length - 1]?.trace;
        finalReference = await this.store.put({
          value: projectedValue,
          mediaType: input.pipeline.finalProjection.output?.mediaType,
          storage: input.pipeline.finalProjection.output?.storage,
          producerFunctionId: lastTrace?.functionId,
          producerFunctionVersion: lastTrace?.functionVersion,
          artifactId: input.pipeline.finalProjection.output?.artifactId,
          uri: input.pipeline.finalProjection.output?.uri,
          metadata: input.pipeline.finalProjection.output?.metadata,
        }, { signal: controller.signal });
        if (finalReference.referenceId !== currentReference.referenceId) {
          transferredBytes += finalReference.byteLength;
        }
        if (finalReference.byteLength > limits.maxValueBytes || transferredBytes > limits.maxTotalBytes) {
          throw new Error("Worker pipeline final projection exceeds its byte limits");
        }
      }
      const completedAt = this.now();
      const previewBytes = Math.min(
        limits.maxPreviewBytes,
        input.pipeline.finalProjection?.maxPreviewBytes ?? limits.maxPreviewBytes,
      );
      return {
        schemaVersion: ROSTER_WORKER_PIPELINE_VERSION,
        pipelineId: input.pipeline.pipelineId,
        catalogVersion: input.pipeline.catalogVersion,
        finalReference: cloneReference(finalReference),
        preview: boundedPreview(projectedValue, previewBytes),
        receipts,
        startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - startedAt),
        transferredBytes,
      };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private validatePipeline(
    node: WorkspaceNode,
    callerAccess: RosterFunctionAccess,
    pipeline: WorkerPipelineDefinition,
    catalogSnapshot: RosterCapabilityCatalogSearchResult,
    limits: ResolvedLimits,
    now: number,
  ): ReadonlyArray<ValidatedStep> {
    if (pipeline.schemaVersion !== ROSTER_WORKER_PIPELINE_VERSION) {
      throw new Error("Unsupported worker pipeline schema version");
    }
    if (!ID_PATTERN.test(pipeline.pipelineId) || pipeline.pipelineId.length > 200) {
      throw new Error(`Invalid worker pipeline id "${pipeline.pipelineId}"`);
    }
    if (!pipeline.catalogVersion.trim() || pipeline.catalogVersion.length > 160) {
      throw new Error("Worker pipeline requires a bounded catalog version");
    }
    if (catalogSnapshot.catalogVersion !== pipeline.catalogVersion) {
      throw new Error("Worker pipeline catalog version is stale");
    }
    if (pipeline.steps.length < 1 || pipeline.steps.length > limits.maxSteps) {
      throw new Error(`Worker pipeline must contain between 1 and ${limits.maxSteps} steps`);
    }
    const stepIds = pipeline.steps.map((step) => step.stepId);
    if (new Set(stepIds).size !== stepIds.length) throw new Error("Worker pipeline step ids must be unique");
    for (const step of pipeline.steps) {
      if (!ID_PATTERN.test(step.stepId) || step.stepId.length > 200) {
        throw new Error(`Invalid worker pipeline step id "${step.stepId}"`);
      }
      if (!ID_PATTERN.test(step.functionId) || step.functionId.length > 240) {
        throw new Error(`Invalid worker pipeline function id "${step.functionId}"`);
      }
      if (!step.functionVersion.trim() || step.functionVersion.length > 120) {
        throw new Error(`Worker pipeline step ${step.stepId} requires a function version`);
      }
      if (!ID_PATTERN.test(step.providerId) || step.providerId.length > 240) {
        throw new Error(`Invalid worker pipeline provider id "${step.providerId}"`);
      }
      if (!Number.isSafeInteger(step.providerEpoch) || step.providerEpoch < 1) {
        throw new Error(`Worker pipeline step ${step.stepId} requires a positive provider epoch`);
      }
      if (
        step.input !== undefined
        && Buffer.byteLength(JSON.stringify(step.input), "utf8") > limits.maxReferenceBytes
      ) {
        throw new Error(
          `Worker pipeline step ${step.stepId} input template exceeds maxReferenceBytes=${limits.maxReferenceBytes}`,
        );
      }
      validateReferenceProjection(step.output, `Worker pipeline step ${step.stepId} output`, limits);
      if (
        step.timeoutMs !== undefined
        && (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > limits.maxStepTimeMs)
      ) {
        throw new Error(
          `Worker pipeline step ${step.stepId} timeoutMs must be between 1 and ${limits.maxStepTimeMs}`,
        );
      }
    }
    const finalProjection = pipeline.finalProjection;
    if (
      finalProjection?.pointer !== undefined
      && (finalProjection.pointer.length > 1_000
        || (finalProjection.pointer !== "" && !finalProjection.pointer.startsWith("/")))
    ) {
      throw new Error("Worker pipeline final projection pointer must be a bounded RFC 6901 JSON pointer");
    }
    if (
      finalProjection?.maxPreviewBytes !== undefined
      && (
        !Number.isSafeInteger(finalProjection.maxPreviewBytes)
        || finalProjection.maxPreviewBytes < 1
        || finalProjection.maxPreviewBytes > limits.maxPreviewBytes
      )
    ) {
      throw new Error(`Worker pipeline final preview must be between 1 and ${limits.maxPreviewBytes} bytes`);
    }
    validateReferenceProjection(finalProjection?.output, "Worker pipeline final output", limits);
    return pipeline.steps.map((step): ValidatedStep => {
      const pinnedEntry = catalogSnapshot.entries.find((entry) =>
        entry.id === step.functionId
        && entry.version === step.functionVersion
        && entry.providers.some((provider) =>
          provider.providerId === step.providerId && provider.epoch === step.providerEpoch));
      if (!pinnedEntry) {
        throw new Error(
          `Worker pipeline step ${step.stepId} was not present in the pinned catalog snapshot`,
        );
      }
      const access = intersectAuthority(callerAccess, step.access);
      const stepProjection = this.directory.projectCatalog({
        node,
        access,
        functionIds: [step.functionId],
        now,
      });
      const provider = stepProjection.providers[step.functionId];
      if (!provider) throw new Error(`Worker pipeline step ${step.stepId} has no authorized live provider`);
      if (
        provider.providerId !== step.providerId
        || provider.epoch !== step.providerEpoch
      ) {
        throw new Error(`Worker pipeline step ${step.stepId} provider projection changed`);
      }
      return { step, access };
    });
  }
}
