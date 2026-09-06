import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";

import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { createSpacetimeCanvasRuntime } from "../adapters/spacetimedb-canvas-runtime.js";
import { SpacetimeControlPlane } from "../adapters/spacetimedb-control.js";
import {
  spacetimeRosterExecutionPolicy,
  SpacetimeTaskGraphControl,
} from "../adapters/spacetimedb-task-graph-control.js";
import { SpacetimeWebAccess } from "../adapters/spacetimedb-web-access.js";
import { hashCanonical } from "../core/canonical.js";
import { createFileSystemDataReferenceStore } from "../engine/dataflow/filesystem-data-reference-store.js";
import {
  createAcceptedTaskOutcome,
  createDynamicTaskDefinition,
} from "../engine/orchestration/task-graph.js";
import {
  ROSTER_DATA_REFERENCE_VERSION,
  type DynamicTaskDefinition,
  type TaskInputManifest,
} from "../engine/platform/protocol.js";
import { createTaskExecutionGrant } from "../engine/platform/execution-grant.js";
import { createTaskContextManifest } from "../engine/platform/task-context-manifest.js";
import { ModelProviderHealthRegistry } from "../engine/runtime/model-provider-health.js";
import {
  SpacetimeSharedWorkspace,
  createSpacetimeTaskGraphWorkspaceContextFactory,
} from "../engine/workspace/spacetimedb-shared-workspace.js";
import type { AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import { html, text } from "../framework/http.js";
import { CANVAS_MAX_PAINTERS, CANVAS_MIN_PAINTERS } from "../modules/canvas.js";
import { hashCanvasPrompts, loadCanvasPrompts } from "../prompts/canvas.js";
import { canvasShell } from "../views/canvas.js";
import { normalizeCanvasConfig, runCanvasRoster, type CanvasRunConfig } from "./canvas.js";
import {
  createCanvasTaskExecutionLedger,
  type CanvasTaskExecutionLedger,
} from "./canvas.model-budget.js";
import { createCanvasModel, resolveCanvasModelRouting, type CanvasModel } from "./canvas.model.js";
import { canvasRunStream } from "./canvas.streams.js";

const canvasRunSchema = z.object({
  prompt: z.string().trim().min(3).max(1_000),
  parallel: z.coerce.number().int().min(CANVAS_MIN_PAINTERS).max(CANVAS_MAX_PAINTERS).default(5),
  csrf: z.string().min(32).max(240),
});

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const TERMINAL_RUN_STATUSES = new Set(["completed", "completed_with_notes", "failed", "canceled", "budget_exhausted"]);
const COORDINATOR_TASK_ID = "__canvas_coordinator__";
const COORDINATOR_LEASE_MS = 120_000;
// Canvas is watched as it is produced. Keep the durable lease long enough for
// model latency, but project a frequent liveness signal so silence never looks
// like a stalled artist.
const COORDINATOR_HEARTBEAT_MS = 5_000;
const CANVAS_CSRF_MAX_AGE_MS = 30 * 60 * 1_000;

type CanvasRouteDeps = {
  readonly promptHash: string;
  readonly promptPath: string;
  readonly canvasModel: CanvasModel;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly controlPlane?: SpacetimeControlPlane;
  readonly workspaceId?: string;
  readonly webAccess?: SpacetimeWebAccess;
  readonly csrfSecret?: string;
  readonly canvasRosterRunner?: typeof runCanvasRoster;
  readonly executionLedger?: CanvasTaskExecutionLedger;
  readonly providerHealth?: ModelProviderHealthRegistry;
  readonly providerId?: string;
};

const resolveCanvasCsrfSecret = (provided?: string): string => {
  const configured = provided?.trim() || process.env.CANVAS_CSRF_SECRET?.trim();
  if (configured) {
    if (configured.length < 32) throw new Error("CANVAS_CSRF_SECRET must contain at least 32 characters");
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("CANVAS_CSRF_SECRET is required in production");
  }
  return randomBytes(32).toString("base64url");
};

const createCanvasCsrfToken = (secret: string, now = Date.now()): string => {
  const payload = `${now.toString(36)}.${randomBytes(18).toString("base64url")}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
};

const verifyCanvasCsrfToken = (token: string, secret: string, now = Date.now()): boolean => {
  const [issuedAtEncoded, random, signature, ...extra] = token.split(".");
  if (!issuedAtEncoded || !random || !signature || extra.length > 0) return false;
  const issuedAt = Number.parseInt(issuedAtEncoded, 36);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 60_000 || now - issuedAt > CANVAS_CSRF_MAX_AGE_MS) {
    return false;
  }
  const payload = `${issuedAtEncoded}.${random}`;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
};

const isForeignWebOrigin = (requestUrl: string, origin: string | undefined): boolean => {
  if (!origin || origin === "null") return false;
  let source: URL;
  let target: URL;
  try {
    source = new URL(origin);
    target = new URL(requestUrl);
  } catch {
    return true;
  }
  if (source.origin === target.origin) return false;
  const webOrigin = source.protocol === "http:" || source.protocol === "https:";
  if (!webOrigin) return false;
  if (process.env.NODE_ENV !== "production") {
    const loopback = (hostname: string): boolean => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
    if (
      loopback(source.hostname)
      && loopback(target.hostname)
      && source.protocol === target.protocol
      && source.port === target.port
    ) return false;
  }
  return true;
};

const boundedEnvInteger = (name: string, fallback: number, min: number, max: number): number => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
};

const canvasRunBudgetMicros = (): bigint => {
  try {
    const configured = BigInt(process.env.CANVAS_RUN_BUDGET_MICROS ?? "5000000");
    return configured >= 0n ? configured : 5_000_000n;
  } catch {
    return 5_000_000n;
  }
};

const viewerCapabilityPolicy = () => ({
  maxUses: boundedEnvInteger("CANVAS_VIEWER_MAX_USES", 256, 1, 10_000),
  ttlSeconds: boundedEnvInteger("CANVAS_VIEWER_TTL_SECONDS", 2_592_000, 60, 2_592_000),
});

const publicSpacetimeUri = (controlPlane: SpacetimeControlPlane | undefined): string => {
  const explicit = process.env.SPACETIMEDB_PUBLIC_URI?.trim();
  const uri = explicit || controlPlane?.config.uri || process.env.SPACETIMEDB_URI?.trim() || "http://127.0.0.1:3000";
  if (process.env.NODE_ENV === "production") {
    if (!explicit) throw new Error("SPACETIMEDB_PUBLIC_URI is required in production");
    const parsed = new URL(explicit);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
    if (parsed.protocol !== "https:" && !loopback) {
      throw new Error("SPACETIMEDB_PUBLIC_URI must use HTTPS outside loopback development");
    }
  }
  return uri;
};

const canvasSecurityHeaders = (realtimeUri: string, nonce: string): Readonly<Record<string, string>> => {
  const publicUrl = new URL(realtimeUri);
  const websocketUrl = new URL(realtimeUri);
  websocketUrl.protocol = publicUrl.protocol === "https:" ? "wss:" : "ws:";
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      // spacetimedb@2.6.1 generates algebraic serializers with Function(...).
      // Keep this exception scoped to Canvas and remove it when the SDK ships a CSP-safe mode.
      `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`,
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self' ${publicUrl.origin} ${websocketUrl.origin}`,
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
};

const freshRunId = (): string =>
  `canvas_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;

const freshViewerSecret = (): string => randomBytes(32).toString("base64url");

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const canvasTaskInputs = (
  runId: string,
  promptHash: string,
  sceneHash = "",
): TaskInputManifest => ({
  inputVersions: {
    "canvas.run": hashCanonical({ runId, promptHash }),
    "canvas.prompts": promptHash,
  },
  dataReferences: [{
    schemaVersion: ROSTER_DATA_REFERENCE_VERSION,
    referenceId: `canvas_input_${hashCanonical({ runId, promptHash }).slice(0, 24)}`,
    contentHash: hashCanonical({ runId, promptHash, sceneHash }),
    mediaType: "application/vnd.roster.canvas-run+json",
    byteLength: Buffer.byteLength(runId) + Buffer.byteLength(promptHash),
    storage: "ephemeral",
    uri: `spacetimedb:canvas_run/${runId}`,
  }],
  frontierVersion: sceneHash || "canvas.frontier.initial",
  topologyVersion: "canvas.roster.v3",
  catalogVersion: `canvas.catalog.${promptHash}`,
});

const canvasCoordinatorDefinition = (
  runId: string,
  promptHash: string,
): DynamicTaskDefinition => createDynamicTaskDefinition({
  taskId: COORDINATOR_TASK_ID,
  semanticKey: `canvas.coordinator:${runId}`,
  nodeId: "canvas-coordinator",
  capability: "coordinate.canvas",
  objective: "Coordinate a bounded Canvas workflow and accept its final durable scene frontier.",
  handler: {
    kind: "canvas.coordinator",
    version: promptHash,
  },
  acceptance: {
    policyId: "canvas.scene-frontier",
    policyVersion: "v3",
  },
  result: {
    mode: "artifact",
    outputKey: "canvas.scene",
    artifactKind: "canvas.scene",
    mediaType: "application/vnd.roster.canvas-scene+json",
  },
  dependencies: [],
  join: { kind: "all-success" },
  inputs: canvasTaskInputs(runId, promptHash),
  runtimeBindingEpoch: 1,
  retry: {
    maxAttempts: 8,
    initialBackoffMs: 1_000,
    maximumBackoffMs: 60_000,
  },
  timeoutMs: COORDINATOR_LEASE_MS,
  sideEffect: "idempotent",
  estimatedCostMicros: 750_000,
});

export const createCanvasRoute = (deps: CanvasRouteDeps): AgentRouteModule => {
  const activeRuns = new Map<string, Promise<void>>();
  let dispatchSubscription: ReturnType<SpacetimeControlPlane["subscribeCanvasDispatch"]> | undefined;
  let recoverNonterminalRuns = (): void => undefined;
  const realtimeUri = publicSpacetimeUri(deps.controlPlane);
  const maxLocalRuns = boundedEnvInteger("CANVAS_MAX_LOCAL_RUNS", 4, 1, 64);
  const maxActiveRuns = boundedEnvInteger("CANVAS_MAX_ACTIVE_RUNS", 256, 1, 10_000);
  const csrfSecret = resolveCanvasCsrfSecret(deps.csrfSecret);
  const workspaceId = deps.workspaceId?.trim() || process.env.ROSTER_WORKSPACE_ID?.trim() || "roster/default";
  const dataDirectory = resolve(
    process.env.DATA_DIR?.trim() || join(process.cwd(), "data"),
  );
  const rosterPlatformDirectory = join(dataDirectory, "roster-platform");
  const providerId = deps.providerId?.trim() || "openai";
  const providerStatus = () => {
    const health = deps.providerHealth?.snapshot(providerId);
    if (!deps.apiReady) {
      return { ready: false, note: deps.apiNote ?? "Model access is unavailable." };
    }
    if (health && health.state !== "available") {
      return { ready: false, note: health.note ?? "Model provider is unavailable." };
    }
    return { ready: true, note: undefined };
  };

  const launch = (input: {
    readonly stream: string;
    readonly runId: string;
    readonly prompt?: string;
    readonly config?: Partial<CanvasRunConfig>;
  }): void => {
    const controlPlane = deps.controlPlane;
    if (
      !controlPlane
      || activeRuns.has(input.runId)
      || activeRuns.size >= maxLocalRuns
      || !SAFE_RUN_ID.test(input.runId)
    ) return;

    let leaseContended = false;
    const pending = (async () => {
      const canvasSubscription = controlPlane.subscribeCanvasRun(input.runId);
      const rosterSubscription = controlPlane.subscribeRosterExecution(input.runId);
      let coordinatorFence: bigint | undefined;
      let heartbeat: NodeJS.Timeout | undefined;
      let sharedWorkspace: SpacetimeSharedWorkspace | undefined;
      try {
        await Promise.all([
          canvasSubscription.ready,
          rosterSubscription.ready,
        ]);
        const run = controlPlane.snapshot().runs.find((candidate) => candidate.id === input.runId);
        if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return;

        const coordinatorDefinition = canvasCoordinatorDefinition(input.runId, deps.promptHash);
        await controlPlane.enqueueRosterTask({
          runId: input.runId,
          definition: coordinatorDefinition,
        });
        const coordinatorBeforeClaim = controlPlane.snapshot().tasks.find((task) =>
          task.runId === input.runId && task.taskId === COORDINATOR_TASK_ID
        );
        if (coordinatorBeforeClaim?.status === "failed") {
          await controlPlane.cancelCanvasRun(
            input.runId,
            coordinatorBeforeClaim.lastError
              ? `Canvas coordinator failed: ${coordinatorBeforeClaim.lastError}`
              : "Canvas coordinator retry budget exhausted",
          );
          return;
        }
        try {
          await controlPlane.claimRosterTask({
            runId: input.runId,
            taskId: COORDINATOR_TASK_ID,
            leaseMs: COORDINATOR_LEASE_MS,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/exhausted its attempts/i.test(message)) {
            await controlPlane.cancelCanvasRun(input.runId, "Canvas coordinator retry budget exhausted");
            return;
          }
          if (/not claimable|not ready/i.test(message)) {
            leaseContended = true;
            return;
          }
          throw error;
        }
        const coordinatorTask = controlPlane.snapshot().tasks.find((task) =>
          task.runId === input.runId && task.taskId === COORDINATOR_TASK_ID
        );
        if (!coordinatorTask || coordinatorTask.status !== "leased") {
          throw new Error(`Canvas coordinator lease for ${input.runId} was not projected`);
        }
        coordinatorFence = coordinatorTask.leaseFence;
        const numericFence = Number(coordinatorFence);
        if (!Number.isSafeInteger(numericFence) || numericFence < 1) {
          throw new Error(`Canvas coordinator fence for ${input.runId} exceeds the safe integer bound`);
        }
        await controlPlane.startRosterTask({
          runId: input.runId,
          taskId: COORDINATOR_TASK_ID,
          fence: coordinatorFence,
          contextManifest: createTaskContextManifest({
            runId: input.runId,
            definition: coordinatorDefinition,
            attempt: coordinatorTask.attempt,
            fence: numericFence,
            executionGrant: createTaskExecutionGrant({
              runId: input.runId,
              definition: coordinatorDefinition,
              attempt: coordinatorTask.attempt,
              fence: numericFence,
              policyVersion: "canvas.coordinator.v1",
              policy: { maxTokens: 0, maxCostMicros: 0 },
              rationale: "The non-model Canvas coordinator is admitted without external effects.",
            }),
            repository: {
              root: null,
              branch: null,
              commit: null,
              worktree: null,
            },
          }),
        });
        heartbeat = setInterval(() => {
          void controlPlane.heartbeatRosterTask({
            runId: input.runId,
            taskId: COORDINATOR_TASK_ID,
            fence: coordinatorFence!,
            leaseMs: COORDINATOR_LEASE_MS,
          }).catch((error) => {
            console.error(`Canvas coordinator heartbeat failed for ${input.runId}`, error);
          });
        }, COORDINATOR_HEARTBEAT_MS);
        heartbeat.unref();

        const inferredPainters = Math.max(
          CANVAS_MIN_PAINTERS,
          Math.min(CANVAS_MAX_PAINTERS, run.desiredAgents - 3)
        );
        const config = normalizeCanvasConfig(input.config ?? {
          maxParallel: inferredPainters,
          staggerMs: 0,
        });
        const runtime = createSpacetimeCanvasRuntime(controlPlane, input.runId, {
          taskId: COORDINATOR_TASK_ID,
          fence: coordinatorFence,
        });
        const taskGraph = new SpacetimeTaskGraphControl({
          control: controlPlane,
          workspaceId,
          kind: "canvas",
          leaseMs: COORDINATOR_LEASE_MS,
          existingExecution: true,
        });
        const dataReferences = createFileSystemDataReferenceStore({
          directory: join(rosterPlatformDirectory, "data-references"),
          namespace: `canvas:${input.runId}`,
        });
        sharedWorkspace = new SpacetimeSharedWorkspace({
          control: controlPlane,
          workspaceId,
          roomId: input.runId,
          runId: input.runId,
          artifactId: `${input.runId}:shared-workspace`,
        });
        const executionPlane = {
          taskGraph,
          dataReferences,
          createTaskContext: createSpacetimeTaskGraphWorkspaceContextFactory({
            taskGraph,
            workspace: sharedWorkspace,
          }),
          policy: spacetimeRosterExecutionPolicy(controlPlane, input.runId),
        };
        const result = await (deps.canvasRosterRunner ?? runCanvasRoster)({
          stream: input.stream,
          runId: input.runId,
          runStream: canvasRunStream(input.stream, input.runId),
          prompt: input.prompt ?? run.prompt,
          config,
          runtime,
          canvasModel: deps.canvasModel,
          promptHash: deps.promptHash,
          promptPath: deps.promptPath,
          apiReady: deps.apiReady,
          apiNote: deps.apiNote,
          executionPlane,
        });
        if (result.status === "failed" && result.failureClass) {
          deps.providerHealth?.recordFailure(providerId, {
            failureClass: result.failureClass,
            message: result.failureMessage,
          });
        }
        const persistedRun = controlPlane.snapshot().runs.find((candidate) => candidate.id === input.runId);
        if (!persistedRun) {
          throw new Error(`Canvas workflow returned ${result.status} but run ${input.runId} was not projected`);
        }
        if (persistedRun.status !== "completed" && persistedRun.status !== "completed_with_notes") {
          const failure = result.failureClass
            ? ` (${result.failureClass}${result.failureMessage ? `: ${result.failureMessage}` : ""})`
            : "";
          throw new Error(
            `Canvas workflow returned ${result.status}${failure} and run ${input.runId} terminated with ${persistedRun.status}`
          );
        }
        if (!persistedRun.sceneHash) {
          throw new Error(`Canvas run ${input.runId} completed without a projected scene hash`);
        }
        if (
          result.status === "completed"
          && (
            result.sceneHash !== persistedRun.sceneHash
            || result.objectCount !== persistedRun.objectCount
          )
        ) {
          throw new Error(`Canvas workflow result does not match the durable frontier for run ${input.runId}`);
        }
        const completedResult = {
          ...result,
          status: "completed" as const,
          sceneHash: persistedRun.sceneHash,
          objectCount: persistedRun.objectCount,
        };
        const outputRef = `spacetimedb:canvas_run/${input.runId}`;
        const outputHash = hashCanonical(completedResult);
        const coordinatorUsage = deps.executionLedger?.taskUsage(
          input.runId,
          COORDINATOR_TASK_ID,
        );
        await controlPlane.acceptRosterTaskOutcome({
          runId: input.runId,
          taskId: COORDINATOR_TASK_ID,
          fence: coordinatorFence,
          outcome: createAcceptedTaskOutcome({
            runId: input.runId,
            taskId: COORDINATOR_TASK_ID,
            nodeId: coordinatorDefinition.nodeId,
            attempt: coordinatorTask.attempt,
            definitionHash: coordinatorDefinition.definitionHash,
            inputVersions: coordinatorDefinition.inputs.inputVersions,
            frontierVersion: coordinatorDefinition.inputs.frontierVersion,
            topologyVersion: coordinatorDefinition.inputs.topologyVersion,
            catalogVersion: coordinatorDefinition.inputs.catalogVersion,
            acceptancePolicyId: coordinatorDefinition.acceptance.policyId,
            acceptancePolicyVersion: coordinatorDefinition.acceptance.policyVersion,
            artifacts: [{
              artifactId: `${input.runId}:canvas.scene`,
              outputKey: "canvas.scene",
              kind: "canvas.scene",
              contentHash: outputHash,
              mediaType: "application/vnd.roster.canvas-scene+json",
              byteLength: Buffer.byteLength(JSON.stringify(completedResult)),
              storage: "artifact",
              uri: outputRef,
            }],
            ...(coordinatorUsage ? { usage: coordinatorUsage } : {}),
          }),
        });
        deps.executionLedger?.forgetTask(input.runId, COORDINATOR_TASK_ID);
        await controlPlane.finalizeCanvasRun({
          runId: input.runId,
          outcome: persistedRun.status,
          sceneHash: persistedRun.sceneHash,
          objectCount: persistedRun.objectCount,
        });
      } catch (error) {
        if (coordinatorFence !== undefined) {
          const persistedRun = controlPlane.snapshot().runs.find((candidate) => candidate.id === input.runId);
          const retryable = !persistedRun || !TERMINAL_RUN_STATUSES.has(persistedRun.status);
          await controlPlane.failRosterTask({
            runId: input.runId,
            taskId: COORDINATOR_TASK_ID,
            fence: coordinatorFence,
            error: error instanceof Error ? error.message : String(error),
            retryable,
          }).then(() => {
            if (!retryable) deps.executionLedger?.forgetTask(input.runId, COORDINATOR_TASK_ID);
          }).catch(() => undefined);
        }
        throw error;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (sharedWorkspace) {
          sharedWorkspace.close();
        }
        rosterSubscription.close();
        canvasSubscription.close();
      }
    })()
      .catch((error) => {
        console.error(`Canvas run ${input.runId} failed`, error);
      })
      .finally(() => {
        activeRuns.delete(input.runId);
        if (!leaseContended) queueMicrotask(recoverNonterminalRuns);
      });
    activeRuns.set(input.runId, pending);
  };

  return {
    id: "canvas",
    kind: "run",
    paths: {
      shell: "/canvas",
      run: "/canvas/run",
    },
    register: (app: Hono) => {
      recoverNonterminalRuns = (): void => {
        const controlPlane = deps.controlPlane;
        if (!controlPlane) return;
        const snapshot = controlPlane.snapshot();
        const workspaceRunIds = new Set(
          snapshot.fleetRuns
            .filter((run) => run.workspaceId === workspaceId)
            .map((run) => run.id)
        );
        for (const run of snapshot.runs) {
          if (!workspaceRunIds.has(run.id)) continue;
          if (!TERMINAL_RUN_STATUSES.has(run.status)) {
            launch({ stream: "agents/canvas", runId: run.id, prompt: run.prompt });
          }
        }
      };
      if (deps.controlPlane && !dispatchSubscription) {
        dispatchSubscription = deps.controlPlane.subscribeCanvasDispatch(recoverNonterminalRuns);
        void dispatchSubscription.ready
          .then(async () => {
            // Backfill pre-unification runs so Command Center sees the same
            // Canvas fleet immediately after deployment. Runs already linked
            // to another workspace must remain there.
            const snapshot = deps.controlPlane?.snapshot();
            const linkedRunIds = new Set(snapshot?.fleetRuns.map((run) => run.id) ?? []);
            for (const run of snapshot?.runs ?? []) {
              if (linkedRunIds.has(run.id)) continue;
              await deps.controlPlane?.linkCanvasRunWorkspace(workspaceId, run.id);
            }
            recoverNonterminalRuns();
          })
          .catch((error) => console.error("Canvas dispatch recovery failed", error));
      }

      app.get("/canvas", (c) => {
        const stream = c.req.query("stream")?.trim() || "agents/canvas";
        const runId = c.req.query("run")?.trim() || undefined;
        if (runId) launch({ stream, runId });

        const realtimeReady = Boolean(deps.controlPlane);
        const provider = providerStatus();
        const apiReady = provider.ready && realtimeReady;
        const apiNote = !realtimeReady
          ? "SpacetimeDB is unavailable; new Canvas runs are disabled until the durable realtime service reconnects."
          : provider.note;
        const nonce = randomBytes(18).toString("base64");
        return html(canvasShell({
          stream,
          runId,
          nonce,
          csrfToken: createCanvasCsrfToken(csrfSecret),
          apiReady,
          apiNote,
          models: deps.canvasModel.routing,
          realtime: {
            enabled: realtimeReady,
            uri: realtimeUri,
            database: deps.controlPlane?.config.database
              || process.env.SPACETIMEDB_DATABASE?.trim()
              || "roster-local",
            confirmedReads: deps.controlPlane?.config.confirmedReads ?? false,
            workspaceId: deps.webAccess?.workspaceId,
            workspaceCapabilitySecret: deps.webAccess?.capabilitySecret,
          },
        }), { ...canvasSecurityHeaders(realtimeUri, nonce) });
      });

      app.get("/canvas/run-token", (c) => {
        c.header("Cache-Control", "no-store");
        return c.json({ csrfToken: createCanvasCsrfToken(csrfSecret) });
      });

      app.post(
        "/canvas/run",
        zValidator("form", canvasRunSchema, (result) => {
          if (!result.success) {
            return text(400, `Enter a visual brief and choose between ${CANVAS_MIN_PAINTERS} and ${CANVAS_MAX_PAINTERS} studio artists.`);
          }
        }),
        async (c) => {
          const form = c.req.valid("form");
          if (!verifyCanvasCsrfToken(form.csrf, csrfSecret)) {
            return text(403, "Canvas run form expired. Reload the page and try again.");
          }
          if (isForeignWebOrigin(c.req.url, c.req.header("origin"))) {
            return text(403, "Cross-site Canvas run creation is not allowed.");
          }
          const controlPlane = deps.controlPlane;
          if (!controlPlane) {
            return text(503, "SpacetimeDB is required for Canvas runs and is currently unavailable.");
          }
          const provider = providerStatus();
          if (!provider.ready) {
            return text(503, provider.note ?? "Canvas model provider is unavailable.");
          }
          const activeRunCount = controlPlane.snapshot().runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status)).length;
          if (activeRunCount >= maxActiveRuns) {
            return text(429, "The Canvas studio is at its active-run limit. Try again after a run finishes.");
          }

          const stream = c.req.query("stream")?.trim() || "agents/canvas";
          const runId = freshRunId();
          const config = normalizeCanvasConfig({ maxParallel: form.parallel, staggerMs: 0 });
          const viewerSecret = freshViewerSecret();
          const capabilityId = `viewer_${randomBytes(12).toString("hex")}`;

          await controlPlane.createCanvasRun({
            workspaceId,
            runId,
            requestId: runId,
            prompt: form.prompt,
            desiredAgents: form.parallel + 3,
            // Reserve one lease for the Art Director while allowing every
            // requested specialist slot to execute concurrently.
            maxInflight: form.parallel + 1,
            budgetMicros: canvasRunBudgetMicros(),
          });
          try {
            await controlPlane.createViewerCapability({
              runId,
              capabilityId,
              capabilityHash: sha256Hex(viewerSecret),
              ...viewerCapabilityPolicy(),
            });
          } catch (error) {
            await controlPlane.cancelCanvasRun(runId, "Viewer capability creation failed").catch(() => undefined);
            throw error;
          }

          launch({ stream, runId, prompt: form.prompt, config });
          const query = new URLSearchParams({ stream, run: runId });
          const fragment = new URLSearchParams({ access: viewerSecret });
          return c.redirect(`/canvas?${query.toString()}#${fragment.toString()}`, 303);
        }
      );
    },
  };
};

const factory: AgentModuleFactory = (ctx) => {
  const prompts = loadCanvasPrompts();
  const models = resolveCanvasModelRouting();
  const durableControl = ctx.helper(
    "spacetimeControlPlane",
    (value): value is SpacetimeControlPlane => value instanceof SpacetimeControlPlane,
  );
  const workspaceId = ctx.helper("workspaceId", (value): value is string => typeof value === "string");
  const webAccess = ctx.helper(
    "spacetimeWebAccess",
    (value): value is SpacetimeWebAccess => value instanceof SpacetimeWebAccess,
  );
  const executionLedger = createCanvasTaskExecutionLedger();
  const providerHealth = ctx.helper(
    "modelProviderHealth",
    (value): value is ModelProviderHealthRegistry => value instanceof ModelProviderHealthRegistry,
  );
  return createCanvasRoute({
    promptHash: hashCanvasPrompts(prompts),
    promptPath: "prompts/canvas.prompts.json",
    canvasModel: createCanvasModel({
      llmStructured: ctx.llmStructured,
      prompts,
      models,
      budget: executionLedger,
    }),
    apiReady: Boolean(process.env.OPENAI_API_KEY),
    apiNote: process.env.OPENAI_API_KEY
      ? undefined
      : "OPENAI_API_KEY not set; Canvas Roster requires a model to interpret and paint arbitrary briefs.",
    controlPlane: durableControl,
    workspaceId,
    webAccess,
    executionLedger,
    providerHealth,
    providerId: "openai",
  });
};

export default factory;
