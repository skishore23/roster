import assert from "node:assert/strict";
import test from "node:test";

import {
  RosterFunctionDirectory,
  type RosterFunctionDescriptor,
} from "../../src/engine/functions/function-directory.ts";
import {
  InMemoryDataReferenceStore,
} from "../../src/engine/dataflow/data-reference-store.ts";
import {
  ROSTER_WORKER_PIPELINE_VERSION,
  WorkerPipelineExecutor,
  type WorkerPipelineDefinition,
} from "../../src/engine/dataflow/worker-pipeline.ts";
import {
  ROSTER_CATALOG_INVOKE_FUNCTION_ID,
  ROSTER_CATALOG_SEARCH_FUNCTION_ID,
  createRosterFunctionExecutionPlane,
} from "../../src/engine/runtime/node-function-plane.ts";

const EXTRACT: RosterFunctionDescriptor = {
  id: "document::extract",
  version: "1",
  capability: "document",
  description: "Extract a bounded fact set from an opaque document.",
  inputSchema: { type: "string", minLength: 1 },
  outputSchema: {
    type: "object",
    required: ["occurrences", "sample"],
    additionalProperties: false,
    properties: {
      occurrences: { type: "integer", minimum: 0 },
      sample: { type: "string" },
    },
  },
  effects: ["read"],
};

const SUMMARIZE: RosterFunctionDescriptor = {
  id: "document::summarize",
  version: "1",
  capability: "document",
  description: "Summarize an extracted fact set.",
  inputSchema: {
    type: "object",
    required: ["occurrences", "sample"],
    additionalProperties: false,
    properties: {
      occurrences: { type: "integer", minimum: 0 },
      sample: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["summary", "details"],
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      details: { type: "string" },
    },
  },
  effects: ["read"],
};

const PUBLISH: RosterFunctionDescriptor = {
  id: "document::publish",
  version: "1",
  capability: "document",
  description: "Publish a document summary to an external destination.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  effects: ["write", "external"],
  requiredScopes: ["document:publish"],
};

const SLOW: RosterFunctionDescriptor = {
  id: "document::slow",
  version: "1",
  capability: "document",
  description: "Exercise a bounded worker timeout.",
  inputSchema: { type: "string" },
  outputSchema: { type: "string" },
  effects: ["read"],
};

const NODE = {
  id: "document-worker",
  name: "Document Worker",
  capabilities: ["document"],
  runtime: { kind: "roster-native" as const },
};

test("worker pipeline keeps an ~8k document opaque and returns only references plus a bounded preview", async () => {
  const store = new InMemoryDataReferenceStore({
    maxEntries: 16,
    maxValueBytes: 16_000,
    maxTotalBytes: 32_000,
  });
  const directory = new RosterFunctionDirectory([EXTRACT, SUMMARIZE]);
  const seenInputBytes: number[] = [];
  const traceMetadata: Array<Readonly<Record<string, unknown>>> = [];
  directory.bindProvider({
    providerId: "extract-worker",
    functionId: EXTRACT.id,
    epoch: 3,
    heartbeat: { observedAt: 100, ttlMs: 1_000 },
    invoke: async (value, control) => {
      assert.equal(typeof value, "string");
      const document = String(value);
      seenInputBytes.push(Buffer.byteLength(document, "utf8"));
      traceMetadata.push(control.metadata ?? {});
      return {
        occurrences: document.split("PRIVATE_BODY").length - 1,
        sample: document.slice(0, 48),
      };
    },
  });
  directory.bindProvider({
    providerId: "summary-worker",
    functionId: SUMMARIZE.id,
    epoch: 7,
    heartbeat: { observedAt: 100, ttlMs: 1_000 },
    invoke: async (value, control) => {
      assert.equal(typeof value, "object");
      seenInputBytes.push(Buffer.byteLength(JSON.stringify(value), "utf8"));
      traceMetadata.push(control.metadata ?? {});
      const facts = value as { readonly occurrences: number; readonly sample: string };
      return {
        summary: `Found ${facts.occurrences} marked sections.`,
        details: `Bounded extraction from sample ${facts.sample}. ${"verified ".repeat(30)}`,
      };
    },
  });

  const document = `${"PRIVATE_BODY section with confidential detail.\n".repeat(190)}END-OF-OPAQUE-DOCUMENT`;
  assert.ok(Buffer.byteLength(document, "utf8") > 8_000);
  const initialReference = await store.put({
    value: document,
    mediaType: "text/plain",
  });
  const access = { functionGrants: [EXTRACT.id, SUMMARIZE.id] };
  const snapshot = directory.searchCatalog({
    node: NODE,
    access,
    query: "document",
    limit: 8,
    now: 110,
  });
  const extractProvider = snapshot.entries.find((entry) => entry.id === EXTRACT.id)?.providers[0];
  const summarizeProvider = snapshot.entries.find((entry) => entry.id === SUMMARIZE.id)?.providers[0];
  assert.ok(extractProvider);
  assert.ok(summarizeProvider);
  const pipeline: WorkerPipelineDefinition = {
    schemaVersion: ROSTER_WORKER_PIPELINE_VERSION,
    pipelineId: "document-extraction",
    catalogVersion: snapshot.catalogVersion,
    initialReference,
    steps: [
      {
        stepId: "extract",
        functionId: EXTRACT.id,
        functionVersion: EXTRACT.version,
        providerId: extractProvider.providerId,
        providerEpoch: extractProvider.epoch,
      },
      {
        stepId: "summarize",
        functionId: SUMMARIZE.id,
        functionVersion: SUMMARIZE.version,
        providerId: summarizeProvider.providerId,
        providerEpoch: summarizeProvider.epoch,
      },
    ],
    finalProjection: {
      pointer: "/summary",
      maxPreviewBytes: 32,
      output: {
          storage: "artifact",
          artifactId: "artifact-document-summary",
          mediaType: "text/plain",
      },
    },
  };
  const executor = new WorkerPipelineExecutor({
    directory,
    store,
    limits: {
      maxSteps: 4,
      maxValueBytes: 16_000,
      maxTotalBytes: 32_000,
      maxPreviewBytes: 96,
      maxWallTimeMs: 5_000,
      maxStepTimeMs: 1_000,
    },
    now: () => 110,
  });
  const result = await executor.execute({
    node: NODE,
    access,
    pipeline,
    catalogSnapshot: snapshot,
  });

  assert.equal(seenInputBytes[0], Buffer.byteLength(document, "utf8"));
  assert.ok((seenInputBytes[1] ?? Number.MAX_SAFE_INTEGER) < 256);
  assert.equal(result.receipts.length, 2);
  assert.equal(result.receipts[0]?.trace.providerEpoch, 3);
  assert.equal(result.receipts[1]?.trace.providerEpoch, 7);
  assert.equal(result.receipts[1]?.inputReference.referenceId, result.receipts[0]?.outputReference.referenceId);
  assert.equal(result.finalReference.storage, "artifact");
  assert.equal(result.finalReference.artifactId, "artifact-document-summary");
  assert.ok(result.preview.byteLength <= 32);
  assert.equal(result.preview.truncated, false);
  assert.equal(traceMetadata[0]?.pipelineId, "document-extraction");
  assert.equal(traceMetadata[0]?.inputReferenceId, initialReference.referenceId);
  assert.equal(typeof traceMetadata[0]?.traceparent, "string");
  assert.equal(result.receipts[1]?.trace.execution.traceId, result.receipts[0]?.trace.execution.traceId);
  assert.equal(
    result.receipts[1]?.trace.execution.parentSpanId,
    result.receipts[0]?.trace.execution.spanId,
  );
  assert.equal("value" in (traceMetadata[0] ?? {}), false);

  const serializedResult = JSON.stringify(result);
  assert.ok(Buffer.byteLength(serializedResult, "utf8") < 5_000);
  assert.doesNotMatch(serializedResult, /END-OF-OPAQUE-DOCUMENT/);
  assert.doesNotMatch(serializedResult, /PRIVATE_BODY section with confidential detail\\nPRIVATE_BODY/);
  assert.equal(await store.read(result.finalReference), "Found 190 marked sections.");
});

test("RLM catalog plane describes one pinned function then executes an opaque 8KB pipeline", async () => {
  const store = new InMemoryDataReferenceStore({
    maxEntries: 16,
    maxValueBytes: 20_000,
    maxTotalBytes: 48_000,
  });
  const directory = new RosterFunctionDirectory([EXTRACT, SUMMARIZE]);
  directory.bindProvider({
    providerId: "agent-extract-worker",
    functionId: EXTRACT.id,
    epoch: 2,
    invoke: async (value) => {
      const body = String(value);
      return {
        occurrences: body.split("PRIVATE_BODY").length - 1,
        sample: body.slice(0, 48),
      };
    },
  });
  directory.bindProvider({
    providerId: "agent-summary-worker",
    functionId: SUMMARIZE.id,
    epoch: 4,
    invoke: async (value) => {
      const facts = value as { readonly occurrences: number; readonly sample: string };
      return {
        summary: `Found ${facts.occurrences} marked sections.`,
        details: `Processed ${facts.sample}`,
      };
    },
  });
  const body = `${"PRIVATE_BODY confidential agent payload.\n".repeat(220)}END-OF-AGENT-PAYLOAD`;
  assert.ok(Buffer.byteLength(body, "utf8") > 8_000);
  const plane = createRosterFunctionExecutionPlane({
    directory,
    access: () => ({
      functionGrants: [EXTRACT.id, SUMMARIZE.id],
      allowedEffects: ["read"],
    }),
    pipeline: {
      store,
      limits: {
        maxSteps: 4,
        maxValueBytes: 20_000,
        maxTotalBytes: 48_000,
        maxPreviewBytes: 64,
      },
      now: () => 110,
    },
  });
  const task = {
    taskId: "agent-document-task",
    nodeId: NODE.id,
    capability: "document",
  };
  assert.deepEqual(
    plane.functionTools(NODE, task).map((tool) => tool.id),
    [
      ROSTER_CATALOG_SEARCH_FUNCTION_ID,
      ROSTER_CATALOG_INVOKE_FUNCTION_ID,
    ],
  );
  const invoke = plane.functionInvoker(NODE, task);
  const control = {
    executionId: "agent-execution",
    runId: "agent-run",
    nodeId: NODE.id,
    taskId: task.taskId,
  };
  const searchResult = await invoke({
    functionId: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
    value: { query: "document", limit: 8 },
  }, control);
  assert.equal(searchResult.status, "completed");
  if (searchResult.status !== "completed") throw new Error("Expected completed catalog search");
  const snapshot = searchResult.output as {
    readonly catalogVersion: string;
    readonly entries: ReadonlyArray<{
      readonly id: string;
      readonly version: string;
      readonly providers: ReadonlyArray<{ readonly providerId: string; readonly epoch: number }>;
    }>;
  };
  const extractEntry = snapshot.entries.find((entry) => entry.id === EXTRACT.id);
  const summarizeEntry = snapshot.entries.find((entry) => entry.id === SUMMARIZE.id);
  const extractProvider = extractEntry?.providers[0];
  const summarizeProvider = summarizeEntry?.providers[0];
  assert.ok(extractEntry);
  assert.ok(summarizeEntry);
  assert.ok(extractProvider);
  assert.ok(summarizeProvider);

  const descriptionResult = await invoke({
    functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
    value: {
      operation: "describe",
      catalogVersion: snapshot.catalogVersion,
      functionId: extractEntry.id,
      functionVersion: extractEntry.version,
      providerId: extractProvider.providerId,
      providerEpoch: extractProvider.epoch,
    },
  }, control);
  assert.equal(descriptionResult.status, "completed");
  if (descriptionResult.status !== "completed") throw new Error("Expected completed catalog description");
  const description = descriptionResult.output as {
    readonly searchCatalogVersion: string;
    readonly tool: { readonly id: string; readonly inputSchema: unknown };
    readonly provider: { readonly providerId: string; readonly epoch: number };
  };
  assert.equal(description.searchCatalogVersion, snapshot.catalogVersion);
  assert.equal(description.tool.id, EXTRACT.id);
  assert.deepEqual(description.tool.inputSchema, EXTRACT.inputSchema);
  assert.deepEqual(description.provider, extractProvider);

  await assert.rejects(() => invoke({
    functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
    value: {
      operation: "call",
      catalogVersion: snapshot.catalogVersion,
      functionId: extractEntry.id,
      functionVersion: extractEntry.version,
      providerId: extractProvider.providerId,
      providerEpoch: extractProvider.epoch,
      value: "deferred input",
      action: "enqueue",
    },
  }, control), /action must be await or void/);

  const pipelineResult = await invoke({
    functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
    value: {
      operation: "pipeline",
      pipelineId: "agent-document-pipeline",
      catalogVersion: snapshot.catalogVersion,
      initialValue: { document: body },
      steps: [{
        stepId: "extract",
        functionId: extractEntry.id,
        functionVersion: extractEntry.version,
        providerId: extractProvider.providerId,
        providerEpoch: extractProvider.epoch,
        input: { $pipeline: "pointer", pointer: "/document" },
      }, {
        stepId: "summarize",
        functionId: summarizeEntry.id,
        functionVersion: summarizeEntry.version,
        providerId: summarizeProvider.providerId,
        providerEpoch: summarizeProvider.epoch,
      }],
      limits: { maxSteps: 2, maxPreviewBytes: 40 },
      finalProjection: {
        pointer: "/summary",
        maxPreviewBytes: 40,
        output: {
          storage: "artifact",
          artifactId: "agent-summary-artifact",
          mediaType: "text/plain",
        },
      },
    },
  }, control);
  assert.equal(pipelineResult.status, "completed");
  if (pipelineResult.status !== "completed") throw new Error("Expected completed pipeline");
  const output = pipelineResult.output as {
    readonly finalReference: Parameters<InMemoryDataReferenceStore["read"]>[0];
    readonly preview: { readonly text: string; readonly byteLength: number };
    readonly receipts: ReadonlyArray<unknown>;
  };
  assert.equal(output.preview.text, "Found 220 marked sections.");
  assert.ok(output.preview.byteLength <= 40);
  assert.equal(output.receipts.length, 2);
  assert.equal(await store.read(output.finalReference), "Found 220 marked sections.");
  const serialized = JSON.stringify(pipelineResult);
  assert.doesNotMatch(serialized, /END-OF-AGENT-PAYLOAD/);
  assert.ok(Buffer.byteLength(serialized, "utf8") < 5_000);

  const differentTaskInvoker = plane.functionInvoker(NODE, {
    ...task,
    taskId: "different-task",
  });
  await assert.rejects(() => differentTaskInvoker({
    functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
    value: {
      operation: "describe",
      catalogVersion: snapshot.catalogVersion,
      functionId: extractEntry.id,
      functionVersion: extractEntry.version,
      providerId: extractProvider.providerId,
      providerEpoch: extractProvider.epoch,
    },
  }, {
    ...control,
    taskId: "different-task",
  }), /not present in this task's search snapshot/);
});

test("RLM catalog prompt size is independent of the live swarm catalog", async () => {
  const descriptors = Array.from({ length: 96 }, (_, index): RosterFunctionDescriptor => ({
    id: `swarm::worker-${String(index).padStart(3, "0")}`,
    version: "1",
    capability: "swarm",
    description: `Specialized swarm worker ${index} with a deliberately distinct live capability.`,
    inputSchema: {
      type: "object",
      required: [`workerSpecificInput${index}`],
      properties: {
        [`workerSpecificInput${index}`]: { type: "string" },
      },
    },
    outputSchema: true,
    effects: ["read"],
  }));
  const directory = new RosterFunctionDirectory(descriptors);
  for (const descriptor of descriptors) {
    directory.bindProvider({
      providerId: `provider-${descriptor.id}`,
      functionId: descriptor.id,
      epoch: 1,
      invoke: async (value) => value,
    });
  }
  const plane = createRosterFunctionExecutionPlane({
    directory,
    access: () => ({
      functionGrants: descriptors.map((descriptor) => descriptor.id),
      allowedEffects: ["read"],
    }),
  });
  const task = {
    taskId: "bounded-catalog-task",
    nodeId: NODE.id,
    capability: "document",
  };
  const tools = plane.functionTools(NODE, task);
  assert.deepEqual(
    tools.map((tool) => tool.id),
    [ROSTER_CATALOG_SEARCH_FUNCTION_ID, ROSTER_CATALOG_INVOKE_FUNCTION_ID],
  );
  const serializedTools = JSON.stringify(tools);
  assert.ok(Buffer.byteLength(serializedTools, "utf8") < 4_000);
  assert.doesNotMatch(serializedTools, /swarm::worker-/);
  assert.doesNotMatch(serializedTools, /workerSpecificInput/);

  const result = await plane.functionInvoker(NODE, task)({
    functionId: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
    value: { capabilities: ["swarm"], limit: 3 },
  }, {
    executionId: "bounded-catalog-execution",
    runId: "bounded-catalog-run",
    nodeId: NODE.id,
    taskId: task.taskId,
  });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") throw new Error("Expected completed catalog search");
  const snapshot = result.output as {
    readonly entries: ReadonlyArray<{ readonly id: string }>;
  };
  assert.equal(snapshot.entries.length, 3);
  const serializedSnapshot = JSON.stringify(snapshot);
  assert.ok(Buffer.byteLength(serializedSnapshot, "utf8") < 4_000);
  assert.doesNotMatch(serializedSnapshot, /workerSpecificInput/);
});

test("pipeline validates every step and intersects step authority before invoking any worker", async () => {
  let calls = 0;
  const store = new InMemoryDataReferenceStore();
  const directory = new RosterFunctionDirectory([EXTRACT, PUBLISH]);
  for (const descriptor of [EXTRACT, PUBLISH]) {
    directory.bindProvider({
      providerId: `${descriptor.id}-worker`,
      functionId: descriptor.id,
      epoch: 1,
      heartbeat: { observedAt: 100, ttlMs: 1_000 },
      invoke: async () => {
        calls += 1;
        return {};
      },
    });
  }
  const callerAccess = {
    functionGrants: [EXTRACT.id, PUBLISH.id],
    scopes: ["document:publish"],
    allowedEffects: ["read", "write", "external"] as const,
  };
  const snapshot = directory.searchCatalog({
    node: NODE,
    access: callerAccess,
    query: "document",
    limit: 8,
    now: 110,
  });
  const extractProvider = snapshot.entries.find((entry) => entry.id === EXTRACT.id)?.providers[0];
  const publishProvider = snapshot.entries.find((entry) => entry.id === PUBLISH.id)?.providers[0];
  assert.ok(extractProvider);
  assert.ok(publishProvider);
  const initialReference = await store.put({ value: "bounded" });
  const executor = new WorkerPipelineExecutor({
    directory,
    store,
    now: () => 110,
  });
  await assert.rejects(() => executor.execute({
    node: NODE,
    access: callerAccess,
    pipeline: {
      schemaVersion: ROSTER_WORKER_PIPELINE_VERSION,
      pipelineId: "authority-intersection",
      catalogVersion: snapshot.catalogVersion,
      initialReference,
      steps: [
        {
          stepId: "extract",
          functionId: EXTRACT.id,
          functionVersion: EXTRACT.version,
          providerId: extractProvider.providerId,
          providerEpoch: extractProvider.epoch,
        },
        {
          stepId: "publish",
          functionId: PUBLISH.id,
          functionVersion: PUBLISH.version,
          providerId: publishProvider.providerId,
          providerEpoch: publishProvider.epoch,
          access: {
            scopes: ["document:publish"],
            allowedEffects: ["read"],
          },
        },
      ],
    },
    catalogSnapshot: snapshot,
  }), /not available in the authorized capability catalog/);
  assert.equal(calls, 0);
});

test("pipeline rejects stale catalog and later-step version errors before executing the first step", async () => {
  let calls = 0;
  const store = new InMemoryDataReferenceStore();
  const directory = new RosterFunctionDirectory([EXTRACT, SUMMARIZE]);
  for (const descriptor of [EXTRACT, SUMMARIZE]) {
    directory.bindProvider({
      providerId: `${descriptor.id}-worker`,
      functionId: descriptor.id,
      epoch: 1,
      heartbeat: { observedAt: 100, ttlMs: 1_000 },
      invoke: async () => {
        calls += 1;
        return {};
      },
    });
  }
  const access = { functionGrants: [EXTRACT.id, SUMMARIZE.id] };
  const snapshot = directory.searchCatalog({
    node: NODE,
    access,
    query: "document",
    limit: 8,
    now: 110,
  });
  const extractProvider = snapshot.entries.find((entry) => entry.id === EXTRACT.id)?.providers[0];
  const summarizeProvider = snapshot.entries.find((entry) => entry.id === SUMMARIZE.id)?.providers[0];
  assert.ok(extractProvider);
  assert.ok(summarizeProvider);
  const initialReference = await store.put({ value: "bounded" });
  const executor = new WorkerPipelineExecutor({ directory, store, now: () => 110 });
  const base = {
    schemaVersion: ROSTER_WORKER_PIPELINE_VERSION,
    pipelineId: "prevalidation",
    initialReference,
    steps: [
      {
        stepId: "extract",
        functionId: EXTRACT.id,
        functionVersion: EXTRACT.version,
        providerId: extractProvider.providerId,
        providerEpoch: extractProvider.epoch,
      },
      {
        stepId: "summarize",
        functionId: SUMMARIZE.id,
        functionVersion: "2",
        providerId: summarizeProvider.providerId,
        providerEpoch: summarizeProvider.epoch,
      },
    ],
  } as const;

  await assert.rejects(() => executor.execute({
    node: NODE,
    access,
    pipeline: { ...base, catalogVersion: "stale-catalog" },
    catalogSnapshot: snapshot,
  }), /catalog version is stale/);
  await assert.rejects(() => executor.execute({
    node: NODE,
    access,
    pipeline: { ...base, catalogVersion: snapshot.catalogVersion },
    catalogSnapshot: snapshot,
  }), /was not present in the pinned catalog snapshot/);
  assert.equal(calls, 0);
});

test("pipeline enforces step, byte, and time bounds", async () => {
  let calls = 0;
  const store = new InMemoryDataReferenceStore();
  const directory = new RosterFunctionDirectory([SLOW]);
  directory.bindProvider({
    providerId: "slow-worker",
    functionId: SLOW.id,
    epoch: 1,
    heartbeat: { observedAt: 100, ttlMs: 1_000 },
    invoke: async (_value, control) => {
      calls += 1;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve("late"), 1_000);
        control.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(control.signal.reason);
        }, { once: true });
      });
    },
  });
  const access = { functionGrants: [SLOW.id] };
  const snapshot = directory.searchCatalog({
    node: NODE,
    access,
    query: "document",
    now: 110,
  });
  const largeReference = await store.put({ value: "x".repeat(2_000) });
  const provider = snapshot.entries[0]?.providers[0];
  assert.ok(provider);
  const step = {
    stepId: "slow",
    functionId: SLOW.id,
    functionVersion: SLOW.version,
    providerId: provider.providerId,
    providerEpoch: provider.epoch,
  } as const;

  const byteBounded = new WorkerPipelineExecutor({
    directory,
    store,
    limits: { maxValueBytes: 1_000 },
    now: () => 110,
  });
  await assert.rejects(() => byteBounded.execute({
    node: NODE,
    access,
    pipeline: {
      schemaVersion: ROSTER_WORKER_PIPELINE_VERSION,
      pipelineId: "byte-bound",
      catalogVersion: snapshot.catalogVersion,
      initialReference: largeReference,
      steps: [step],
    },
    catalogSnapshot: snapshot,
  }), /initial reference exceeds maxValueBytes=1000/);
  assert.equal(calls, 0);

  const smallReference = await store.put({ value: "small" });
  const stepBounded = new WorkerPipelineExecutor({
    directory,
    store,
    limits: { maxSteps: 1 },
    now: () => 110,
  });
  await assert.rejects(() => stepBounded.execute({
    node: NODE,
    access,
    pipeline: {
      schemaVersion: ROSTER_WORKER_PIPELINE_VERSION,
      pipelineId: "step-bound",
      catalogVersion: snapshot.catalogVersion,
      initialReference: smallReference,
      steps: [step, { ...step, stepId: "slow-again" }],
    },
    catalogSnapshot: snapshot,
  }), /between 1 and 1 steps/);
  assert.equal(calls, 0);

  const timeBounded = new WorkerPipelineExecutor({
    directory,
    store,
    limits: {
      maxStepTimeMs: 10,
      maxWallTimeMs: 100,
    },
    now: () => 110,
  });
  await assert.rejects(() => timeBounded.execute({
    node: NODE,
    access,
    pipeline: {
      schemaVersion: ROSTER_WORKER_PIPELINE_VERSION,
      pipelineId: "time-bound",
      catalogVersion: snapshot.catalogVersion,
      initialReference: smallReference,
      steps: [step],
    },
    catalogSnapshot: snapshot,
  }), /timed out after 10ms/);
  assert.equal(calls, 1);
});
