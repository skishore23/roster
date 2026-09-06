import assert from "node:assert/strict";
import test from "node:test";

import {
  createChildExecutionTrace,
  createRootExecutionTrace,
  executionTraceMetadata,
  executionTraceparent,
} from "../../src/engine/observability/trace.ts";

test("platform trace context is deterministic, hierarchical, and W3C-compatible", () => {
  const root = createRootExecutionTrace({ runId: "run-1", taskId: "task-1" });
  const replay = createRootExecutionTrace({ runId: "run-1", taskId: "task-1" });
  const child = createChildExecutionTrace(root, {
    functionId: "web::fetch",
    invocation: 1,
  });

  assert.deepEqual(root, replay);
  assert.equal(child.traceId, root.traceId);
  assert.equal(child.parentSpanId, root.spanId);
  assert.notEqual(child.spanId, root.spanId);
  assert.match(executionTraceparent(child), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u);
  assert.deepEqual(executionTraceMetadata(child), {
    traceparent: executionTraceparent(child),
    trace_id: child.traceId,
    span_id: child.spanId,
    parent_span_id: root.spanId,
  });
});
