import { hashCanonical } from "../../core/canonical.js";
import type { JsonValue } from "../orchestration/types.js";
import type { ExecutionTraceContext } from "../platform/protocol.js";

const TRACE_ID = /^[0-9a-f]{32}$/u;
const SPAN_ID = /^[0-9a-f]{16}$/u;
const TRACE_FLAGS = /^[0-9a-f]{2}$/u;

export const validateExecutionTraceContext = (
  context: ExecutionTraceContext,
): ExecutionTraceContext => {
  if (!TRACE_ID.test(context.traceId) || /^0+$/u.test(context.traceId)) {
    throw new Error("Execution traceId must be 32 non-zero lowercase hexadecimal characters");
  }
  if (!SPAN_ID.test(context.spanId) || /^0+$/u.test(context.spanId)) {
    throw new Error("Execution spanId must be 16 non-zero lowercase hexadecimal characters");
  }
  if (
    context.parentSpanId !== undefined
    && (!SPAN_ID.test(context.parentSpanId) || /^0+$/u.test(context.parentSpanId))
  ) {
    throw new Error("Execution parentSpanId must be 16 non-zero lowercase hexadecimal characters");
  }
  const traceFlags = context.traceFlags ?? "01";
  if (!TRACE_FLAGS.test(traceFlags)) {
    throw new Error("Execution traceFlags must be two lowercase hexadecimal characters");
  }
  const baggage = Object.fromEntries(Object.entries(context.baggage ?? {})
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter(([key, value]) => key && value)
    .sort(([left], [right]) => left.localeCompare(right)));
  if (Object.keys(baggage).length > 32) throw new Error("Execution trace baggage supports at most 32 entries");
  for (const [key, value] of Object.entries(baggage)) {
    if (key.length > 128 || value.length > 512) {
      throw new Error("Execution trace baggage exceeds its bounded key or value length");
    }
  }
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
    traceFlags,
    ...(Object.keys(baggage).length ? { baggage } : {}),
  };
};

export const createRootExecutionTrace = (
  seed: Readonly<Record<string, JsonValue>>,
): ExecutionTraceContext => validateExecutionTraceContext({
  traceId: hashCanonical({ kind: "trace", seed }).slice(0, 32),
  spanId: hashCanonical({ kind: "root-span", seed }).slice(0, 16),
  traceFlags: "01",
});

export const createChildExecutionTrace = (
  parent: ExecutionTraceContext,
  seed: Readonly<Record<string, JsonValue>>,
): ExecutionTraceContext => {
  const normalized = validateExecutionTraceContext(parent);
  return validateExecutionTraceContext({
    traceId: normalized.traceId,
    parentSpanId: normalized.spanId,
    spanId: hashCanonical({
      kind: "child-span",
      traceId: normalized.traceId,
      parentSpanId: normalized.spanId,
      seed,
    }).slice(0, 16),
    traceFlags: normalized.traceFlags,
    ...(normalized.baggage ? { baggage: normalized.baggage } : {}),
  });
};

export const executionTraceparent = (
  context: ExecutionTraceContext,
): string => {
  const normalized = validateExecutionTraceContext(context);
  return `00-${normalized.traceId}-${normalized.spanId}-${normalized.traceFlags ?? "01"}`;
};

export const executionTraceMetadata = (
  context: ExecutionTraceContext,
): Readonly<Record<string, JsonValue>> => {
  const normalized = validateExecutionTraceContext(context);
  return {
    traceparent: executionTraceparent(normalized),
    trace_id: normalized.traceId,
    span_id: normalized.spanId,
    ...(normalized.parentSpanId ? { parent_span_id: normalized.parentSpanId } : {}),
    ...(normalized.baggage ? { baggage: normalized.baggage } : {}),
  };
};
