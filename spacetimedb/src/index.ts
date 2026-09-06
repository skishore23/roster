import { ScheduleAt, Timestamp, type Identity } from "spacetimedb";
import {
  SenderError,
  schema,
  table,
  t,
  type InferSchema,
  type ReducerCtx,
} from "spacetimedb/server";

import { logicalStreamId, scopedStreamKey } from "./stream-identity";
import {
  boundedCodingTimelineRows,
  codingTimelineHead,
  codingTimelinePage,
} from "./coding-timeline-pagination";

const canvasRun = table(
  { name: "canvas_run" },
  {
    id: t.string().primaryKey(),
    owner: t.identity().index("btree"),
    requestKey: t.string().unique(),
    prompt: t.string(),
    status: t.string().index("btree"),
    desiredAgents: t.u32(),
    maxInflight: t.u32(),
    nextReceiptSeq: t.u64(),
    headReceiptHash: t.string(),
    budgetMicros: t.u64(),
    reservedMicros: t.u64(),
    spentMicros: t.u64(),
    sceneHash: t.string(),
    objectCount: t.u32(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const runMember = table(
  { name: "run_member" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    member: t.identity().index("btree"),
    role: t.string(),
    createdAt: t.timestamp(),
  }
);

/** Links Canvas' run-scoped collaboration model into the shared workspace fleet. */
const canvasWorkspaceRun = table(
  { name: "canvas_workspace_run" },
  {
    runId: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    createdAt: t.timestamp(),
  }
);

/**
 * Shared tenancy boundary for every non-Canvas agent surface. A workspace is
 * intentionally separate from an individual run so the browser can subscribe
 * to one run index plus one selected run without receiving unrelated tenants.
 */
const rosterWorkspace = table(
  { name: "roster_workspace" },
  {
    id: t.string().primaryKey(),
    owner: t.identity().index("btree"),
    name: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const rosterWorkspaceMember = table(
  { name: "roster_workspace_member" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    member: t.identity().index("btree"),
    role: t.string(),
    createdAt: t.timestamp(),
  }
);

/** Reducer-owned service quota projection for one caller-owned workspace. */
const rosterWorkspaceUsage = table(
  { name: "roster_workspace_usage" },
  {
    workspaceId: t.string().primaryKey(),
    owner: t.identity().index("btree"),
    windowStartedAt: t.timestamp(),
    jobsInWindow: t.u32(),
    activeJobs: t.u32(),
    totalJobs: t.u64(),
    updatedAt: t.timestamp(),
  }
);

/** One-way verifier for short-lived browser viewer access. */
const workspaceViewerCapability = table(
  { name: "workspace_viewer_capability" },
  {
    capabilityHash: t.string().primaryKey(),
    capabilityId: t.string().unique(),
    workspaceId: t.string().index("btree"),
    maxUses: t.u32(),
    uses: t.u32(),
    expiresAt: t.timestamp(),
    revoked: t.bool(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const workspaceViewerRedemption = table(
  { name: "workspace_viewer_redemption" },
  {
    id: t.string().primaryKey(),
    capabilityId: t.string().index("btree"),
    workspaceId: t.string().index("btree"),
    member: t.identity().index("btree"),
    createdAt: t.timestamp(),
  }
);

/** Durable metadata for one immutable receipt chain. */
const eventStream = table(
  { name: "event_stream" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    kind: t.string(),
    nextSeq: t.u64(),
    headHash: t.string(),
    receiptCount: t.u64(),
    parentStreamId: t.string().index("btree"),
    forkAt: t.u32(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/**
 * Generic domain receipts for proof, writing, swarm, memory, jobs, inspection,
 * and simulations. Canvas retains its typed receipt projection while it is
 * incrementally aligned with this shared workspace model.
 */
const streamReceipt = table(
  { name: "stream_receipt" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    streamId: t.string().index("btree"),
    seq: t.u64(),
    receiptId: t.string(),
    occurredAtMs: t.u64(),
    prevHash: t.string(),
    hash: t.string(),
    bodyJson: t.string(),
    hintsJson: t.string(),
    createdAt: t.timestamp(),
  }
);

/**
 * Durable directory metadata for a Coding repository conversation. The room
 * row and its first message receipt are created by one reducer transaction;
 * execution branches remain child event streams linked by conversation id.
 */
const codingRoom = table(
  { name: "coding_room" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    codingWorkspaceId: t.string().index("btree"),
    roomId: t.string(),
    conversationId: t.string().index("btree"),
    streamId: t.string().index("btree"),
    title: t.string(),
    state: t.string(),
    firstMessageId: t.string(),
    messageCount: t.u32(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Provider-neutral room directory. A room can host many execution epochs. */
const rosterRoom = table(
  { name: "roster_room" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    roomKey: t.string(),
    kind: t.string(),
    title: t.string(),
    status: t.string().index("btree"),
    activeRunId: t.string().index("btree"),
    certifiedCheckpointId: t.string(),
    nextTimelineSeq: t.u64(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Durable logical cast; runtime placement remains in roster_runtime_binding. */
const rosterRoomNode = table(
  { name: "roster_room_node" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    roomId: t.string().index("btree"),
    runId: t.string().index("btree"),
    nodeId: t.string(),
    name: t.string(),
    capabilitiesJson: t.string(),
    parentNodeId: t.string(),
    nodeJson: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Workspace-scoped social/capability overlay for a durable logical node. */
const rosterParticipantProfile = table(
  { name: "roster_participant_profile" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    nodeId: t.string(),
    displayName: t.string(),
    role: t.string(),
    bio: t.string(),
    skillsJson: t.string(),
    capabilitiesJson: t.string(),
    revision: t.u64(),
    updatedBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Canonical workspace-scoped logical node declaration across execution runs. */
const rosterWorkspaceNode = table(
  { name: "roster_workspace_node" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    nodeId: t.string(),
    nodeRevision: t.u64(),
    nodeJson: t.string(),
    continuityPolicyJson: t.string(),
    status: t.string().index("btree"),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Current ordered continuity projection; immutable detail remains in events. */
const rosterNodeContinuity = table(
  { name: "roster_node_continuity" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    nodeId: t.string(),
    status: t.string().index("btree"),
    revision: t.u64(),
    nextInboxSeq: t.u64(),
    nextEventSeq: t.u64(),
    pendingInboxCount: t.u32(),
    activeWakeId: t.string(),
    lastWakeId: t.string(),
    lastWakeAtMs: t.u64(),
    wakeWindowStartedAtMs: t.u64(),
    wakesInWindow: t.u32(),
    memoryScopeId: t.string(),
    memorySnapshotVersion: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Durable source pointers delivered to one logical node. */
const rosterNodeInboxItem = table(
  { name: "roster_node_inbox_item" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    nodeId: t.string().index("btree"),
    deliveryId: t.string(),
    seq: t.u64(),
    cause: t.string(),
    sourceId: t.string(),
    sourceVersion: t.string(),
    sourceHash: t.string(),
    payloadReference: t.string(),
    causalParentId: t.string(),
    causalDepth: t.u32(),
    status: t.string().index("btree"),
    wakeId: t.string(),
    itemJson: t.string(),
    deliveredAtMs: t.u64(),
    consumedAt: t.option(t.timestamp()),
    createdAt: t.timestamp(),
    // Additive migration fields stay at the end forever. Defaults preserve
    // pre-room-lane rows during customer upgrades; reducers populate them for
    // every new delivery.
    laneId: t.string().default("").index("btree"),
    roomId: t.string().default(""),
    runId: t.string().default(""),
  }
);

/** One bounded episodic execution request for a durable logical node. */
const rosterNodeWake = table(
  { name: "roster_node_wake" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    nodeId: t.string().index("btree"),
    requestId: t.string(),
    status: t.string().index("btree"),
    inboxDeliveryIdsJson: t.string(),
    manifestJson: t.string(),
    jobId: t.string(),
    requestedAtMs: t.u64(),
    notBeforeMs: t.u64(),
    admittedAtMs: t.u64(),
    completedAtMs: t.u64(),
    resultJson: t.string(),
    lastError: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    // See roster_node_inbox_item: appending defaulted fields is the only
    // automatic migration supported for existing SpacetimeDB rows.
    laneId: t.string().default("").index("btree"),
    roomId: t.string().default(""),
    runId: t.string().default(""),
  }
);

/** Typed durable commitments are control state, not free-form model memory. */
const rosterNodeCommitment = table(
  { name: "roster_node_commitment" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    nodeId: t.string().index("btree"),
    commitmentId: t.string(),
    objective: t.string(),
    status: t.string().index("btree"),
    revision: t.u64(),
    sourceId: t.string(),
    updatedAtMs: t.u64(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Immutable ordered node lifecycle events for audit and replay. */
const rosterNodeContinuityEvent = table(
  { name: "roster_node_continuity_event" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    nodeId: t.string().index("btree"),
    seq: t.u64(),
    kind: t.string(),
    eventJson: t.string(),
    createdAt: t.timestamp(),
  }
);

/** Typed Room OS collaboration timeline. entryJson is the typed union payload. */
const rosterRoomTimelineEntry = table(
  { name: "roster_room_timeline_entry" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    roomId: t.string().index("btree"),
    runId: t.string().index("btree"),
    seq: t.u64(),
    kind: t.string(),
    taskId: t.string(),
    nodeId: t.string(),
    entryJson: t.string(),
    createdAt: t.timestamp(),
  }
);

/** One caller- and connection-owned cursor selecting one bounded Coding page. */
const codingRoomTimelinePageRequest = table(
  { name: "coding_room_timeline_page_request" },
  {
    id: t.string().primaryKey(),
    member: t.identity().index("btree"),
    workspaceId: t.string().index("btree"),
    roomId: t.string().index("btree"),
    runId: t.string().index("btree"),
    beforeSeq: t.u64(),
    requestedAt: t.timestamp(),
    // Additive migration fields: legacy sender-only requests are ignored and
    // removed on the next selection. New rows are keyed by sender+selection.
    selectionId: t.string().default("").index("btree"),
    expiresAt: t.option(t.timestamp()),
  }
);

/** Follow-ups and operator commands consumed only at reducer-authorized boundaries. */
const rosterRoomControlIntent = table(
  { name: "roster_room_control_intent" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    roomId: t.string().index("btree"),
    intentId: t.string(),
    kind: t.string(),
    payloadJson: t.string(),
    status: t.string().index("btree"),
    targetRunId: t.string(),
    consumedBy: t.string(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    consumedAt: t.option(t.timestamp()),
  }
);

/** Current certified input frontier for one execution. */
const rosterContextFrontier = table(
  { name: "roster_context_frontier" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    roomId: t.string().index("btree"),
    runId: t.string().index("btree"),
    contextVersion: t.string(),
    frontierVersion: t.string(),
    topologyVersion: t.string(),
    catalogVersion: t.string(),
    bindingVersion: t.string(),
    frontierJson: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const rosterExecutionInitialization = table(
  { name: "roster_execution_initialization" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    roomId: t.string().index("btree"),
    runId: t.string().index("btree"),
    idempotencyKey: t.string(),
    argumentsHash: t.string(),
    createdAt: t.timestamp(),
  }
);

/** Exact context admitted in the same transaction that starts a task. */
const rosterTaskContextManifest = table(
  { name: "roster_task_context_manifest" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    roomId: t.string().index("btree"),
    runId: t.string().index("btree"),
    taskId: t.string(),
    nodeId: t.string(),
    attempt: t.u32(),
    fence: t.u64(),
    manifestId: t.string(),
    contextVersion: t.string(),
    frontierVersion: t.string(),
    topologyVersion: t.string(),
    catalogVersion: t.string(),
    bindingVersion: t.u64(),
    manifestJson: t.string(),
    createdAt: t.timestamp(),
  }
);

/** Replaceable execution placement for one logical node and monotonic epoch. */
const rosterRuntimeBinding = table(
  { name: "roster_runtime_binding" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    roomId: t.string().index("btree"),
    runId: t.string().index("btree"),
    nodeId: t.string(),
    bindingId: t.string(),
    epoch: t.u64(),
    topologyVersion: t.string(),
    runtimeJson: t.string(),
    createdAt: t.timestamp(),
  }
);

/** Provider budget is fenced before a call and settled exactly once afterward. */
const rosterModelReservation = table(
  { name: "roster_model_reservation" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    roomId: t.string().index("btree"),
    runId: t.string().index("btree"),
    taskId: t.string(),
    nodeId: t.string(),
    fence: t.u64(),
    provider: t.string(),
    model: t.string(),
    status: t.string().index("btree"),
    reservedCostMicros: t.u64(),
    actualCostMicros: t.u64(),
    reservedTokens: t.u64(),
    actualTokens: t.u64(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Secondary projection/object-store delivery only; graph state never waits on it. */
const rosterProjectionOutbox = table(
  { name: "roster_projection_outbox" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    roomId: t.string().index("btree"),
    runId: t.string().index("btree"),
    kind: t.string(),
    payloadJson: t.string(),
    status: t.string().index("btree"),
    attempt: t.u32(),
    lastError: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Bounded reducer-accepted Yjs deltas; the client applies only accepted rows. */
const rosterSharedWorkspaceUpdate = table(
  { name: "roster_shared_workspace_update" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    roomId: t.string().index("btree"),
    runId: t.string().index("btree"),
    artifactId: t.string(),
    updateId: t.string(),
    taskId: t.string(),
    nodeId: t.string(),
    fence: t.u64(),
    frontierVersion: t.string(),
    topologyVersion: t.string(),
    catalogVersion: t.string(),
    runtimeBindingEpoch: t.u64(),
    updateBase64: t.string(),
    updateBytes: t.u32(),
    createdAt: t.timestamp(),
  }
);

/** Bounded full-state checkpoints compact accepted Yjs deltas without choosing semantics. */
const rosterSharedWorkspaceCheckpoint = table(
  { name: "roster_shared_workspace_checkpoint" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    roomId: t.string().index("btree"),
    runId: t.string().index("btree"),
    artifactId: t.string(),
    checkpointId: t.string(),
    throughUpdateId: t.string(),
    frontierVersion: t.string(),
    topologyVersion: t.string(),
    stateBase64: t.string(),
    stateBytes: t.u32(),
    createdAt: t.timestamp(),
  }
);

/**
 * Transactional background work shared by every Roster agent. Unlike the
 * immutable receipt stream, this table is the current scheduling projection:
 * reducers are the only writers, so claims and lease fences stay atomic when
 * many worker processes race for the same job.
 */
const rosterJob = table(
  { name: "roster_job" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    agentId: t.string().index("btree"),
    lane: t.string(),
    sessionKey: t.string().index("btree"),
    singletonMode: t.string(),
    payloadJson: t.string(),
    status: t.string().index("btree"),
    attempt: t.u32(),
    maxAttempts: t.u32(),
    leaseOwner: t.option(t.identity()),
    leaseWorker: t.string(),
    leaseFence: t.u64(),
    leaseUntil: t.option(t.timestamp()),
    claimToken: t.string(),
    availableAt: t.timestamp(),
    lastError: t.string(),
    resultJson: t.string(),
    canceledReason: t.string(),
    abortRequested: t.bool(),
    nextEventSeq: t.u64(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Stable request resolution makes enqueue + singleton steering retry-safe. */
const rosterJobRequest = table(
  { name: "roster_job_request" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    requestId: t.string(),
    requestedJobId: t.string(),
    resolvedJobId: t.string(),
    requestJson: t.string(),
    createdAt: t.timestamp(),
  }
);

const rosterJobCommand = table(
  { name: "roster_job_command" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    jobId: t.string().index("btree"),
    command: t.string(),
    lane: t.string(),
    payloadJson: t.string(),
    by: t.string(),
    createdAt: t.timestamp(),
    consumedAt: t.option(t.timestamp()),
    consumedBy: t.string(),
  }
);

/** Immutable, reducer-atomic lifecycle frames used by monitor replay. */
const rosterJobEvent = table(
  { name: "roster_job_event" },
  {
    id: t.string().primaryKey(),
    workspaceId: t.string().index("btree"),
    jobId: t.string().index("btree"),
    seq: t.u64(),
    kind: t.string(),
    eventJson: t.string(),
    createdAt: t.timestamp(),
  }
);

/** Roster platform v3 owns the durable, provider-neutral execution graph. */
const rosterExecution = table(
  { name: "roster_execution" },
  {
    runId: t.string().primaryKey(),
    protocolVersion: t.string(),
    kind: t.string(),
    workspaceId: t.string().index("btree"),
    receiptStreamId: t.string(),
    status: t.string().index("btree"),
    policyJson: t.string(),
    graphVersion: t.u64(),
    nextEventSeq: t.u64(),
    totalTasks: t.u32(),
    readyTasks: t.u32(),
    blockedTasks: t.u32(),
    inflightTasks: t.u32(),
    acceptedTasks: t.u32(),
    failedTasks: t.u32(),
    delegatedTasks: t.u32(),
    canceledTasks: t.u32(),
    skippedTasks: t.u32(),
    contextBytes: t.u64(),
    reservedCostMicros: t.u64(),
    spentCostMicros: t.u64(),
    usedTokens: t.u64(),
    terminalReason: t.string(),
    deadlineAt: t.timestamp(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Ordered control receipts for every graph transition. */
const rosterExecutionEvent = table(
  { name: "roster_execution_event" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    seq: t.u64(),
    kind: t.string(),
    actor: t.identity(),
    nodeId: t.string(),
    payloadJson: t.string(),
    createdAt: t.timestamp(),
  }
);

/**
 * One immutable executable definition plus its mutable lease/disposition
 * projection. Definitions never change after insertion.
 */
const rosterTaskDefinition = table(
  { name: "roster_task_definition" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    taskId: t.string(),
    semanticKey: t.string(),
    definitionHash: t.string(),
    definitionJson: t.string(),
    nodeId: t.string(),
    capability: t.string(),
    objective: t.string(),
    handlerKind: t.string(),
    handlerVersion: t.string(),
    acceptancePolicyId: t.string(),
    acceptancePolicyVersion: t.string(),
    resultJson: t.string(),
    inputManifestJson: t.string(),
    frontierVersion: t.string(),
    topologyVersion: t.string(),
    catalogVersion: t.string(),
    runtimeBindingEpoch: t.u64(),
    sideEffect: t.string(),
    estimatedCostMicros: t.u64(),
    contextBytes: t.u64(),
    parentTaskId: t.string().index("btree"),
    depth: t.u32(),
    status: t.string().index("btree"),
    attempt: t.u32(),
    maxAttempts: t.u32(),
    retryInitialBackoffMs: t.u32(),
    retryMaximumBackoffMs: t.u32(),
    timeoutMs: t.u32(),
    availableAt: t.timestamp(),
    leaseOwner: t.option(t.identity()),
    leaseFence: t.u64(),
    leaseUntil: t.option(t.timestamp()),
    lastError: t.string(),
    outcomeId: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** Run-scoped semantic uniqueness prevents duplicate work under new task IDs. */
const rosterTaskSemanticKey = table(
  { name: "roster_task_semantic_key" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    semanticKey: t.string(),
    taskKey: t.string(),
    createdAt: t.timestamp(),
  }
);

const rosterTaskEdge = table(
  { name: "roster_task_edge" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    taskKey: t.string().index("btree"),
    prerequisiteTaskKey: t.string().index("btree"),
    condition: t.string(),
    createdAt: t.timestamp(),
  }
);

/** Materialized join counters make readiness bounded and failure-aware. */
const rosterTaskJoin = table(
  { name: "roster_task_join" },
  {
    taskKey: t.string().primaryKey(),
    runId: t.string().index("btree"),
    kind: t.string(),
    quorum: t.u32(),
    totalDependencies: t.u32(),
    acceptedDependencies: t.u32(),
    terminalDependencies: t.u32(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/** The trusted acceptance boundary; runtime drafts never enter this table. */
const rosterTaskOutcome = table(
  { name: "roster_task_outcome" },
  {
    outcomeId: t.string().primaryKey(),
    runId: t.string().index("btree"),
    taskKey: t.string().index("btree"),
    definitionHash: t.string(),
    outcomeJson: t.string(),
    artifactsJson: t.string(),
    usageJson: t.string(),
    actualCostMicros: t.u64(),
    totalTokens: t.u64(),
    createdAt: t.timestamp(),
  }
);

/** Immutable artifact-to-data-plane references retained for replayable joins. */
const rosterTaskOutputReference = table(
  { name: "roster_task_output_reference" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    taskKey: t.string().index("btree"),
    taskId: t.string(),
    outcomeId: t.string().index("btree"),
    artifactId: t.string(),
    outputKey: t.string(),
    referenceJson: t.string(),
    createdAt: t.timestamp(),
  }
);

const rosterTaskExpansion = table(
  { name: "roster_task_expansion" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    parentTaskKey: t.string().index("btree"),
    parentTaskId: t.string(),
    publicationFence: t.u64(),
    expansionKey: t.string(),
    expansionSpecJson: t.string(),
    childCount: t.u32(),
    continuationTaskId: t.string(),
    delegatedBy: t.identity(),
    createdAt: t.timestamp(),
  }
);

const rosterWorkerCapability = table(
  { name: "roster_worker_capability" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    worker: t.identity().index("btree"),
    capability: t.string(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
  }
);

const receipt = table(
  { name: "receipt" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    seq: t.u64(),
    eventId: t.string(),
    kind: t.string(),
    actor: t.identity(),
    agentId: t.string(),
    payloadJson: t.string(),
    prevHash: t.string(),
    hash: t.string(),
    createdAt: t.timestamp(),
  }
);

const scenePatch = table(
  { name: "scene_patch" },
  {
    patchId: t.string().primaryKey(),
    runId: t.string().index("btree"),
    partId: t.string(),
    agentId: t.string(),
    taskKey: t.string(),
    supersedesPatchId: t.string(),
    contentRef: t.string(),
    contentHash: t.string(),
    objectCount: t.u32(),
    createdAt: t.timestamp(),
  }
);

/**
 * Canvas-specific read models are deliberately separate from the durable work
 * queue tables above. This keeps orchestration/job leasing concerns private
 * while giving authorized browser subscribers a stable visual projection.
 */
const canvasRunDetail = table(
  { name: "canvas_run_detail" },
  {
    runId: t.string().primaryKey(),
    uiStatus: t.string(),
    statusNote: t.string(),
    modelRoutingJson: t.string(),
    configJson: t.string(),
    workflowId: t.string(),
    workflowVersion: t.string(),
    promptHash: t.string(),
    promptPath: t.string(),
    planVersion: t.string(),
    reviewSceneHash: t.string(),
    reviewVerdict: t.string(),
    qualityStatus: t.string(),
    totalTasks: t.u32(),
    completedTasks: t.u32(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const viewerCapability = table(
  { name: "viewer_capability" },
  {
    capabilityHash: t.string().primaryKey(),
    capabilityId: t.string().unique(),
    runId: t.string().index("btree"),
    maxUses: t.u32(),
    uses: t.u32(),
    ttlSeconds: t.u32(),
    expiresAt: t.option(t.timestamp()),
    revoked: t.bool(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const viewerRedemption = table(
  { name: "viewer_redemption" },
  {
    id: t.string().primaryKey(),
    capabilityId: t.string().index("btree"),
    runId: t.string().index("btree"),
    member: t.identity().index("btree"),
    createdAt: t.timestamp(),
  }
);

/** Marks run membership created solely by viewer-capability redemption. */
const viewerCapabilityRunMember = table(
  { name: "viewer_capability_run_member" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    member: t.identity().index("btree"),
    createdAt: t.timestamp(),
  }
);

const scenePlan = table(
  { name: "scene_plan" },
  {
    runId: t.string().primaryKey(),
    planVersion: t.string(),
    planHash: t.string(),
    schemaVersion: t.u32(),
    width: t.u32(),
    height: t.u32(),
    painterCount: t.u32(),
    subject: t.string(),
    artDirection: t.string(),
    focalBoundsJson: t.string(),
    anchorsJson: t.string(),
    paletteJson: t.string(),
    partsJson: t.string(),
    planJson: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const scenePlanPart = table(
  { name: "scene_plan_part" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    partId: t.string(),
    planVersion: t.string(),
    ordinal: t.u32(),
    kind: t.string(),
    role: t.string(),
    label: t.string(),
    artistName: t.string(),
    focus: t.string(),
    objective: t.string(),
    compositionRole: t.string(),
    paintMode: t.string(),
    coordinatesWithJson: t.string(),
    needsJson: t.string(),
    outputKey: t.string(),
    regionJson: t.string(),
    maxFootprintJson: t.string(),
    protectedAnchorsJson: t.string(),
    allowBleed: t.bool(),
    layerBase: t.u32(),
    minObjects: t.u32(),
    maxObjects: t.u32(),
    createdAt: t.timestamp(),
  }
);

const canvasAgent = table(
  { name: "canvas_agent" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    agentId: t.string(),
    name: t.string(),
    role: t.string(),
    group: t.string(),
    focus: t.string(),
    assignment: t.string(),
    model: t.string(),
    status: t.string(),
    taskId: t.string(),
    metadataJson: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const canvasTaskStatus = table(
  { name: "canvas_task_status" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    taskId: t.string(),
    delegationId: t.string(),
    agentId: t.string(),
    capability: t.string(),
    objective: t.string(),
    parentTaskId: t.string(),
    planId: t.string(),
    planVersion: t.string(),
    status: t.string(),
    attempt: t.u32(),
    needsJson: t.string(),
    providesJson: t.string(),
    inputVersionsJson: t.string(),
    artifactIdsJson: t.string(),
    error: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const sceneReview = table(
  { name: "scene_review" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    sceneHash: t.string(),
    agentId: t.string(),
    verdict: t.string(),
    qualityStatus: t.string(),
    scope: t.string(),
    scoresJson: t.string(),
    checksJson: t.string(),
    notesJson: t.string(),
    createdAt: t.timestamp(),
  }
);

const scenePatchData = table(
  { name: "scene_patch_data" },
  {
    patchId: t.string().primaryKey(),
    runId: t.string().index("btree"),
    planVersion: t.string(),
    baseSceneHash: t.string(),
    partId: t.string(),
    agentId: t.string(),
    taskId: t.string(),
    supersedesPatchId: t.string(),
    contentRef: t.string(),
    contentHash: t.string(),
    updateHash: t.string(),
    patchJson: t.string(),
    objectCount: t.u32(),
    active: t.bool(),
    createdAt: t.timestamp(),
  }
);

const sceneObject = table(
  { name: "scene_object" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    patchId: t.string().index("btree"),
    objectId: t.string(),
    semanticId: t.string(),
    ownerAgentId: t.string(),
    taskId: t.string(),
    partId: t.string(),
    objectType: t.string(),
    geometryJson: t.string(),
    styleJson: t.string(),
    layer: t.u32(),
    rank: t.u32(),
    active: t.bool(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const canvasActivity = table(
  { name: "canvas_activity" },
  {
    id: t.string().primaryKey(),
    runId: t.string().index("btree"),
    seq: t.u64(),
    kind: t.string(),
    agentId: t.string(),
    agentName: t.string(),
    summary: t.string(),
    createdAt: t.timestamp(),
  }
);

const rosterTaskLeaseExpiry = table(
  {
    name: "roster_task_lease_expiry",
    // The callback is resolved after all module exports have been registered.
    scheduled: (): any => expireRosterTaskLease,
  },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    taskKey: t.string(),
    fence: t.u64(),
  }
);

const rosterTaskRetryWake = table(
  {
    name: "roster_task_retry_wake",
    // The callback is resolved after all module exports have been registered.
    scheduled: (): any => wakeRosterTaskRetry,
  },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    taskKey: t.string(),
    availableAtMicros: t.u64(),
  }
);

const rosterExecutionDeadline = table(
  {
    name: "roster_execution_deadline",
    scheduled: (): any => expireRosterExecutionDeadline,
  },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    runId: t.string(),
    deadlineMicros: t.u64(),
  }
);

const rosterJobLeaseExpiry = table(
  {
    name: "roster_job_lease_expiry",
    scheduled: (): any => expireRosterJobLease,
  },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    jobId: t.string(),
    fence: t.u64(),
  }
);

const rosterNodeWakeSchedule = table(
  {
    name: "roster_node_wake_schedule",
    scheduled: (): any => dispatchRosterNodeWake,
  },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    wakeId: t.string(),
  }
);

const viewerCapabilityExpiration = table(
  {
    name: "viewer_capability_expiration",
    scheduled: (): any => expireViewerCapabilityAccess,
  },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    capabilityId: t.string(),
    expiresAtMicros: t.u64(),
  }
);

const codingRoomTimelineSelectionExpiration = table(
  {
    name: "coding_room_timeline_selection_expiration",
    scheduled: (): any => expireCodingRoomTimelineSelection,
  },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    requestId: t.string().index("btree"),
    expiresAtMicros: t.u64(),
  }
);

const spacetimedb = schema({
  canvasRun,
  runMember,
  canvasWorkspaceRun,
  rosterWorkspace,
  rosterWorkspaceMember,
  rosterWorkspaceUsage,
  workspaceViewerCapability,
  workspaceViewerRedemption,
  eventStream,
  streamReceipt,
  codingRoom,
  rosterRoom,
  rosterRoomNode,
  rosterParticipantProfile,
  rosterWorkspaceNode,
  rosterNodeContinuity,
  rosterNodeInboxItem,
  rosterNodeWake,
  rosterNodeCommitment,
  rosterNodeContinuityEvent,
  rosterRoomTimelineEntry,
  codingRoomTimelinePageRequest,
  rosterRoomControlIntent,
  rosterContextFrontier,
  rosterExecutionInitialization,
  rosterTaskContextManifest,
  rosterRuntimeBinding,
  rosterModelReservation,
  rosterProjectionOutbox,
  rosterSharedWorkspaceUpdate,
  rosterSharedWorkspaceCheckpoint,
  rosterJob,
  rosterJobRequest,
  rosterJobCommand,
  rosterJobEvent,
  rosterExecution,
  rosterExecutionEvent,
  rosterTaskDefinition,
  rosterTaskSemanticKey,
  rosterTaskEdge,
  rosterTaskJoin,
  rosterTaskOutcome,
  rosterTaskOutputReference,
  rosterTaskExpansion,
  rosterWorkerCapability,
  receipt,
  scenePatch,
  canvasRunDetail,
  viewerCapability,
  viewerRedemption,
  viewerCapabilityRunMember,
  scenePlan,
  scenePlanPart,
  canvasAgent,
  canvasTaskStatus,
  sceneReview,
  scenePatchData,
  sceneObject,
  canvasActivity,
  rosterTaskLeaseExpiry,
  rosterTaskRetryWake,
  rosterExecutionDeadline,
  rosterJobLeaseExpiry,
  rosterNodeWakeSchedule,
  viewerCapabilityExpiration,
  codingRoomTimelineSelectionExpiration,
});

export default spacetimedb;

type RosterSchema = InferSchema<typeof spacetimedb>;
type RosterContext = ReducerCtx<RosterSchema>;
type RosterRoomRow = NonNullable<ReturnType<RosterContext["db"]["rosterRoom"]["id"]["find"]>>;

const RUN_ROLES = new Set(["owner", "coordinator", "worker", "artist", "viewer"]);
const WORKSPACE_ROLES = new Set(["owner", "coordinator", "worker", "viewer"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "completed_with_notes", "failed", "canceled", "budget_exhausted"]);
const ROSTER_PLATFORM_PROTOCOL_VERSION = "roster.platform.v3";
const ROSTER_DATA_REFERENCE_VERSION = "roster.data-reference.v1";
const ROSTER_TASK_DEFINITION_VERSION = "roster.task-definition.v1";
const ROSTER_TASK_OUTCOME_VERSION = "roster.task-outcome.v2";
const ROSTER_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._:/-]*$/;
const ACTIVE_ROSTER_TASK_STATUSES = new Set(["leased", "running"]);
const TERMINAL_ROSTER_TASK_STATUSES = new Set([
  "accepted",
  "failed",
  "canceled",
  "skipped",
]);
const TERMINAL_ROSTER_EXECUTION_STATUSES = new Set([
  "completed",
  "failed",
  "canceled",
  "budget_exhausted",
]);
const MAX_ROSTER_TASKS = 2_000;
const MAX_ROSTER_TASK_DEPTH = 32;
const MAX_ROSTER_TASK_FANOUT = 128;
const CODING_TIMELINE_WINDOW_ROWS = 256;
const CODING_TIMELINE_PUBLIC_ROWS = 256;
const CODING_TIMELINE_PAGE_ROWS = 64;
const MAX_CODING_TIMELINE_SELECTIONS_PER_IDENTITY = 8;
const CODING_TIMELINE_SELECTION_TTL_MICROS = 3_600_000_000n;
const MIN_CODING_TIMELINE_SELECTION_TTL_SECONDS = 1n;
const MAX_CODING_TIMELINE_SELECTION_TTL_SECONDS = CODING_TIMELINE_SELECTION_TTL_MICROS / 1_000_000n;
const CODING_TASK_WINDOW_ROWS = 512;
const CODING_TASK_EDGE_WINDOW_ROWS = 2_048;
const CODING_TASK_OUTPUT_REFERENCE_WINDOW_ROWS = 1_024;
const MAX_ROSTER_INFLIGHT = 128;
const MAX_ROSTER_CONTEXT_BYTES = 128_000_000n;
const MAX_ROSTER_COST_MICROS = 10_000_000_000n;
const MAX_ROSTER_TOKENS = 2_000_000_000n;
const MAX_ROSTER_WALL_TIME_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_WORKER_CAPABILITIES = 64;
const MAX_ROOM_NODES = 2_000;
const MAX_ROOM_TIMELINE_ENTRY_CHARS = 256_000;
const MAX_SHARED_WORKSPACE_UPDATE_BYTES = 1_048_576;
const MAX_SHARED_WORKSPACE_STATE_BYTES = 8_388_608;
const ROOM_TIMELINE_KINDS = new Set([
  "message", "claim", "artifact", "decision", "handoff", "review", "checkpoint", "attention",
]);
const ROOM_CONTROL_INTENT_KINDS = new Set(["follow_up", "steer", "cancel", "retry", "approve"]);
const MODEL_RESERVATION_STATUSES = new Set(["reserved", "dispatched", "settled", "uncertain", "canceled"]);
const JOB_LANES = new Set(["collect", "steer", "follow_up"]);
const JOB_SINGLETON_MODES = new Set(["allow", "cancel", "steer", "reject"]);
const JOB_COMMANDS = new Set(["steer", "follow_up", "abort"]);
const ACTIVE_JOB_STATUSES = new Set(["leased", "running"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "canceled"]);
const MAX_JOB_PAYLOAD_CHARS = 256_000;
const MAX_JOB_RESULT_CHARS = 512_000;
const MAX_WORKSPACES_PER_OWNER = 8;
const MAX_ACTIVE_JOBS_PER_WORKSPACE = 12;
const MAX_JOBS_PER_WORKSPACE_WINDOW = 250;
const WORKSPACE_JOB_WINDOW_MICROS = 24n * 60n * 60n * 1_000_000n;
const NODE_CONTINUITY_STATUSES = new Set(["dormant", "queued", "working", "waiting", "suspended"]);
const NODE_INBOX_CAUSES = new Set(["direct", "task", "schedule", "state", "stream", "operator", "custom"]);
const NODE_COMMITMENT_STATUSES = new Set(["active", "waiting", "completed", "abandoned"]);
const NODE_WAKE_STATUSES = new Set(["scheduled", "queued", "working", "completed", "failed", "canceled"]);
const NODE_CONTINUITY_JOB_AGENT_ID = "roster-node-continuity";
const MAX_NODE_INBOX_ITEM_CHARS = 64_000;
const MAX_NODE_WAKE_RESULT_CHARS = 256_000;

const reject = (message: string): never => {
  throw new SenderError(message);
};

const expectValue = <T>(value: T | null | undefined, message: string): T => {
  if (value === null || value === undefined) throw new SenderError(message);
  return value;
};

const requireText = (name: string, value: string, maxLength: number): string => {
  const normalized = value.trim();
  if (!normalized) reject(`${name} is required`);
  if (normalized.length > maxLength) reject(`${name} exceeds ${maxLength} characters`);
  return normalized;
};

const requireJson = (name: string, value: string, maxLength: number): string => {
  const normalized = requireText(name, value, maxLength);
  try {
    JSON.parse(normalized);
  } catch {
    reject(`${name} must be valid JSON`);
  }
  return normalized;
};

type JsonRecord = { readonly [key: string]: unknown };

const asRecord = (name: string, value: unknown): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(`${name} must be an object`);
  return value as JsonRecord;
};

const asArray = (name: string, value: unknown, maxLength: number): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) reject(`${name} must be an array`);
  const array = value as ReadonlyArray<unknown>;
  if (array.length > maxLength) reject(`${name} exceeds ${maxLength} entries`);
  return array;
};

const recordString = (
  record: JsonRecord,
  key: string,
  maxLength: number,
  allowEmpty = false
): string => {
  const value = record[key];
  if (typeof value !== "string") reject(`${key} must be a string`);
  const normalized = (value as string).trim();
  if (!allowEmpty && !normalized) reject(`${key} is required`);
  if (normalized.length > maxLength) reject(`${key} exceeds ${maxLength} characters`);
  return normalized;
};

const optionalRecordString = (record: JsonRecord, key: string, maxLength: number): string => {
  const value = record[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") reject(`${key} must be a string when present`);
  const text = value as string;
  if (text.length > maxLength) reject(`${key} exceeds ${maxLength} characters`);
  return text.trim();
};

const recordU32 = (record: JsonRecord, key: string, max: number): number => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    reject(`${key} must be an integer between 0 and ${max}`);
  }
  return value as number;
};

const optionalRecordU32 = (record: JsonRecord, key: string, max: number, fallback = 0): number => {
  const value = record[key];
  if (value === undefined || value === null) return fallback;
  return recordU32(record, key, max);
};

const optionalRecordBoolean = (record: JsonRecord, key: string, fallback = false): boolean => {
  const value = record[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") reject(`${key} must be a boolean when present`);
  return value as boolean;
};

const boundedJson = (name: string, value: unknown, maxLength: number): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) reject(`${name} is not JSON serializable`);
  if (encoded.length > maxLength) reject(`${name} exceeds ${maxLength} characters`);
  return encoded;
};

const parseJsonRecord = (name: string, value: string, maxLength: number): JsonRecord => {
  const encoded = requireJson(name, value, maxLength);
  return asRecord(name, JSON.parse(encoded));
};

const identityKey = (identity: Identity): string => identity.toHexString();
const compoundKey = (scope: string, local: string): string => `${scope.length}:${scope}${local}`;
const streamStorageKey = (_ctx: RosterContext, workspaceId: string, streamId: string): string =>
  scopedStreamKey(workspaceId, streamId);
const membershipKey = (runId: string, identity: Identity): string => `${runId}:${identityKey(identity)}`;
const workspaceMembershipKey = (workspaceId: string, identity: Identity): string =>
  compoundKey(workspaceId, identityKey(identity));
const streamReceiptKey = (streamId: string, receiptId: string): string => compoundKey(streamId, receiptId);
const codingRoomKey = (workspaceId: string, roomId: string): string => compoundKey(workspaceId, roomId);
const rosterJobRequestKey = (workspaceId: string, requestId: string): string =>
  compoundKey(workspaceId, requestId);
const rosterJobCommandKey = (workspaceId: string, commandId: string): string =>
  compoundKey(workspaceId, commandId);
const rosterWorkspaceNodeKey = (workspaceId: string, nodeId: string): string =>
  compoundKey(workspaceId, nodeId);
const rosterNodeInboxKey = (nodeKey: string, deliveryId: string): string =>
  compoundKey(nodeKey, deliveryId);
const rosterNodeCommitmentKey = (nodeKey: string, commitmentId: string): string =>
  compoundKey(nodeKey, commitmentId);
const taskKey = (runId: string, taskId: string): string => `${runId}:${taskId}`;
const receiptKey = (runId: string, eventId: string): string => `${runId}:${eventId}`;
const dependencyKey = (dependentTaskKey: string, prerequisiteTaskKey: string): string =>
  compoundKey(dependentTaskKey, prerequisiteTaskKey);
const expansionRecordKey = (parentTaskKey: string, expansionKey: string): string =>
  compoundKey(parentTaskKey, expansionKey);
const workerCapabilityKey = (runId: string, worker: Identity, capability: string): string =>
  compoundKey(compoundKey(runId, identityKey(worker)), capability);
const canvasAgentKey = (runId: string, agentId: string): string => compoundKey(runId, agentId);
const canvasTaskStatusKey = (runId: string, taskId: string): string => compoundKey(runId, taskId);
const sceneReviewKey = (runId: string, eventId: string): string => compoundKey(runId, eventId);
const sceneObjectKey = (patchId: string, objectId: string): string => compoundKey(patchId, objectId);

const CODING_CONVERSATION_STREAM_PREFIX = "agents/coding-agent/runs/";
const CODING_CONVERSATION_SCHEMA = "roster.coding-conversation.v1";
const CODING_CONVERSATION_MESSAGE_KIND = "coding.conversation-message";

type CodingRoomMessageMetadata = {
  readonly conversationId: string;
  readonly codingWorkspaceId: string;
  readonly messageId: string;
  readonly text: string;
};

const codingRoomMessageMetadata = (bodyJson: string): CodingRoomMessageMetadata | undefined => {
  try {
    const bodyValue = JSON.parse(bodyJson) as unknown;
    if (!bodyValue || typeof bodyValue !== "object" || Array.isArray(bodyValue)) return undefined;
    const body = bodyValue as JsonRecord;
    if (body.type !== "artifact.published" || body.kind !== CODING_CONVERSATION_MESSAGE_KIND) {
      return undefined;
    }
    const payloadValue = body.payload;
    if (!payloadValue || typeof payloadValue !== "object" || Array.isArray(payloadValue)) return undefined;
    const payload = payloadValue as JsonRecord;
    if (payload.storage !== "inline" || typeof payload.value !== "string") return undefined;
    const messageValue = JSON.parse(payload.value) as unknown;
    if (!messageValue || typeof messageValue !== "object" || Array.isArray(messageValue)) return undefined;
    const message = messageValue as JsonRecord;
    if (message.schema !== CODING_CONVERSATION_SCHEMA
      || typeof message.conversationId !== "string"
      || typeof message.messageId !== "string"
      || typeof message.text !== "string") return undefined;
    return {
      conversationId: message.conversationId.trim(),
      codingWorkspaceId: typeof message.workspaceId === "string" ? message.workspaceId.trim() : "",
      messageId: message.messageId.trim(),
      text: message.text.trim(),
    };
  } catch {
    return undefined;
  }
};

const codingRoomTitle = (text: string): string =>
  text.replace(/\s+/g, " ").trim().slice(0, 80) || "New conversation";

const expectedCodingRoomId = (conversationId: string): string =>
  `room_repository_${conversationId}`;

const requireRun = (ctx: RosterContext, runId: string) => {
  return expectValue(ctx.db.canvasRun.id.find(runId), `run ${runId} does not exist`);
};

const requireWorkspace = (ctx: RosterContext, workspaceId: string) => expectValue(
  ctx.db.rosterWorkspace.id.find(workspaceId),
  `workspace ${workspaceId} does not exist`
);

const workspaceUsage = (ctx: RosterContext, workspaceId: string) => {
  const existing = ctx.db.rosterWorkspaceUsage.workspaceId.find(workspaceId);
  if (existing) return existing;
  const workspace = requireWorkspace(ctx, workspaceId);
  const jobs = [...ctx.db.rosterJob.workspaceId.filter(workspaceId)];
  const windowFloor = ctx.timestamp.microsSinceUnixEpoch - WORKSPACE_JOB_WINDOW_MICROS;
  return ctx.db.rosterWorkspaceUsage.insert({
    workspaceId,
    owner: workspace.owner,
    windowStartedAt: ctx.timestamp,
    jobsInWindow: jobs.filter((job) =>
      job.createdAt.microsSinceUnixEpoch >= windowFloor).length,
    activeJobs: jobs.filter((job) => !TERMINAL_JOB_STATUSES.has(job.status)).length,
    totalJobs: BigInt(jobs.length),
    updatedAt: ctx.timestamp,
  });
};

const admitWorkspaceJob = (ctx: RosterContext, workspaceId: string): void => {
  const current = workspaceUsage(ctx, workspaceId);
  const windowExpired = (
    ctx.timestamp.microsSinceUnixEpoch - current.windowStartedAt.microsSinceUnixEpoch
  ) >= WORKSPACE_JOB_WINDOW_MICROS;
  const jobsInWindow = windowExpired ? 0 : current.jobsInWindow;
  if (current.activeJobs >= MAX_ACTIVE_JOBS_PER_WORKSPACE) {
    reject(`workspace ${workspaceId} has reached its active job limit`);
  }
  if (jobsInWindow >= MAX_JOBS_PER_WORKSPACE_WINDOW) {
    reject(`workspace ${workspaceId} has reached its 24-hour job limit`);
  }
  ctx.db.rosterWorkspaceUsage.workspaceId.update({
    ...current,
    windowStartedAt: windowExpired ? ctx.timestamp : current.windowStartedAt,
    jobsInWindow: jobsInWindow + 1,
    activeJobs: current.activeJobs + 1,
    totalJobs: current.totalJobs + 1n,
    updatedAt: ctx.timestamp,
  });
};

const releaseWorkspaceJob = (ctx: RosterContext, workspaceId: string): void => {
  const current = workspaceUsage(ctx, workspaceId);
  if (current.activeJobs === 0) reject(`workspace ${workspaceId} active job accounting underflow`);
  ctx.db.rosterWorkspaceUsage.workspaceId.update({
    ...current,
    activeJobs: current.activeJobs - 1,
    updatedAt: ctx.timestamp,
  });
};

const requireWorkspaceMembership = (
  ctx: RosterContext,
  workspaceId: string,
  roles: ReadonlyArray<string>
) => {
  const membership = expectValue(
    ctx.db.rosterWorkspaceMember.id.find(workspaceMembershipKey(workspaceId, ctx.sender)),
    `identity is not a member of workspace ${workspaceId}`
  );
  if (!roles.includes(membership.role)) reject(`identity is not authorized for workspace ${workspaceId}`);
  return membership;
};

type RosterNodeContinuityPolicyRecord = {
  readonly mode: "run" | "workspace";
  readonly policyId: string;
  readonly policyVersion: string;
  readonly wakeAgentId: string;
  readonly memory: "none" | "private";
  readonly maxPendingInboxItems: number;
  readonly maxInboxItemsPerWake: number;
  readonly maxActiveCommitments: number;
  readonly maxCausalDepth: number;
  readonly maxWakesPerWindow: number;
  readonly wakeWindowMs: number;
  readonly minWakeIntervalMs: number;
  readonly json: string;
};

const parseRosterNodeContinuityPolicy = (value: string): RosterNodeContinuityPolicyRecord => {
  const policy = parseJsonRecord("continuityPolicyJson", value, 16_000);
  const modeValue = recordString(policy, "mode", 24);
  if (modeValue !== "run" && modeValue !== "workspace") reject("continuity mode must be run or workspace");
  const mode = modeValue as "run" | "workspace";
  const memoryValue = recordString(policy, "memory", 24);
  if (memoryValue !== "none" && memoryValue !== "private") reject("continuity memory must be none or private");
  const memory = memoryValue as "none" | "private";
  const normalized = {
    mode,
    policyId: requireRosterId("continuity policyId", recordString(policy, "policyId", 160), 160),
    policyVersion: requireRosterVersion("continuity policyVersion", recordString(policy, "policyVersion", 160), 160),
    wakeAgentId: requireRosterId("continuity wakeAgentId", recordString(policy, "wakeAgentId", 160), 160),
    memory,
    maxPendingInboxItems: recordU32(policy, "maxPendingInboxItems", 1_024),
    maxInboxItemsPerWake: recordU32(policy, "maxInboxItemsPerWake", 64),
    maxActiveCommitments: recordU32(policy, "maxActiveCommitments", 256),
    maxCausalDepth: recordU32(policy, "maxCausalDepth", 32),
    maxWakesPerWindow: recordU32(policy, "maxWakesPerWindow", 10_000),
    wakeWindowMs: recordU32(policy, "wakeWindowMs", 30 * 24 * 60 * 60 * 1_000),
    minWakeIntervalMs: recordU32(policy, "minWakeIntervalMs", 24 * 60 * 60 * 1_000),
  };
  if (normalized.maxPendingInboxItems < 1
    || normalized.maxInboxItemsPerWake < 1
    || normalized.maxActiveCommitments < 1
    || normalized.maxWakesPerWindow < 1
    || normalized.wakeWindowMs < 1_000) {
    reject("continuity policy bounds must be positive");
  }
  return { ...normalized, json: canonicalJson("continuity policy", normalized, 16_000) };
};

const requireRosterWorkspaceNode = (ctx: RosterContext, workspaceId: string, nodeId: string) => {
  const node = expectValue(
    ctx.db.rosterWorkspaceNode.id.find(rosterWorkspaceNodeKey(workspaceId, nodeId)),
    `workspace node ${nodeId} does not exist in ${workspaceId}`
  );
  if (node.status !== "active") reject(`workspace node ${nodeId} is ${node.status}`);
  return node;
};

const requireRosterNodeContinuity = (ctx: RosterContext, workspaceId: string, nodeId: string) => {
  const continuity = expectValue(
    ctx.db.rosterNodeContinuity.id.find(rosterWorkspaceNodeKey(workspaceId, nodeId)),
    `workspace node ${nodeId} has no durable continuity`
  );
  if (!NODE_CONTINUITY_STATUSES.has(continuity.status)) reject("node continuity has invalid status");
  return continuity;
};

const appendRosterNodeContinuityEvent = (
  ctx: RosterContext,
  continuity: ReturnType<typeof requireRosterNodeContinuity>,
  kind: string,
  event: JsonRecord
) => {
  const seq = continuity.nextEventSeq + 1n;
  const eventJson = canonicalJson("node continuity event", event, 128_000);
  ctx.db.rosterNodeContinuityEvent.insert({
    id: compoundKey(continuity.id, seq.toString()),
    workspaceId: continuity.workspaceId,
    nodeId: continuity.nodeId,
    seq,
    kind,
    eventJson,
    createdAt: ctx.timestamp,
  });
  const updated = {
    ...continuity,
    nextEventSeq: seq,
    revision: continuity.revision + 1n,
    updatedAt: ctx.timestamp,
  };
  ctx.db.rosterNodeContinuity.id.update(updated);
  return updated;
};

const requireRosterJob = (ctx: RosterContext, workspaceId: string, jobId: string) => {
  const job = expectValue(ctx.db.rosterJob.id.find(jobId), `job ${jobId} does not exist`);
  if (job.workspaceId !== workspaceId) reject(`job ${jobId} belongs to another workspace`);
  return job;
};

const requireActiveRosterJobLease = (
  ctx: RosterContext,
  workspaceId: string,
  jobId: string,
  workerId: string,
  fence: bigint
) => {
  const job = requireRosterJob(ctx, workspaceId, jobId);
  if (!ACTIVE_JOB_STATUSES.has(job.status)) reject(`job ${jobId} has no active lease`);
  if (job.abortRequested) reject(`job ${jobId} has an abort request`);
  if (!job.leaseOwner?.equals(ctx.sender)) reject(`job ${jobId} is leased by another identity`);
  if (job.leaseWorker !== workerId) reject(`job ${jobId} is leased by another worker`);
  if (job.leaseFence !== fence) reject(`job ${jobId} lease fence is stale`);
  if (!job.leaseUntil || job.leaseUntil.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) {
    reject(`job ${jobId} lease expired`);
  }
  return job;
};

const jobLanePriority = (lane: string): number => lane === "steer" ? 0 : lane === "collect" ? 1 : 2;

const insertRosterJobCommand = (
  ctx: RosterContext,
  input: {
    readonly workspaceId: string;
    readonly jobId: string;
    readonly commandId: string;
    readonly command: string;
    readonly payloadJson: string;
    readonly by: string;
  }
) => {
  const id = rosterJobCommandKey(input.workspaceId, input.commandId);
  const lane = input.command === "follow_up" ? "follow_up" : "steer";
  const existing = ctx.db.rosterJobCommand.id.find(id);
  if (existing) {
    if (
      existing.jobId !== input.jobId
      || existing.command !== input.command
      || existing.payloadJson !== input.payloadJson
      || existing.by !== input.by
    ) reject(`job command ${input.commandId} changed after publication`);
    return existing;
  }
  return ctx.db.rosterJobCommand.insert({
    id,
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    command: input.command,
    lane,
    payloadJson: input.payloadJson,
    by: input.by,
    createdAt: ctx.timestamp,
    consumedAt: undefined,
    consumedBy: "",
  });
};

const deferRoomIntentForTerminalJobCommand = (
  ctx: RosterContext,
  workspaceId: string,
  command: ReturnType<typeof insertRosterJobCommand>
): boolean => {
  if (!command.payloadJson || (command.command !== "steer" && command.command !== "follow_up")) return false;
  const payload = asRecord("job command payload", JSON.parse(command.payloadJson));
  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  if (!messageId) return false;
  for (const intent of ctx.db.rosterRoomControlIntent.workspaceId.filter(workspaceId)) {
    if (intent.intentId !== messageId || intent.status !== "pending") continue;
    if (intent.targetRunId) {
      ctx.db.rosterRoomControlIntent.id.update({ ...intent, targetRunId: "" });
    }
    return true;
  }
  return false;
};

const supersedeTerminalRosterJobCommand = (
  ctx: RosterContext,
  workspaceId: string,
  jobId: string,
  command: ReturnType<typeof insertRosterJobCommand>,
  consumerId: string
): void => {
  if (command.consumedAt || command.consumedBy) return;
  const deferredRoomIntent = deferRoomIntentForTerminalJobCommand(ctx, workspaceId, command);
  ctx.db.rosterJobCommand.id.update({
    ...command,
    consumedAt: ctx.timestamp,
    consumedBy: consumerId,
  });
  appendRosterJobEvent(ctx, workspaceId, jobId, "queue.command.superseded", {
    type: "queue.command.superseded",
    jobId,
    commandId: command.id,
    command: command.command,
    reason: "job reached its terminal boundary before command delivery",
    deferredRoomIntent,
  });
};

const appendRosterJobEvent = (
  ctx: RosterContext,
  workspaceId: string,
  jobId: string,
  kind: string,
  event: JsonRecord
) => {
  const job = requireRosterJob(ctx, workspaceId, jobId);
  const eventJson = boundedJson("job event", event, 768_000);
  const seq = job.nextEventSeq + 1n;
  ctx.db.rosterJobEvent.insert({
    id: compoundKey(jobId, seq.toString()),
    workspaceId,
    jobId,
    seq,
    kind,
    eventJson,
    createdAt: ctx.timestamp,
  });
  const updated = { ...job, nextEventSeq: seq, updatedAt: ctx.timestamp };
  ctx.db.rosterJob.id.update(updated);
  return updated;
};

const enqueueRosterNodeWakeJob = (
  ctx: RosterContext,
  wake: {
    readonly id: string;
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly jobId: string;
    readonly manifestJson: string;
  }
): string => {
  const jobId = wake.jobId;
  const node = requireRosterWorkspaceNode(ctx, wake.workspaceId, wake.nodeId);
  const policy = parseRosterNodeContinuityPolicy(node.continuityPolicyJson);
  const existing = ctx.db.rosterJob.id.find(jobId);
  if (existing) {
    if (existing.workspaceId !== wake.workspaceId || existing.agentId !== policy.wakeAgentId) {
      reject(`node wake job ${jobId} changed after dispatch`);
    }
    return jobId;
  }
  admitWorkspaceJob(ctx, wake.workspaceId);
  const payload = {
    schemaVersion: "roster.node-wake-job.v1",
    workspaceId: wake.workspaceId,
    nodeId: wake.nodeId,
    wakeId: wake.id,
    manifest: JSON.parse(wake.manifestJson),
  };
  const payloadJson = boundedJson("node wake job payload", payload, MAX_JOB_PAYLOAD_CHARS);
  const sessionKey = `node-continuity:${wake.workspaceId}:${wake.nodeId}`;
  if (sessionKey.length > 240) reject("node continuity sessionKey exceeds 240 characters");
  ctx.db.rosterJob.insert({
    id: jobId,
    workspaceId: wake.workspaceId,
    agentId: policy.wakeAgentId,
    lane: "collect",
    sessionKey,
    singletonMode: "reject",
    payloadJson,
    status: "queued",
    attempt: 0,
    maxAttempts: 2,
    leaseOwner: undefined,
    leaseWorker: "",
    leaseFence: 0n,
    leaseUntil: undefined,
    claimToken: "",
    availableAt: ctx.timestamp,
    lastError: "",
    resultJson: "",
    canceledReason: "",
    abortRequested: false,
    nextEventSeq: 0n,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  appendRosterJobEvent(ctx, wake.workspaceId, jobId, "job.enqueued", {
    type: "job.enqueued",
    jobId,
    agentId: policy.wakeAgentId,
    lane: "collect",
    payload,
    maxAttempts: 2,
    sessionKey,
    singletonMode: "reject",
    createdAt: Number(ctx.timestamp.microsSinceUnixEpoch / 1_000n),
  });
  return jobId;
};

const ensureRunDetail = (ctx: RosterContext, runId: string) => {
  const existing = ctx.db.canvasRunDetail.runId.find(runId);
  if (existing) return existing;
  return ctx.db.canvasRunDetail.insert({
    runId,
    uiStatus: "planning",
    statusNote: "",
    modelRoutingJson: "{}",
    configJson: "{}",
    workflowId: "",
    workflowVersion: "",
    promptHash: "",
    promptPath: "",
    planVersion: "",
    reviewSceneHash: "",
    reviewVerdict: "",
    qualityStatus: "",
    totalTasks: 0,
    completedTasks: 0,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
};

const requireMembership = (
  ctx: RosterContext,
  runId: string,
  roles: ReadonlyArray<string>
) => {
  const membership = expectValue(
    ctx.db.runMember.id.find(membershipKey(runId, ctx.sender)),
    `identity is not a member of run ${runId}`
  );
  if (!roles.includes(membership.role)) {
    reject(`identity is not authorized for run ${runId}`);
  }
  return membership;
};

const normalizeCapabilities = (capabilitiesJson: string): ReadonlyArray<string> => {
  const encoded = requireJson("capabilitiesJson", capabilitiesJson, 8_000);
  const values = asArray("capabilitiesJson", JSON.parse(encoded), MAX_WORKER_CAPABILITIES);
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") reject("capabilitiesJson entries must be strings");
    const capability = requireText("capability", value as string, 120);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:*-]*$/.test(capability)) {
      reject(`capability ${capability} contains unsafe characters`);
    }
    unique.add(capability);
  }
  return [...unique].sort();
};

const normalizeParticipantProfileSkills = (skillsJson: string): ReadonlyArray<string> => {
  const encoded = requireJson("skillsJson", skillsJson, 8_000);
  const values = asArray("skillsJson", JSON.parse(encoded), 32);
  const unique = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== "string") reject("skillsJson entries must be strings");
    const skill = requireText("skill", value as string, 120);
    if (!unique.has(skill.toLowerCase())) unique.set(skill.toLowerCase(), skill);
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right));
};

const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) result[key] = stableJsonValue(record[key]);
    return result;
  }
  return value;
};

const canonicalJson = (name: string, value: unknown, maxLength: number): string =>
  boundedJson(name, stableJsonValue(value), maxLength);

const requireRosterId = (name: string, value: string, maxLength = 240): string => {
  const id = requireText(name, value, maxLength);
  if (!ROSTER_ID_PATTERN.test(id)) reject(`${name} contains unsafe characters`);
  return id;
};

const requireRosterVersion = (name: string, value: string, maxLength = 240): string => {
  const version = requireText(name, value, maxLength);
  if (/[\u0000-\u001F\u007F]/.test(version)) reject(`${name} contains control characters`);
  return version;
};

type RosterTaskRepositoryPlacement = {
  readonly root: string | null;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly worktree: string | null;
};

const emptyRosterTaskRepositoryPlacement = (): RosterTaskRepositoryPlacement => ({
  root: null,
  branch: null,
  commit: null,
  worktree: null,
});

const parseRosterTaskRepositoryPlacement = (
  name: string,
  value: unknown,
  allowMissing = false
): RosterTaskRepositoryPlacement => {
  if (value === undefined && allowMissing) return emptyRosterTaskRepositoryPlacement();
  const repository = asRecord(name, value);
  const placement = emptyRosterTaskRepositoryPlacement() as {
    root: string | null;
    branch: string | null;
    commit: string | null;
    worktree: string | null;
  };
  for (const field of ["root", "branch", "commit", "worktree"] as const) {
    const candidate = repository[field];
    if (candidate === null) continue;
    if (
      typeof candidate !== "string"
      || !candidate.trim()
      || candidate.length > (field === "root" || field === "worktree" ? 4_096 : 500)
    ) reject(`${name}.${field} must be null or a bounded non-empty string`);
    placement[field] = (candidate as string).trim();
  }
  return placement;
};

const SHA256_INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value: number, count: number): number =>
  (value >>> count) | (value << (32 - count));

/** Keep reducer-side task identities bit-for-bit aligned with core/canonical.ts. */
const rosterSha256 = (value: string): string => {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = BigInt(input.length) * 8n;
  view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffff_ffffn));
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffff_ffffn));

  const hash = new Uint32Array(SHA256_INITIAL);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA256_ROUND[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
};

const rosterHashCanonical = (value: unknown): string =>
  rosterSha256(JSON.stringify(stableJsonValue(value)));

const recordU64 = (record: JsonRecord, key: string, max: bigint): bigint => {
  const value = record[key];
  let parsed = 0n;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) parsed = BigInt(value);
  else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) parsed = BigInt(value);
  else reject(`${key} must be a non-negative safe integer or decimal string`);
  if (parsed > max) reject(`${key} exceeds ${max.toString()}`);
  return parsed;
};

type RosterUsageTotals = {
  readonly actualCostMicros: bigint;
  readonly totalTokens: bigint;
  readonly cachedInputTokens: bigint;
  readonly budgetTokens: bigint;
};

const rosterUsageTotals = (name: string, usage: JsonRecord): RosterUsageTotals => {
  const usageNumber = (key: string): number => {
    const value = usage[key];
    if (value === undefined) return 0;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      reject(`${name}.${key} must be a non-negative number`);
    }
    return value as number;
  };
  const costMicrosNumber = Math.round(usageNumber("costUsd") * 1_000_000);
  if (!Number.isSafeInteger(costMicrosNumber) || costMicrosNumber > Number(MAX_ROSTER_COST_MICROS)) {
    reject(`${name}.costUsd exceeds the platform accounting bound`);
  }
  const explicitTotalTokens = usageNumber("totalTokens");
  const inputTokens = usageNumber("inputTokens");
  const cachedInputTokensNumber = usageNumber("cachedInputTokens");
  if (cachedInputTokensNumber > inputTokens) {
    reject(`${name}.cachedInputTokens cannot exceed inputTokens`);
  }
  const totalTokensNumber = explicitTotalTokens || (
    inputTokens + usageNumber("outputTokens")
  );
  if (
    !Number.isSafeInteger(totalTokensNumber)
    || totalTokensNumber > Number(MAX_ROSTER_TOKENS)
  ) reject(`${name}.totalTokens exceeds the platform accounting bound`);
  return {
    actualCostMicros: BigInt(costMicrosNumber),
    totalTokens: BigInt(totalTokensNumber),
    cachedInputTokens: BigInt(cachedInputTokensNumber),
    budgetTokens: BigInt(totalTokensNumber - cachedInputTokensNumber),
  };
};

type RosterExecutionPolicy = {
  readonly maxTasks: number;
  readonly maxDepth: number;
  readonly maxFanout: number;
  readonly maxInflight: number;
  readonly maxReady: number;
  readonly maxBlocked: number;
  readonly maxAttempts: number;
  readonly maxContextBytes: bigint;
  readonly maxCostMicros: bigint;
  readonly maxTokens: bigint;
  readonly maxWallTimeMs: number;
  readonly json: string;
};

const parseRosterExecutionPolicy = (policyJson: string): RosterExecutionPolicy => {
  const policy = parseJsonRecord("policyJson", policyJson, 32_000);
  const maxTasks = recordU32(policy, "maxTasks", MAX_ROSTER_TASKS);
  const maxDepth = recordU32(policy, "maxDepth", MAX_ROSTER_TASK_DEPTH);
  const maxFanout = recordU32(policy, "maxFanout", MAX_ROSTER_TASK_FANOUT);
  const maxInflight = recordU32(policy, "maxInflight", MAX_ROSTER_INFLIGHT);
  const maxReady = recordU32(policy, "maxReady", MAX_ROSTER_TASKS);
  const maxBlocked = recordU32(policy, "maxBlocked", MAX_ROSTER_TASKS);
  const maxAttempts = recordU32(policy, "maxAttempts", 32);
  const maxWallTimeMs = recordU32(policy, "maxWallTimeMs", MAX_ROSTER_WALL_TIME_MS);
  const maxContextBytes = recordU64(policy, "maxContextBytes", MAX_ROSTER_CONTEXT_BYTES);
  const maxCostMicros = recordU64(policy, "maxCostMicros", MAX_ROSTER_COST_MICROS);
  const maxTokens = recordU64(policy, "maxTokens", MAX_ROSTER_TOKENS);
  if (maxTasks < 1) reject("maxTasks must be positive");
  if (maxFanout < 1) reject("maxFanout must be positive");
  if (maxInflight < 1 || maxInflight > maxTasks) reject("maxInflight must be between 1 and maxTasks");
  if (maxReady < 1 || maxReady > maxTasks) reject("maxReady must be between 1 and maxTasks");
  if (maxBlocked < 1 || maxBlocked > maxTasks) reject("maxBlocked must be between 1 and maxTasks");
  if (maxAttempts < 1) reject("maxAttempts must be positive");
  if (maxContextBytes < 1n || maxWallTimeMs < 1) {
    reject("context and wall-time limits must be positive");
  }
  return {
    maxTasks,
    maxDepth,
    maxFanout,
    maxInflight,
    maxReady,
    maxBlocked,
    maxAttempts,
    maxContextBytes,
    maxCostMicros,
    maxTokens,
    maxWallTimeMs,
    json: canonicalJson("policyJson", policy, 32_000),
  };
};

type RosterTaskDependencySpec = {
  readonly taskId: string;
  readonly condition: "accepted" | "terminal";
};

type RosterTaskDefinitionSpec = {
  readonly taskId: string;
  readonly semanticKey: string;
  readonly definitionHash: string;
  readonly definitionJson: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly objective: string;
  readonly handlerKind: string;
  readonly handlerVersion: string;
  readonly acceptancePolicyId: string;
  readonly acceptancePolicyVersion: string;
  readonly resultJson: string;
  readonly inputManifestJson: string;
  readonly inputVersionsJson: string;
  readonly frontierVersion: string;
  readonly topologyVersion: string;
  readonly catalogVersion: string;
  readonly runtimeBindingEpoch: bigint;
  readonly sideEffect: string;
  readonly estimatedCostMicros: bigint;
  readonly contextBytes: bigint;
  readonly parentTaskId: string;
  readonly dependencies: ReadonlyArray<RosterTaskDependencySpec>;
  readonly joinKind: string;
  readonly joinQuorum: number;
  readonly maxAttempts: number;
  readonly retryInitialBackoffMs: number;
  readonly retryMaximumBackoffMs: number;
  readonly timeoutMs: number;
};

const parseRosterTaskDefinitionValue = (
  name: string,
  value: unknown,
  policy: RosterExecutionPolicy
): RosterTaskDefinitionSpec => {
  const definition = asRecord(name, value);
  if (recordString(definition, "schemaVersion", 80) !== ROSTER_TASK_DEFINITION_VERSION) {
    reject(`${name}.schemaVersion must be ${ROSTER_TASK_DEFINITION_VERSION}`);
  }
  const taskId = requireRosterId(`${name}.taskId`, recordString(definition, "taskId", 160), 160);
  const semanticKey = requireRosterId(
    `${name}.semanticKey`,
    recordString(definition, "semanticKey", 240),
    240
  );
  const nodeId = requireRosterId(`${name}.nodeId`, recordString(definition, "nodeId", 160), 160);
  const capability = requireRosterId(
    `${name}.capability`,
    recordString(definition, "capability", 120),
    120
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:*-]*$/.test(capability)) {
    reject(`${name}.capability contains unsafe characters`);
  }
  const handler = asRecord(`${name}.handler`, definition.handler);
  const acceptance = asRecord(`${name}.acceptance`, definition.acceptance);
  const retry = asRecord(`${name}.retry`, definition.retry);
  const inputs = asRecord(`${name}.inputs`, definition.inputs);
  const join = asRecord(`${name}.join`, definition.join);
  const result = asRecord(`${name}.result`, definition.result);
  const inputVersions = asRecord(`${name}.inputs.inputVersions`, inputs.inputVersions);
  const normalizedInputVersions: Record<string, string> = {};
  const dataReferences = asArray(`${name}.inputs.dataReferences`, inputs.dataReferences, 512);
  for (const [key, version] of Object.entries(inputVersions)) {
    requireRosterId(`${name}.inputs.inputVersions key`, key, 240);
    if (typeof version !== "string" || !version.trim()) reject(`${name}.inputs.inputVersions values must be strings`);
    normalizedInputVersions[key] = requireText(
      `${name}.inputs.inputVersions.${key}`,
      version as string,
      256
    );
  }
  const normalizedDataReferences: JsonRecord[] = [];
  const seenReferences = new Set<string>();
  let referencedContextBytes = 0n;
  for (let index = 0; index < dataReferences.length; index += 1) {
    const reference = asRecord(`${name}.inputs.dataReferences[${index}]`, dataReferences[index]);
    if (recordString(reference, "schemaVersion", 80) !== ROSTER_DATA_REFERENCE_VERSION) {
      reject(`${name}.inputs.dataReferences[${index}].schemaVersion is invalid`);
    }
    const referenceId = requireRosterId(
      `${name}.inputs.dataReferences[${index}].referenceId`,
      recordString(reference, "referenceId", 240),
      240
    );
    if (seenReferences.has(referenceId)) reject(`${name} repeats data reference ${referenceId}`);
    seenReferences.add(referenceId);
    recordString(reference, "contentHash", 256);
    recordString(reference, "mediaType", 160);
    const byteLength = recordU64(reference, "byteLength", MAX_ROSTER_CONTEXT_BYTES);
    const storage = recordString(reference, "storage", 32);
    if (!["ephemeral", "artifact", "object"].includes(storage)) {
      reject(`${name}.inputs.dataReferences[${index}].storage is invalid`);
    }
    if (storage === "artifact") {
      requireRosterId(
        `${name}.inputs.dataReferences[${index}].artifactId`,
        recordString(reference, "artifactId", 240),
        240
      );
    }
    if (storage === "object") {
      recordString(reference, "uri", 2_000);
    }
    referencedContextBytes += byteLength;
    normalizedDataReferences.push(reference);
  }
  normalizedDataReferences.sort((left, right) =>
    recordString(left, "referenceId", 240).localeCompare(recordString(right, "referenceId", 240))
  );
  const rawDependencies = asArray(`${name}.dependencies`, definition.dependencies, policy.maxTasks);
  const dependencies: RosterTaskDependencySpec[] = [];
  const seenDependencies = new Set<string>();
  for (let index = 0; index < rawDependencies.length; index += 1) {
    const dependency = asRecord(`${name}.dependencies[${index}]`, rawDependencies[index]);
    const dependencyTaskId = requireRosterId(
      `${name}.dependencies[${index}].taskId`,
      recordString(dependency, "taskId", 160),
      160
    );
    if (dependencyTaskId === taskId) reject(`task ${taskId} cannot depend on itself`);
    if (seenDependencies.has(dependencyTaskId)) reject(`${name} repeats dependency ${dependencyTaskId}`);
    seenDependencies.add(dependencyTaskId);
    const condition = recordString(dependency, "condition", 32);
    if (condition !== "accepted" && condition !== "terminal") {
      reject(`${name}.dependencies[${index}].condition must be accepted or terminal`);
    }
    dependencies.push({ taskId: dependencyTaskId, condition: condition as "accepted" | "terminal" });
  }
  dependencies.sort((left, right) => left.taskId.localeCompare(right.taskId));
  const joinKind = recordString(join, "kind", 32);
  if (!["all-success", "all-terminal", "any-success", "quorum"].includes(joinKind)) {
    reject(`${name}.join.kind is invalid`);
  }
  const joinQuorum = joinKind === "quorum" ? recordU32(join, "count", policy.maxTasks) : 0;
  if (joinKind === "quorum" && (joinQuorum < 1 || joinQuorum > dependencies.length)) {
    reject(`${name}.join.count must be between 1 and the dependency count`);
  }
  const maxAttempts = recordU32(retry, "maxAttempts", policy.maxAttempts);
  const retryInitialBackoffMs = recordU32(retry, "initialBackoffMs", 3_600_000);
  const retryMaximumBackoffMs = recordU32(retry, "maximumBackoffMs", 86_400_000);
  if (maxAttempts < 1) reject(`${name}.retry.maxAttempts must be positive`);
  if (retryMaximumBackoffMs < retryInitialBackoffMs) {
    reject(`${name}.retry backoff bounds are invalid`);
  }
  const timeoutMs = recordU32(definition, "timeoutMs", 86_400_000);
  if (timeoutMs < 5_000) reject(`${name}.timeoutMs must permit the minimum 5000ms lease`);
  const sideEffect = recordString(definition, "sideEffect", 32);
  if (!["pure", "idempotent", "non-repeatable"].includes(sideEffect)) {
    reject(`${name}.sideEffect is invalid`);
  }
  const handlerKind = requireRosterId(
    `${name}.handler.kind`,
    recordString(handler, "kind", 160),
    160
  );
  const handlerVersion = recordString(handler, "version", 120);
  const acceptancePolicyId = requireRosterId(
    `${name}.acceptance.policyId`,
    recordString(acceptance, "policyId", 160),
    160
  );
  const acceptancePolicyVersion = recordString(acceptance, "policyVersion", 120);
  const resultMode = recordString(result, "mode", 32);
  if (resultMode === "text" || resultMode === "json") {
    requireRosterId(`${name}.result.outputKey`, recordString(result, "outputKey", 240), 240);
    if (resultMode === "json" && !Object.prototype.hasOwnProperty.call(result, "schema")) {
      reject(`${name}.result.schema is required for json output`);
    }
  } else if (resultMode === "artifact") {
    requireRosterId(`${name}.result.outputKey`, recordString(result, "outputKey", 240), 240);
    requireRosterId(`${name}.result.artifactKind`, recordString(result, "artifactKind", 160), 160);
    if (result.mediaType !== undefined) recordString(result, "mediaType", 200);
  } else if (resultMode !== "none") {
    reject(`${name}.result.mode is invalid`);
  }
  const objective = recordString(definition, "objective", 16_000);
  const frontierVersion = recordString(inputs, "frontierVersion", 200);
  const topologyVersion = recordString(inputs, "topologyVersion", 200);
  const catalogVersion = recordString(inputs, "catalogVersion", 200);
  const runtimeBindingEpoch = recordU64(definition, "runtimeBindingEpoch", 9_007_199_254_740_991n);
  const estimatedCostMicros = recordU64(definition, "estimatedCostMicros", policy.maxCostMicros);
  const parentTaskId = optionalRecordString(definition, "parentTaskId", 160);
  if (parentTaskId) requireRosterId(`${name}.parentTaskId`, parentTaskId, 160);
  const normalizedInputs = {
    inputVersions: Object.fromEntries(
      Object.entries(normalizedInputVersions).sort(([left], [right]) => left.localeCompare(right))
    ),
    dataReferences: normalizedDataReferences,
    frontierVersion,
    topologyVersion,
    catalogVersion,
  };
  const normalizedWithoutHash = {
    schemaVersion: ROSTER_TASK_DEFINITION_VERSION,
    taskId,
    semanticKey,
    nodeId,
    capability,
    objective,
    handler: { kind: handlerKind, version: handlerVersion },
    acceptance: { policyId: acceptancePolicyId, policyVersion: acceptancePolicyVersion },
    result,
    dependencies,
    join,
    inputs: normalizedInputs,
    runtimeBindingEpoch: Number(runtimeBindingEpoch),
    retry: {
      maxAttempts,
      initialBackoffMs: retryInitialBackoffMs,
      maximumBackoffMs: retryMaximumBackoffMs,
    },
    timeoutMs,
    sideEffect,
    estimatedCostMicros: Number(estimatedCostMicros),
    ...(parentTaskId ? { parentTaskId } : {}),
  };
  const definitionHash = recordString(definition, "definitionHash", 64);
  if (!/^[0-9a-f]{64}$/.test(definitionHash)) {
    reject(`${name}.definitionHash must be a lowercase SHA-256 hex digest`);
  }
  if (definitionHash !== rosterHashCanonical(normalizedWithoutHash)) {
    reject(`${name}.definitionHash does not match the canonical definition`);
  }
  const normalizedDefinition = { ...normalizedWithoutHash, definitionHash };
  const definitionJson = canonicalJson(name, normalizedDefinition, 384_000);
  const inputManifestJson = canonicalJson(`${name}.inputs`, normalizedInputs, 256_000);
  return {
    taskId,
    semanticKey,
    definitionHash,
    definitionJson,
    nodeId,
    capability,
    objective,
    handlerKind,
    handlerVersion,
    acceptancePolicyId,
    acceptancePolicyVersion,
    resultJson: canonicalJson(`${name}.result`, result, 16_000),
    inputManifestJson,
    inputVersionsJson: canonicalJson(
      `${name}.inputs.inputVersions`,
      normalizedInputs.inputVersions,
      128_000
    ),
    frontierVersion,
    topologyVersion,
    catalogVersion,
    runtimeBindingEpoch,
    sideEffect,
    estimatedCostMicros,
    contextBytes: BigInt(definitionJson.length) + referencedContextBytes,
    parentTaskId,
    dependencies,
    joinKind,
    joinQuorum,
    maxAttempts,
    retryInitialBackoffMs,
    retryMaximumBackoffMs,
    timeoutMs,
  };
};

const parseRosterTaskDefinition = (
  name: string,
  definitionJson: string,
  policy: RosterExecutionPolicy
): RosterTaskDefinitionSpec => {
  const encoded = requireJson(name, definitionJson, 384_000);
  return parseRosterTaskDefinitionValue(name, JSON.parse(encoded), policy);
};

const rosterTaskKey = (runId: string, taskId: string): string => compoundKey(runId, taskId);
const rosterSemanticKey = (runId: string, semanticKey: string): string => compoundKey(runId, semanticKey);

const requireRosterExecution = (ctx: RosterContext, runId: string) => expectValue(
  ctx.db.rosterExecution.runId.find(runId),
  `Roster execution ${runId} does not exist`
);

const requireActiveRosterExecution = (ctx: RosterContext, runId: string) => {
  const execution = requireRosterExecution(ctx, runId);
  if (TERMINAL_ROSTER_EXECUTION_STATUSES.has(execution.status)) {
    reject(`Roster execution ${runId} is terminal`);
  }
  if (execution.deadlineAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) {
    reject(`Roster execution ${runId} exceeded its wall-time limit`);
  }
  requireWorkspaceMembership(ctx, execution.workspaceId, ["owner", "coordinator", "worker"]);
  return execution;
};

const requireRosterCoordinator = (ctx: RosterContext, execution: ReturnType<typeof requireRosterExecution>) =>
  requireWorkspaceMembership(ctx, execution.workspaceId, ["owner", "coordinator"]);

const ensureRosterRunCoordinatorMembership = (
  ctx: RosterContext,
  execution: ReturnType<typeof requireRosterExecution>
) => {
  const workspaceMembership = requireRosterCoordinator(ctx, execution);
  const id = membershipKey(execution.runId, ctx.sender);
  const role = workspaceMembership.role === "owner" ? "owner" : "coordinator";
  const existing = ctx.db.runMember.id.find(id);
  if (!existing) {
    return ctx.db.runMember.insert({
      id,
      runId: execution.runId,
      member: ctx.sender,
      role,
      createdAt: ctx.timestamp,
    });
  }
  if (existing.role === "viewer") {
    return ctx.db.runMember.id.update({ ...existing, role });
  }
  return existing;
};

const requireRosterTask = (ctx: RosterContext, runId: string, taskId: string) => expectValue(
  ctx.db.rosterTaskDefinition.id.find(rosterTaskKey(runId, taskId)),
  `Roster task ${taskId} does not exist in execution ${runId}`
);

const rosterWorkerCanRunTask = (
  ctx: RosterContext,
  runId: string,
  workspaceRole: string,
  capability: string
): boolean => {
  if (workspaceRole === "owner") return true;
  return Boolean(
    ctx.db.rosterWorkerCapability.id.find(workerCapabilityKey(runId, ctx.sender, "*"))
    || ctx.db.rosterWorkerCapability.id.find(workerCapabilityKey(runId, ctx.sender, capability))
  );
};

const appendRosterExecutionEvent = (
  ctx: RosterContext,
  runId: string,
  kind: string,
  nodeId: string,
  payload: JsonRecord
): void => {
  const execution = requireRosterExecution(ctx, runId);
  const seq = execution.nextEventSeq + 1n;
  ctx.db.rosterExecutionEvent.insert({
    id: compoundKey(runId, seq.toString()),
    runId,
    seq,
    kind,
    actor: ctx.sender,
    nodeId,
    payloadJson: canonicalJson("Roster execution event", payload, 128_000),
    createdAt: ctx.timestamp,
  });
  ctx.db.rosterExecution.runId.update({ ...execution, nextEventSeq: seq, updatedAt: ctx.timestamp });
};

const roomForRun = (rooms: Iterable<RosterRoomRow>): RosterRoomRow | undefined => {
  for (const room of rooms) return room;
  return undefined;
};

const requireRosterRoom = (ctx: RosterContext, workspaceId: string, roomId: string) => {
  const room = expectValue(ctx.db.rosterRoom.id.find(roomId), `Roster room ${roomId} does not exist`);
  if (room.workspaceId !== workspaceId) reject(`Roster room ${roomId} belongs to another workspace`);
  return room;
};

const latestRosterRuntimeBindingEpoch = (
  ctx: RosterContext,
  runId: string,
  nodeId: string
): bigint => {
  let latest = 0n;
  for (const binding of ctx.db.rosterRuntimeBinding.runId.filter(runId)) {
    if (binding.nodeId === nodeId && binding.epoch > latest) latest = binding.epoch;
  }
  return latest;
};

const appendRoomTimelineEntry = (
  ctx: RosterContext,
  runId: string,
  kind: string,
  taskId: string,
  nodeId: string,
  entry: JsonRecord
): void => {
  if (!ROOM_TIMELINE_KINDS.has(kind)) reject(`Room timeline kind ${kind} is invalid`);
  const execution = requireRosterExecution(ctx, runId);
  const room = roomForRun(ctx.db.rosterRoom.activeRunId.filter(runId));
  if (!room) return;
  const seq = room.nextTimelineSeq + 1n;
  ctx.db.rosterRoomTimelineEntry.insert({
    id: compoundKey(room.id, seq.toString()),
    workspaceId: execution.workspaceId,
    roomId: room.id,
    runId,
    seq,
    kind,
    taskId,
    nodeId,
    entryJson: canonicalJson("Room timeline entry", entry, MAX_ROOM_TIMELINE_ENTRY_CHARS),
    createdAt: ctx.timestamp,
  });
  ctx.db.rosterRoom.id.update({ ...room, nextTimelineSeq: seq, updatedAt: ctx.timestamp });
};

const peerConversationKind = (
  outputKey: string,
  task: { readonly taskId: string; readonly capability: string }
): string => {
  if (
    task.capability === "room"
    && task.taskId.startsWith("announce-")
    && outputKey.startsWith("room_announcement_")
  ) return "announcement";
  if (task.capability === "synthesize" && outputKey === "coding_final_answer") {
    return "final-result";
  }
  if (
    task.taskId === "coding-finalize"
    && (outputKey === "coding_result" || outputKey === "final_report")
  ) return "final-result";
  if (outputKey.startsWith("collaboration_proposal_")) return "proposal";
  if (outputKey.startsWith("collaboration_response_")) return "response";
  if (outputKey === "collaboration_resolution") return "resolution";
  if (outputKey.startsWith("collaboration_endorsement_")) return "endorsement";
  if (
    task.capability === "implement"
    && (outputKey === "implementation_report" || outputKey === "final_report")
  ) {
    return "implementation";
  }
  if (/review|certif/iu.test(task.capability)
    && (outputKey === "review_report" || /^review_.+_report$/u.test(outputKey))) {
    return "review-report";
  }
  if (task.capability === "remediate" && outputKey === "final_report") return "remediation";
  if (
    task.capability === "investigate"
    && outputKey.startsWith("investigation_")
    && outputKey.endsWith("_report")
  ) return "investigation-report";
  if (
    task.capability === "investigate"
    && task.taskId === "synthesize-investigation"
    && outputKey === "final_report"
  ) return "investigation-synthesis";
  return "";
};

const appendAcceptedPeerConversation = (
  ctx: RosterContext,
  runId: string,
  task: {
    readonly id: string;
    readonly taskId: string;
    readonly nodeId: string;
    readonly capability: string;
  },
  artifact: JsonRecord
): void => {
  const outputKey = recordString(artifact, "outputKey", 240);
  const turnKind = peerConversationKind(outputKey, task);
  const text = optionalRecordString(artifact, "presentationText", 1_600);
  if (!turnKind || !text) return;

  const upstream = [...ctx.db.rosterTaskEdge.taskKey.filter(task.id)]
    .flatMap((edge) => {
      const candidate = ctx.db.rosterTaskDefinition.id.find(edge.prerequisiteTaskKey);
      return candidate ? [candidate] : [];
    });
  const downstream = [...ctx.db.rosterTaskEdge.prerequisiteTaskKey.filter(task.id)]
    .flatMap((edge) => {
      const candidate = ctx.db.rosterTaskDefinition.id.find(edge.taskKey);
      return candidate ? [candidate] : [];
    });
  const siblingInvestigators = turnKind === "investigation-report"
    ? downstream.flatMap((dependent) => [...ctx.db.rosterTaskEdge.taskKey.filter(dependent.id)]
        .flatMap((edge) => {
          const candidate = ctx.db.rosterTaskDefinition.id.find(edge.prerequisiteTaskKey);
          return candidate && candidate.id !== task.id && candidate.capability === "investigate"
            ? [candidate]
            : [];
        }))
    : [];
  const downstreamFirst = downstream.length > 0 ? downstream : upstream;
  const preferred = turnKind === "response"
      || turnKind === "endorsement"
      || turnKind === "investigation-synthesis"
    ? upstream
    : turnKind === "investigation-report" && !downstream.some((candidate) =>
        candidate.nodeId !== task.nodeId && candidate.nodeId !== "coordinator")
      ? siblingInvestigators
      : downstreamFirst;
  const narrowed = turnKind === "proposal"
    ? preferred.filter((candidate) => candidate.capability === "respond")
    : turnKind === "resolution"
      ? preferred.filter((candidate) => candidate.capability === "implement")
      : preferred;
  const recipientNodeIds = turnKind === "announcement"
    ? ["human.operator"]
    : [...new Set((narrowed.length > 0 ? narrowed : preferred)
        .map((candidate) => candidate.nodeId)
        .filter((nodeId) => nodeId && nodeId !== task.nodeId && nodeId !== "coordinator"))]
      .slice(0, 6);
  const roomNodes = [...ctx.db.rosterRoomNode.runId.filter(runId)];
  const nameFor = (nodeId: string): string => {
    const fullName = roomNodes.find((candidate) => candidate.nodeId === nodeId)?.name ?? nodeId;
    return fullName.split(",", 1)[0]?.trim() || fullName;
  };
  const artifactId = recordString(artifact, "artifactId", 240);
  const messageId = `coding_peer_${artifactId}`;
  const finalResult = turnKind === "final-result";
  appendRoomTimelineEntry(ctx, runId, "message", task.taskId, task.nodeId, {
    type: "message",
    intentId: messageId,
    artifactId,
    outputKey,
    payload: {
      message: {
        messageId,
        text,
        author: {
          id: task.nodeId,
          name: finalResult ? "Roster" : nameFor(task.nodeId),
          kind: finalResult ? "system" : "agent",
        },
        source: { externalId: artifactId },
        tags: [
          "protocol:agent-turn",
          `turn:${turnKind}`,
          "routing:node",
          ...(turnKind === "response" || turnKind === "investigation-synthesis" || finalResult ? ["thread:reply"] : []),
        ],
        mentions: finalResult || turnKind === "announcement" || turnKind === "investigation-synthesis"
          ? ["You"]
          : recipientNodeIds.map(nameFor),
        attachments: [],
      },
    },
  });
};

const appendProjectionOutbox = (
  ctx: RosterContext,
  runId: string,
  kind: string,
  idempotencyKey: string,
  payload: JsonRecord
): void => {
  const execution = requireRosterExecution(ctx, runId);
  const room = roomForRun(ctx.db.rosterRoom.activeRunId.filter(runId));
  if (!room) return;
  const id = compoundKey(runId, idempotencyKey);
  const payloadJson = canonicalJson("Projection outbox payload", payload, 256_000);
  const existing = ctx.db.rosterProjectionOutbox.id.find(id);
  if (existing) {
    if (existing.kind !== kind || existing.payloadJson !== payloadJson) {
      reject(`Projection outbox ${idempotencyKey} changed after publication`);
    }
    return;
  }
  ctx.db.rosterProjectionOutbox.insert({
    id,
    workspaceId: execution.workspaceId,
    roomId: room.id,
    runId,
    kind,
    payloadJson,
    status: "pending",
    attempt: 0,
    lastError: "",
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
};

const settleTaskModelReservation = (
  ctx: RosterContext,
  task: ReturnType<typeof requireRosterTask>,
  fence: bigint,
  actualCostMicros: bigint,
  actualTokens: bigint,
  status: "settled" | "canceled"
): void => {
  const id = compoundKey(task.id, fence.toString());
  const reservation = ctx.db.rosterModelReservation.id.find(id);
  if (!reservation) return;
  if (reservation.status === status) {
    if (reservation.actualCostMicros !== actualCostMicros || reservation.actualTokens !== actualTokens) {
      reject(`Model reservation ${id} settlement changed`);
    }
    return;
  }
  if (!MODEL_RESERVATION_STATUSES.has(reservation.status)) reject(`Model reservation ${id} has invalid state`);
  if (reservation.status === "uncertain") reject(`Model reservation ${id} is uncertain and requires reconciliation`);
  if (reservation.status !== "reserved" && reservation.status !== "dispatched") {
    reject(`Model reservation ${id} cannot be settled from ${reservation.status}`);
  }
  ctx.db.rosterModelReservation.id.update({
    ...reservation,
    status,
    actualCostMicros,
    actualTokens,
    updatedAt: ctx.timestamp,
  });
};

const refreshRosterExecution = (ctx: RosterContext, runId: string): void => {
  const execution = requireRosterExecution(ctx, runId);
  let totalTasks = 0;
  let readyTasks = 0;
  let blockedTasks = 0;
  let inflightTasks = 0;
  let acceptedTasks = 0;
  let failedTasks = 0;
  let delegatedTasks = 0;
  let canceledTasks = 0;
  let skippedTasks = 0;
  for (const task of ctx.db.rosterTaskDefinition.runId.filter(runId)) {
    totalTasks += 1;
    if (task.status === "ready") readyTasks += 1;
    else if (task.status === "blocked" || task.status === "retry_wait") blockedTasks += 1;
    else if (ACTIVE_ROSTER_TASK_STATUSES.has(task.status)) inflightTasks += 1;
    else if (task.status === "accepted") acceptedTasks += 1;
    else if (task.status === "failed") failedTasks += 1;
    else if (task.status === "delegated") delegatedTasks += 1;
    else if (task.status === "canceled") canceledTasks += 1;
    else if (task.status === "skipped") skippedTasks += 1;
  }
  const hasWork = readyTasks + blockedTasks + inflightTasks > 0;
  const status = TERMINAL_ROSTER_EXECUTION_STATUSES.has(execution.status)
    ? execution.status
    : hasWork ? "running" : totalTasks > 0 ? "quiescent" : "queued";
  ctx.db.rosterExecution.runId.update({
    ...execution,
    status,
    totalTasks,
    readyTasks,
    blockedTasks,
    inflightTasks,
    acceptedTasks,
    failedTasks,
    delegatedTasks,
    canceledTasks,
    skippedTasks,
    updatedAt: ctx.timestamp,
  });
};

const rosterTaskJoinDisposition = (
  ctx: RosterContext,
  taskKeyValue: string
): "ready" | "blocked" | "skipped" => {
  const join = expectValue(ctx.db.rosterTaskJoin.taskKey.find(taskKeyValue), "Roster task join is missing");
  if (join.totalDependencies === 0) return "ready";
  let satisfied = 0;
  let terminal = 0;
  for (const edge of ctx.db.rosterTaskEdge.taskKey.filter(taskKeyValue)) {
    const declaredPrerequisite = expectValue(
      ctx.db.rosterTaskDefinition.id.find(edge.prerequisiteTaskKey),
      "Roster task dependency is missing"
    );
    const prerequisite = effectiveRosterTask(ctx, declaredPrerequisite.runId, declaredPrerequisite);
    const isTerminal = TERMINAL_ROSTER_TASK_STATUSES.has(prerequisite.status);
    if (isTerminal) terminal += 1;
    if (
      (edge.condition === "accepted" && prerequisite.status === "accepted")
      || (edge.condition === "terminal" && isTerminal)
    ) satisfied += 1;
  }
  if (join.kind === "all-success") {
    if (satisfied === join.totalDependencies) return "ready";
    return terminal === join.totalDependencies ? "skipped" : "blocked";
  }
  if (join.kind === "all-terminal") {
    return terminal === join.totalDependencies ? "ready" : "blocked";
  }
  if (join.kind === "any-success") {
    if (satisfied > 0) return "ready";
    return terminal === join.totalDependencies ? "skipped" : "blocked";
  }
  if (join.kind !== "quorum") reject(`Roster task join kind ${join.kind} is invalid`);
  if (satisfied >= join.quorum) return "ready";
  return satisfied + (join.totalDependencies - terminal) < join.quorum ? "skipped" : "blocked";
};

/**
 * Delegation keeps the original task as provenance while its continuation is
 * the effective prerequisite for already-admitted downstream work. The scan is
 * bounded by the execution task limit and rejects corrupted continuation
 * cycles instead of choosing a winner by arrival order.
 */
const effectiveRosterTask = (
  ctx: RosterContext,
  runId: string,
  initial: ReturnType<typeof requireRosterTask>
): ReturnType<typeof requireRosterTask> => {
  const seen = new Set<string>();
  let current = initial;
  while (true) {
    if (seen.has(current.taskId)) reject(`Roster continuation cycle at ${current.taskId}`);
    seen.add(current.taskId);
    const expansion = [...ctx.db.rosterTaskExpansion.runId.filter(runId)]
      .find((candidate) => candidate.parentTaskKey === current.id);
    if (!expansion) return current;
    current = requireRosterTask(ctx, runId, expansion.continuationTaskId);
  }
};

const propagateRosterTerminalDisposition = (
  ctx: RosterContext,
  runId: string,
  initialTaskKey: string
): void => {
  const policy = parseRosterExecutionPolicy(requireRosterExecution(ctx, runId).policyJson);
  const pending = [initialTaskKey];
  const seen = new Set<string>();
  let readyCount = 0;
  for (const task of ctx.db.rosterTaskDefinition.runId.filter(runId)) {
    if (task.status === "ready") readyCount += 1;
  }
  while (pending.length > 0) {
    const prerequisiteTaskKey = pending.shift()!;
    if (seen.has(prerequisiteTaskKey)) continue;
    seen.add(prerequisiteTaskKey);
    const prerequisite = expectValue(
      ctx.db.rosterTaskDefinition.id.find(prerequisiteTaskKey),
      "terminal Roster task is missing"
    );
    const effectivePrerequisite = effectiveRosterTask(ctx, runId, prerequisite);
    for (const edge of ctx.db.rosterTaskEdge.prerequisiteTaskKey.filter(prerequisiteTaskKey)) {
      const dependent = expectValue(ctx.db.rosterTaskDefinition.id.find(edge.taskKey), "dependent task is missing");
      const join = expectValue(ctx.db.rosterTaskJoin.taskKey.find(edge.taskKey), "dependent join is missing");
      const updatedJoin = {
        ...join,
        acceptedDependencies: join.acceptedDependencies + (effectivePrerequisite.status === "accepted" ? 1 : 0),
        terminalDependencies: join.terminalDependencies + 1,
        updatedAt: ctx.timestamp,
      };
      ctx.db.rosterTaskJoin.taskKey.update(updatedJoin);
      if (dependent.status !== "blocked") continue;
      const disposition = rosterTaskJoinDisposition(ctx, dependent.id);
      if (disposition === "ready") {
        if (readyCount < policy.maxReady) {
          ctx.db.rosterTaskDefinition.id.update({ ...dependent, status: "ready", updatedAt: ctx.timestamp });
          appendRoomTimelineEntry(ctx, runId, "handoff", dependent.taskId, dependent.nodeId, {
            type: "handoff",
            fromTaskId: effectivePrerequisite.taskId,
            toTaskId: dependent.taskId,
            acceptedOutcomeId: effectivePrerequisite.outcomeId,
          });
          readyCount += 1;
        }
      } else if (disposition === "skipped") {
        ctx.db.rosterTaskDefinition.id.update({
          ...dependent,
          status: "skipped",
          lastError: "join became impossible after prerequisite terminal disposition",
          updatedAt: ctx.timestamp,
        });
        pending.push(dependent.id);
      }
    }
    for (const expansion of ctx.db.rosterTaskExpansion.runId.filter(runId)) {
      if (expansion.continuationTaskId !== prerequisite.taskId) continue;
      const parent = expectValue(
        ctx.db.rosterTaskDefinition.id.find(expansion.parentTaskKey),
        "delegated Roster parent task is missing"
      );
      if (parent.status !== "delegated") continue;
      ctx.db.rosterTaskDefinition.id.update({
        ...parent,
        status: "skipped",
        lastError: `continued by ${prerequisite.taskId} (${prerequisite.status})`,
        updatedAt: ctx.timestamp,
      });
      pending.push(parent.id);
    }
  }
};

/**
 * Reconciles delegated parents created before continuation settlement became
 * reducer-owned. New outcomes settle through propagateRosterTerminalDisposition;
 * this bounded scan is also the explicit repair path for durable executions
 * that were already quiescent when the invariant was introduced.
 */
const settleCompletedRosterDelegations = (ctx: RosterContext, runId: string): number => {
  let settled = 0;
  for (const expansion of ctx.db.rosterTaskExpansion.runId.filter(runId)) {
    const parent = expectValue(
      ctx.db.rosterTaskDefinition.id.find(expansion.parentTaskKey),
      "delegated Roster parent task is missing"
    );
    if (parent.status !== "delegated") continue;
    const continuation = requireRosterTask(ctx, runId, expansion.continuationTaskId);
    if (!TERMINAL_ROSTER_TASK_STATUSES.has(continuation.status)) continue;
    ctx.db.rosterTaskDefinition.id.update({
      ...parent,
      status: "skipped",
      lastError: `continued by ${continuation.taskId} (${continuation.status})`,
      updatedAt: ctx.timestamp,
    });
    settled += 1;
    propagateRosterTerminalDisposition(ctx, runId, parent.id);
  }
  return settled;
};

const promoteEligibleBlockedRosterTasks = (ctx: RosterContext, runId: string): void => {
  const policy = parseRosterExecutionPolicy(requireRosterExecution(ctx, runId).policyJson);
  const blocked = [...ctx.db.rosterTaskDefinition.runId.filter(runId)]
    .filter((task) => task.status === "blocked")
    .sort((left, right) => left.semanticKey.localeCompare(right.semanticKey));
  let ready = 0;
  for (const task of ctx.db.rosterTaskDefinition.runId.filter(runId)) {
    if (task.status === "ready") ready += 1;
  }
  for (const task of blocked) {
    if (ready >= policy.maxReady) break;
    const disposition = rosterTaskJoinDisposition(ctx, task.id);
    if (disposition === "ready") {
      ctx.db.rosterTaskDefinition.id.update({ ...task, status: "ready", updatedAt: ctx.timestamp });
      ready += 1;
    }
  }
};

const requireActiveRosterTaskLease = (
  ctx: RosterContext,
  runId: string,
  taskId: string,
  fence: bigint
) => {
  requireActiveRosterExecution(ctx, runId);
  const task = requireRosterTask(ctx, runId, taskId);
  if (!ACTIVE_ROSTER_TASK_STATUSES.has(task.status)) reject(`Roster task ${taskId} has no active lease`);
  if (!task.leaseOwner?.equals(ctx.sender)) reject(`Roster task ${taskId} is leased by another identity`);
  if (task.leaseFence !== fence) reject(`Roster task ${taskId} has a stale lease fence`);
  if (!task.leaseUntil || task.leaseUntil.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) {
    reject(`Roster task ${taskId} lease expired`);
  }
  return task;
};

const insertRosterTaskDefinition = (
  ctx: RosterContext,
  execution: ReturnType<typeof requireRosterExecution>,
  policy: RosterExecutionPolicy,
  spec: RosterTaskDefinitionSpec,
  depth: number
): void => {
  const latestExecution = requireRosterExecution(ctx, execution.runId);
  if (depth > policy.maxDepth) reject(`task ${spec.taskId} exceeds maxDepth`);
  if (latestExecution.totalTasks + 1 > policy.maxTasks) reject(`execution ${execution.runId} reached maxTasks`);
  if (latestExecution.contextBytes + spec.contextBytes > policy.maxContextBytes) {
    reject(`execution ${execution.runId} reached maxContextBytes`);
  }
  const id = rosterTaskKey(execution.runId, spec.taskId);
  if (ctx.db.rosterTaskDefinition.id.find(id)) reject(`task ${spec.taskId} already exists`);
  const semanticId = rosterSemanticKey(execution.runId, spec.semanticKey);
  if (ctx.db.rosterTaskSemanticKey.id.find(semanticId)) {
    reject(`semantic key ${spec.semanticKey} already exists in execution ${execution.runId}`);
  }
  for (const dependency of spec.dependencies) {
    if (!ctx.db.rosterTaskDefinition.id.find(rosterTaskKey(execution.runId, dependency.taskId))) {
      reject(`dependency task ${dependency.taskId} does not exist`);
    }
  }
  let acceptedDependencies = 0;
  let terminalDependencies = 0;
  let satisfiedDependencies = 0;
  for (const dependency of spec.dependencies) {
    const prerequisite = effectiveRosterTask(
      ctx,
      execution.runId,
      requireRosterTask(ctx, execution.runId, dependency.taskId)
    );
    const terminal = TERMINAL_ROSTER_TASK_STATUSES.has(prerequisite.status);
    if (prerequisite.status === "accepted") acceptedDependencies += 1;
    if (terminal) terminalDependencies += 1;
    if (
      (dependency.condition === "accepted" && prerequisite.status === "accepted")
      || (dependency.condition === "terminal" && terminal)
    ) satisfiedDependencies += 1;
  }
  let initialStatus = "blocked";
  if (spec.dependencies.length === 0) initialStatus = "ready";
  else if (
    (spec.joinKind === "all-success" && satisfiedDependencies === spec.dependencies.length)
    || (spec.joinKind === "all-terminal" && terminalDependencies === spec.dependencies.length)
    || (spec.joinKind === "any-success" && satisfiedDependencies > 0)
    || (spec.joinKind === "quorum" && satisfiedDependencies >= spec.joinQuorum)
  ) initialStatus = "ready";
  else if (
    (spec.joinKind === "all-success" && terminalDependencies === spec.dependencies.length)
    || (spec.joinKind === "any-success" && terminalDependencies === spec.dependencies.length)
    || (
      spec.joinKind === "quorum"
      && satisfiedDependencies + (spec.dependencies.length - terminalDependencies) < spec.joinQuorum
    )
  ) initialStatus = "skipped";
  if (initialStatus === "ready" && latestExecution.readyTasks + 1 > policy.maxReady) reject("maxReady exceeded");
  if (initialStatus === "blocked" && latestExecution.blockedTasks + 1 > policy.maxBlocked) reject("maxBlocked exceeded");
  ctx.db.rosterTaskDefinition.insert({
    id,
    runId: execution.runId,
    taskId: spec.taskId,
    semanticKey: spec.semanticKey,
    definitionHash: spec.definitionHash,
    definitionJson: spec.definitionJson,
    nodeId: spec.nodeId,
    capability: spec.capability,
    objective: spec.objective,
    handlerKind: spec.handlerKind,
    handlerVersion: spec.handlerVersion,
    acceptancePolicyId: spec.acceptancePolicyId,
    acceptancePolicyVersion: spec.acceptancePolicyVersion,
    resultJson: spec.resultJson,
    inputManifestJson: spec.inputManifestJson,
    frontierVersion: spec.frontierVersion,
    topologyVersion: spec.topologyVersion,
    catalogVersion: spec.catalogVersion,
    runtimeBindingEpoch: spec.runtimeBindingEpoch,
    sideEffect: spec.sideEffect,
    estimatedCostMicros: spec.estimatedCostMicros,
    contextBytes: spec.contextBytes,
    parentTaskId: spec.parentTaskId,
    depth,
    status: initialStatus,
    attempt: 0,
    maxAttempts: spec.maxAttempts,
    retryInitialBackoffMs: spec.retryInitialBackoffMs,
    retryMaximumBackoffMs: spec.retryMaximumBackoffMs,
    timeoutMs: spec.timeoutMs,
    availableAt: ctx.timestamp,
    leaseOwner: undefined,
    leaseFence: 0n,
    leaseUntil: undefined,
    lastError: "",
    outcomeId: "",
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  ctx.db.rosterTaskSemanticKey.insert({
    id: semanticId,
    runId: execution.runId,
    semanticKey: spec.semanticKey,
    taskKey: id,
    createdAt: ctx.timestamp,
  });
  ctx.db.rosterTaskJoin.insert({
    taskKey: id,
    runId: execution.runId,
    kind: spec.joinKind,
    quorum: spec.joinQuorum,
    totalDependencies: spec.dependencies.length,
    acceptedDependencies,
    terminalDependencies,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  for (const dependency of spec.dependencies) {
    const prerequisiteTaskKey = rosterTaskKey(execution.runId, dependency.taskId);
    ctx.db.rosterTaskEdge.insert({
      id: dependencyKey(id, prerequisiteTaskKey),
      runId: execution.runId,
      taskKey: id,
      prerequisiteTaskKey,
      condition: dependency.condition,
      createdAt: ctx.timestamp,
    });
  }
  const latest = requireRosterExecution(ctx, execution.runId);
  ctx.db.rosterExecution.runId.update({
    ...latest,
    totalTasks: latest.totalTasks + 1,
    readyTasks: latest.readyTasks + (initialStatus === "ready" ? 1 : 0),
    blockedTasks: latest.blockedTasks + (initialStatus === "blocked" ? 1 : 0),
    skippedTasks: latest.skippedTasks + (initialStatus === "skipped" ? 1 : 0),
    contextBytes: latest.contextBytes + spec.contextBytes,
    graphVersion: latest.graphVersion + 1n,
    status: "running",
    updatedAt: ctx.timestamp,
  });
};

const appendReceipt = (
  ctx: RosterContext,
  input: {
    runId: string;
    eventId: string;
    kind: string;
    agentId: string;
    payloadJson: string;
    hash?: string;
    actor?: Identity;
    expectedPrev?: string;
    summary?: string;
  }
): boolean => {
  const id = receiptKey(input.runId, input.eventId);
  const existing = ctx.db.receipt.id.find(id);
  if (existing) {
    const candidateHash = input.hash?.trim() || id;
    if (
      existing.hash !== candidateHash
      || existing.payloadJson !== input.payloadJson
      || existing.kind !== input.kind
      || existing.agentId !== input.agentId
    ) {
      reject(`event ${input.eventId} changed after publication`);
    }
    return false;
  }
  const run = requireRun(ctx, input.runId);
  if (
    input.expectedPrev !== undefined
    && input.expectedPrev !== run.headReceiptHash
  ) {
    reject(`expected previous hash ${input.expectedPrev || "<genesis>"}, found ${run.headReceiptHash || "<genesis>"}`);
  }
  const seq = run.nextReceiptSeq + 1n;
  const hash = input.hash?.trim() || id;
  ctx.db.receipt.insert({
    id,
    runId: input.runId,
    seq,
    eventId: input.eventId,
    kind: input.kind,
    actor: input.actor ?? ctx.sender,
    agentId: input.agentId,
    payloadJson: input.payloadJson,
    prevHash: run.headReceiptHash,
    hash,
    createdAt: ctx.timestamp,
  });
  ctx.db.canvasActivity.insert({
    id,
    runId: input.runId,
    seq,
    kind: input.kind,
    agentId: input.agentId,
    agentName: ctx.db.canvasAgent.id.find(canvasAgentKey(input.runId, input.agentId))?.name ?? input.agentId,
    summary: input.summary?.trim().slice(0, 1_000) || input.kind,
    createdAt: ctx.timestamp,
  });
  // Activity is a reconnect-friendly UI projection, not the authoritative
  // event log. Keep the complete receipt chain while bounding browser snapshot
  // cost for long-running or high-agent-count runs.
  const activityCutoff = seq > 512n ? seq - 512n : 0n;
  if (activityCutoff > 0n) {
    for (const activity of ctx.db.canvasActivity.runId.filter(input.runId)) {
      if (activity.seq <= activityCutoff) ctx.db.canvasActivity.id.delete(activity.id);
    }
  }
  ctx.db.canvasRun.id.update({
    ...run,
    nextReceiptSeq: seq,
    headReceiptHash: hash,
    updatedAt: ctx.timestamp,
  });
  return true;
};

/** Create the caller-owned workspace used by the shared agent runtimes. */
export const ensureWorkspace = spacetimedb.reducer(
  { workspaceId: t.string(), name: t.string() },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const name = requireText("name", args.name, 240);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(workspaceId)) {
      reject("workspaceId contains unsafe characters");
    }
    const existing = ctx.db.rosterWorkspace.id.find(workspaceId);
    if (existing) {
      if (!existing.owner.equals(ctx.sender)) reject(`workspace ${workspaceId} belongs to another identity`);
      // Repository names are presentation metadata and may legitimately
      // change between launches. The stable workspace id and owner remain the
      // authorization boundary.
      if (existing.name !== name) {
        ctx.db.rosterWorkspace.id.update({ ...existing, name, updatedAt: ctx.timestamp });
      }
      workspaceUsage(ctx, workspaceId);
      return;
    }
    const ownedWorkspaceCount = [...ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)]
      .filter((membership) => membership.role === "owner")
      .length;
    if (ownedWorkspaceCount >= MAX_WORKSPACES_PER_OWNER) {
      reject(`identity has reached its workspace limit`);
    }
    ctx.db.rosterWorkspace.insert({
      id: workspaceId,
      owner: ctx.sender,
      name,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    ctx.db.rosterWorkspaceMember.insert({
      id: workspaceMembershipKey(workspaceId, ctx.sender),
      workspaceId,
      member: ctx.sender,
      role: "owner",
      createdAt: ctx.timestamp,
    });
    ctx.db.rosterWorkspaceUsage.insert({
      workspaceId,
      owner: ctx.sender,
      windowStartedAt: ctx.timestamp,
      jobsInWindow: 0,
      activeJobs: 0,
      totalJobs: 0n,
      updatedAt: ctx.timestamp,
    });
  }
);

export const addWorkspaceMember = spacetimedb.reducer(
  { workspaceId: t.string(), member: t.identity(), role: t.string() },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const role = requireText("role", args.role, 32);
    requireWorkspace(ctx, workspaceId);
    requireWorkspaceMembership(ctx, workspaceId, ["owner"]);
    if (!WORKSPACE_ROLES.has(role) || role === "owner") reject("invalid delegated workspace role");
    const id = workspaceMembershipKey(workspaceId, args.member);
    const existing = ctx.db.rosterWorkspaceMember.id.find(id);
    if (existing) ctx.db.rosterWorkspaceMember.id.update({ ...existing, role });
    else {
      ctx.db.rosterWorkspaceMember.insert({
        id,
        workspaceId,
        member: args.member,
        role,
        createdAt: ctx.timestamp,
      });
    }
  }
);

export const createWorkspaceViewerCapability = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    capabilityId: t.string(),
    capabilityHash: t.string(),
    maxUses: t.u32(),
    ttlSeconds: t.u32(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const capabilityId = requireText("capabilityId", args.capabilityId, 160);
    const capabilityHash = requireText("capabilityHash", args.capabilityHash, 64);
    requireWorkspace(ctx, workspaceId);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator"]);
    if (!/^[0-9a-f]{64}$/.test(capabilityHash)) reject("capabilityHash must be a lowercase SHA-256 digest");
    if (args.maxUses < 1 || args.maxUses > 10_000) reject("maxUses must be between 1 and 10000");
    if (args.ttlSeconds < 60 || args.ttlSeconds > 2_592_000) {
      reject("ttlSeconds must be between 60 and 2592000");
    }
    const existingById = ctx.db.workspaceViewerCapability.capabilityId.find(capabilityId);
    const existingByHash = ctx.db.workspaceViewerCapability.capabilityHash.find(capabilityHash);
    if (existingById || existingByHash) {
      const existing = existingById ?? existingByHash!;
      if (
        existing.workspaceId !== workspaceId
        || existing.capabilityId !== capabilityId
        || existing.capabilityHash !== capabilityHash
        || existing.maxUses !== args.maxUses
      ) reject("workspace viewer capability changed after creation");
      return;
    }
    const expiresAt = new Timestamp(
      ctx.timestamp.microsSinceUnixEpoch + BigInt(args.ttlSeconds) * 1_000_000n
    );
    ctx.db.workspaceViewerCapability.insert({
      capabilityHash,
      capabilityId,
      workspaceId,
      maxUses: args.maxUses,
      uses: 0,
      expiresAt,
      revoked: false,
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }
);

export const revokeWorkspaceViewerCapability = spacetimedb.reducer(
  { workspaceId: t.string(), capabilityId: t.string() },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const capabilityId = requireText("capabilityId", args.capabilityId, 160);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator"]);
    const capability = expectValue(
      ctx.db.workspaceViewerCapability.capabilityId.find(capabilityId),
      `workspace viewer capability ${capabilityId} does not exist`
    );
    if (capability.workspaceId !== workspaceId) reject("workspace viewer capability belongs elsewhere");
    if (capability.revoked) return;
    ctx.db.workspaceViewerCapability.capabilityHash.update({
      ...capability,
      revoked: true,
      updatedAt: ctx.timestamp,
    });
    for (const redemption of ctx.db.workspaceViewerRedemption.capabilityId.filter(capabilityId)) {
      const membershipId = workspaceMembershipKey(workspaceId, redemption.member);
      const membership = ctx.db.rosterWorkspaceMember.id.find(membershipId);
      if (membership?.role === "viewer") ctx.db.rosterWorkspaceMember.id.delete(membershipId);
      ctx.db.workspaceViewerRedemption.id.delete(redemption.id);
    }
  }
);

/** Redeem an expiring verifier and join a workspace as a read-only viewer. */
export const joinWorkspace = spacetimedb.reducer(
  { workspaceId: t.string(), capabilityHash: t.string() },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const capabilityHash = requireText("capabilityHash", args.capabilityHash, 64);
    if (!/^[0-9a-f]{64}$/.test(capabilityHash)) reject("capabilityHash must be a lowercase SHA-256 digest");
    const existingMembership = ctx.db.rosterWorkspaceMember.id.find(
      workspaceMembershipKey(workspaceId, ctx.sender)
    );
    if (existingMembership) return;
    const capability = expectValue(
      ctx.db.workspaceViewerCapability.capabilityHash.find(capabilityHash),
      "workspace viewer capability is invalid"
    );
    if (capability.workspaceId !== workspaceId || capability.revoked) {
      reject("workspace viewer capability is invalid");
    }
    if (capability.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) {
      reject("workspace viewer capability has expired");
    }
    if (capability.uses >= capability.maxUses) reject("workspace viewer capability is exhausted");
    ctx.db.rosterWorkspaceMember.insert({
      id: workspaceMembershipKey(workspaceId, ctx.sender),
      workspaceId,
      member: ctx.sender,
      role: "viewer",
      createdAt: ctx.timestamp,
    });
    ctx.db.workspaceViewerCapability.capabilityHash.update({
      ...capability,
      uses: capability.uses + 1,
      updatedAt: ctx.timestamp,
    });
    ctx.db.workspaceViewerRedemption.insert({
      id: compoundKey(capability.capabilityId, identityKey(ctx.sender)),
      capabilityId: capability.capabilityId,
      workspaceId,
      member: ctx.sender,
      createdAt: ctx.timestamp,
    });
  }
);

/** Idempotently create a root stream or branch metadata row. */
export const ensureEventStream = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    streamId: t.string(),
    kind: t.string(),
    parentStreamId: t.string(),
    forkAt: t.u32(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const streamId = requireText("streamId", args.streamId, 500);
    const kind = requireText("kind", args.kind, 80);
    const parentStreamId = args.parentStreamId.trim();
    if (parentStreamId.length > 500) reject("parentStreamId exceeds 500 characters");
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator", "worker"]);
    const storageId = streamStorageKey(ctx, workspaceId, streamId);
    const parentStorageId = parentStreamId
      ? streamStorageKey(ctx, workspaceId, parentStreamId)
      : "";
    if (parentStreamId) {
      const parent = expectValue(ctx.db.eventStream.id.find(parentStorageId), "parent stream does not exist");
      if (parent.workspaceId !== workspaceId) reject("parent stream belongs to another workspace");
      if (BigInt(args.forkAt) > parent.receiptCount) reject("forkAt exceeds the parent receipt frontier");
    } else if (args.forkAt !== 0) {
      reject("root streams require forkAt 0");
    }
    const existing = ctx.db.eventStream.id.find(storageId);
    if (existing) {
      if (
        existing.workspaceId !== workspaceId
        || existing.kind !== kind
        || existing.parentStreamId !== parentStorageId
        || existing.forkAt !== args.forkAt
      ) reject(`stream ${streamId} changed after creation`);
      return;
    }
    ctx.db.eventStream.insert({
      id: storageId,
      workspaceId,
      kind,
      nextSeq: 0n,
      headHash: "",
      receiptCount: 0n,
      parentStreamId: parentStorageId,
      forkAt: args.forkAt,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }
);

/** Atomically append one immutable generic receipt and advance its stream head. */
export const appendStreamReceipt = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    streamId: t.string(),
    receiptId: t.string(),
    occurredAtMs: t.u64(),
    prevHash: t.string(),
    hash: t.string(),
    bodyJson: t.string(),
    hintsJson: t.string(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const streamId = requireText("streamId", args.streamId, 500);
    const receiptId = requireText("receiptId", args.receiptId, 240);
    const prevHash = args.prevHash.trim();
    const hash = requireText("hash", args.hash, 64);
    if (prevHash && !/^[0-9a-f]{64}$/.test(prevHash)) reject("prevHash must be empty or a SHA-256 digest");
    if (!/^[0-9a-f]{64}$/.test(hash)) reject("hash must be a lowercase SHA-256 digest");
    const bodyJson = requireJson("bodyJson", args.bodyJson, 512_000);
    const body = asRecord("receipt body", JSON.parse(bodyJson));
    recordString(body, "type", 160);
    const hintsJson = requireJson("hintsJson", args.hintsJson || "{}", 32_000);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator", "worker"]);
    const storageId = streamStorageKey(ctx, workspaceId, streamId);
    const stream = expectValue(ctx.db.eventStream.id.find(storageId), `stream ${streamId} does not exist`);
    if (stream.workspaceId !== workspaceId) reject("stream belongs to another workspace");
    const id = streamReceiptKey(storageId, receiptId);
    const existing = ctx.db.streamReceipt.id.find(id);
    if (existing) {
      if (
        existing.occurredAtMs !== args.occurredAtMs
        || existing.prevHash !== prevHash
        || existing.hash !== hash
        || existing.bodyJson !== bodyJson
        || existing.hintsJson !== hintsJson
      ) reject(`receipt ${receiptId} changed after publication`);
      return;
    }
    if (prevHash !== stream.headHash) {
      reject(`expected previous hash ${stream.headHash || "<genesis>"}, received ${prevHash || "<genesis>"}`);
    }
    const seq = stream.nextSeq + 1n;
    ctx.db.streamReceipt.insert({
      id,
      workspaceId,
      streamId: storageId,
      seq,
      receiptId,
      occurredAtMs: args.occurredAtMs,
      prevHash,
      hash,
      bodyJson,
      hintsJson,
      createdAt: ctx.timestamp,
    });
    ctx.db.eventStream.id.update({
      ...stream,
      nextSeq: seq,
      headHash: hash,
      receiptCount: seq,
      updatedAt: ctx.timestamp,
    });
  }
);

/**
 * Atomically create/update a Coding room and append one conversation message.
 * This is the authoritative path for message receipts; a room can therefore
 * never be omitted merely because no execution job was enqueued.
 */
export const appendCodingRoomReceipt = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    codingWorkspaceId: t.string(),
    roomId: t.string(),
    conversationId: t.string(),
    streamId: t.string(),
    receiptId: t.string(),
    occurredAtMs: t.u64(),
    prevHash: t.string(),
    hash: t.string(),
    bodyJson: t.string(),
    hintsJson: t.string(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const codingWorkspaceId = requireText("codingWorkspaceId", args.codingWorkspaceId, 160);
    const conversationId = requireText("conversationId", args.conversationId, 160);
    const roomId = requireText("roomId", args.roomId, 360);
    const streamId = requireText("streamId", args.streamId, 500);
    const receiptId = requireText("receiptId", args.receiptId, 240);
    const prevHash = args.prevHash.trim();
    const hash = requireText("hash", args.hash, 64);
    if (roomId !== expectedCodingRoomId(conversationId)) reject("roomId does not match conversationId");
    if (streamId !== `${CODING_CONVERSATION_STREAM_PREFIX}${conversationId}`) {
      reject("streamId does not match conversationId");
    }
    if (prevHash && !/^[0-9a-f]{64}$/.test(prevHash)) reject("prevHash must be empty or a SHA-256 digest");
    if (!/^[0-9a-f]{64}$/.test(hash)) reject("hash must be a lowercase SHA-256 digest");
    const bodyJson = requireJson("bodyJson", args.bodyJson, 512_000);
    const message = expectValue(
      codingRoomMessageMetadata(bodyJson),
      "receipt is not a Coding conversation message",
    );
    if (message.conversationId !== conversationId) reject("message conversationId does not match room");
    if (message.codingWorkspaceId !== codingWorkspaceId) reject("message workspaceId does not match room");
    const hintsJson = requireJson("hintsJson", args.hintsJson || "{}", 32_000);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator", "worker"]);

    const storageId = streamStorageKey(ctx, workspaceId, streamId);
    let stream = ctx.db.eventStream.id.find(storageId);
    if (stream) {
      if (stream.workspaceId !== workspaceId) reject("stream belongs to another workspace");
      if (stream.parentStreamId) reject("Coding repository rooms must use root streams");
      if (stream.kind !== "coding-room" && stream.kind !== "agents") {
        reject(`stream ${streamId} is not a Coding room`);
      }
      if (stream.kind !== "coding-room") {
        stream = ctx.db.eventStream.id.update({
          ...stream,
          kind: "coding-room",
          updatedAt: ctx.timestamp,
        });
      }
    } else {
      stream = ctx.db.eventStream.insert({
        id: storageId,
        workspaceId,
        kind: "coding-room",
        nextSeq: 0n,
        headHash: "",
        receiptCount: 0n,
        parentStreamId: "",
        forkAt: 0,
        createdAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      });
    }

    const durableRoomId = codingRoomKey(workspaceId, roomId);
    let room = ctx.db.codingRoom.id.find(durableRoomId);
    if (!room && stream.receiptCount > 0n) {
      let legacyFirstMessage: CodingRoomMessageMetadata | undefined;
      let legacyFirstMessageSeq: bigint | undefined;
      let legacyMessageCount = 0;
      for (const priorReceipt of ctx.db.streamReceipt.streamId.filter(storageId)) {
        const priorMessage = codingRoomMessageMetadata(priorReceipt.bodyJson);
        if (!priorMessage || priorMessage.conversationId !== conversationId) continue;
        if (priorMessage.codingWorkspaceId
          && priorMessage.codingWorkspaceId !== codingWorkspaceId) {
          reject("legacy message workspaceId does not match room");
        }
        legacyMessageCount += 1;
        if (legacyFirstMessageSeq === undefined || priorReceipt.seq < legacyFirstMessageSeq) {
          legacyFirstMessage = priorMessage;
          legacyFirstMessageSeq = priorReceipt.seq;
        }
      }
      if (legacyFirstMessage) {
        room = ctx.db.codingRoom.insert({
          id: durableRoomId,
          workspaceId,
          codingWorkspaceId,
          roomId,
          conversationId,
          streamId: storageId,
          title: codingRoomTitle(legacyFirstMessage.text),
          state: "open",
          firstMessageId: legacyFirstMessage.messageId,
          messageCount: legacyMessageCount,
          createdAt: stream.createdAt,
          updatedAt: stream.updatedAt,
        });
      }
    }
    if (room && (
      room.workspaceId !== workspaceId
      || room.codingWorkspaceId !== codingWorkspaceId
      || room.roomId !== roomId
      || room.conversationId !== conversationId
      || room.streamId !== storageId
    )) reject(`room ${roomId} changed after creation`);

    const id = streamReceiptKey(storageId, receiptId);
    const existing = ctx.db.streamReceipt.id.find(id);
    if (existing) {
      if (
        existing.occurredAtMs !== args.occurredAtMs
        || existing.prevHash !== prevHash
        || existing.hash !== hash
        || existing.bodyJson !== bodyJson
        || existing.hintsJson !== hintsJson
      ) reject(`receipt ${receiptId} changed after publication`);
      return;
    }
    if (prevHash !== stream.headHash) {
      reject(`expected previous hash ${stream.headHash || "<genesis>"}, received ${prevHash || "<genesis>"}`);
    }
    const seq = stream.nextSeq + 1n;
    ctx.db.streamReceipt.insert({
      id,
      workspaceId,
      streamId: storageId,
      seq,
      receiptId,
      occurredAtMs: args.occurredAtMs,
      prevHash,
      hash,
      bodyJson,
      hintsJson,
      createdAt: ctx.timestamp,
    });
    ctx.db.eventStream.id.update({
      ...stream,
      nextSeq: seq,
      headHash: hash,
      receiptCount: seq,
      updatedAt: ctx.timestamp,
    });
    if (room) {
      ctx.db.codingRoom.id.update({
        ...room,
        messageCount: room.messageCount + 1,
        state: "open",
        updatedAt: ctx.timestamp,
      });
    } else {
      ctx.db.codingRoom.insert({
        id: durableRoomId,
        workspaceId,
        codingWorkspaceId,
        roomId,
        conversationId,
        streamId: storageId,
        title: codingRoomTitle(message.text),
        state: "open",
        firstMessageId: message.messageId,
        messageCount: 1,
        createdAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      });
    }
  }
);

/** Atomically enqueue work, including retry-safe singleton resolution. */
export const enqueueRosterJob = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    requestId: t.string(),
    jobId: t.string(),
    agentId: t.string(),
    lane: t.string(),
    sessionKey: t.string(),
    singletonMode: t.string(),
    payloadJson: t.string(),
    maxAttempts: t.u32(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const requestId = requireText("requestId", args.requestId, 200);
    const jobId = requireText("jobId", args.jobId, 200);
    const agentId = requireText("agentId", args.agentId, 120);
    const lane = requireText("lane", args.lane, 24);
    const sessionKey = args.sessionKey.trim();
    const singletonMode = requireText("singletonMode", args.singletonMode, 24);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(jobId)) reject("jobId contains unsafe characters");
    if (!JOB_LANES.has(lane)) reject("invalid job lane");
    if (!JOB_SINGLETON_MODES.has(singletonMode)) reject("invalid singleton mode");
    if (sessionKey.length > 240) reject("sessionKey exceeds 240 characters");
    if (args.maxAttempts < 1 || args.maxAttempts > 8) reject("maxAttempts must be between 1 and 8");
    const payloadJson = requireJson("payloadJson", args.payloadJson, MAX_JOB_PAYLOAD_CHARS);
    asRecord("job payload", JSON.parse(payloadJson));
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator", "worker"]);

    const requestJson = JSON.stringify({
      jobId,
      agentId,
      lane,
      sessionKey,
      singletonMode,
      payloadJson,
      maxAttempts: args.maxAttempts,
    });
    const requestKey = rosterJobRequestKey(workspaceId, requestId);
    const existingRequest = ctx.db.rosterJobRequest.id.find(requestKey);
    if (existingRequest) {
      if (existingRequest.requestJson !== requestJson) reject("job request changed after enqueue");
      return;
    }

    const activeSameSession = sessionKey
      ? [...ctx.db.rosterJob.workspaceId.filter(workspaceId)]
        .filter((job) => job.sessionKey === sessionKey && !TERMINAL_JOB_STATUSES.has(job.status))
        .sort((a, b) => {
          if (a.updatedAt.microsSinceUnixEpoch > b.updatedAt.microsSinceUnixEpoch) return -1;
          if (a.updatedAt.microsSinceUnixEpoch < b.updatedAt.microsSinceUnixEpoch) return 1;
          return a.id.localeCompare(b.id);
        })
      : [];

    if (singletonMode === "reject" && activeSameSession[0]) {
      reject(`session already has active job ${activeSameSession[0].id}`);
    }

    if (singletonMode === "steer" && activeSameSession[0]) {
      const target = activeSameSession[0];
      insertRosterJobCommand(ctx, {
        workspaceId,
        jobId: target.id,
        commandId: `${requestId}:steer`,
        command: "steer",
        payloadJson: JSON.stringify({ fromSessionKey: sessionKey, fromEnqueue: true, payload: JSON.parse(payloadJson) }),
        by: identityKey(ctx.sender),
      });
      ctx.db.rosterJob.id.update({ ...target, updatedAt: ctx.timestamp });
      appendRosterJobEvent(ctx, workspaceId, target.id, "queue.command", {
        type: "queue.command",
        jobId: target.id,
        commandId: `${requestId}:steer`,
        command: "steer",
        lane: "steer",
        payload: { fromSessionKey: sessionKey, fromEnqueue: true, payload: JSON.parse(payloadJson) },
        by: identityKey(ctx.sender),
      });
      ctx.db.rosterJobRequest.insert({
        id: requestKey,
        workspaceId,
        requestId,
        requestedJobId: jobId,
        resolvedJobId: target.id,
        requestJson,
        createdAt: ctx.timestamp,
      });
      return;
    }

    if (singletonMode === "cancel") {
      for (const prior of activeSameSession) {
        ctx.db.rosterJob.id.update({
          ...prior,
          status: "canceled",
          leaseOwner: undefined,
          leaseWorker: "",
          leaseUntil: undefined,
          claimToken: "",
          canceledReason: "singleton cancel",
          abortRequested: true,
          updatedAt: ctx.timestamp,
        });
        appendRosterJobEvent(ctx, workspaceId, prior.id, "job.canceled", {
          type: "job.canceled",
          jobId: prior.id,
          reason: "singleton cancel",
          by: identityKey(ctx.sender),
        });
        releaseWorkspaceJob(ctx, workspaceId);
      }
    }

    const existingJob = ctx.db.rosterJob.id.find(jobId);
    if (existingJob) reject(`job ${jobId} already exists`);
    admitWorkspaceJob(ctx, workspaceId);
    ctx.db.rosterJob.insert({
      id: jobId,
      workspaceId,
      agentId,
      lane,
      sessionKey,
      singletonMode,
      payloadJson,
      status: "queued",
      attempt: 0,
      maxAttempts: args.maxAttempts,
      leaseOwner: undefined,
      leaseWorker: "",
      leaseFence: 0n,
      leaseUntil: undefined,
      claimToken: "",
      availableAt: ctx.timestamp,
      lastError: "",
      resultJson: "",
      canceledReason: "",
      abortRequested: false,
      nextEventSeq: 0n,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    ctx.db.rosterJobRequest.insert({
      id: requestKey,
      workspaceId,
      requestId,
      requestedJobId: jobId,
      resolvedJobId: jobId,
      requestJson,
      createdAt: ctx.timestamp,
    });
    appendRosterJobEvent(ctx, workspaceId, jobId, "job.enqueued", {
      type: "job.enqueued",
      jobId,
      agentId,
      lane,
      payload: JSON.parse(payloadJson),
      maxAttempts: args.maxAttempts,
      ...(sessionKey ? { sessionKey } : {}),
      singletonMode,
      createdAt: Number(ctx.timestamp.microsSinceUnixEpoch / 1_000n),
    });
  }
);

/** Select and fence one job in the same transaction as the claim. */
export const claimNextRosterJob = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    workerId: t.string(),
    claimToken: t.string(),
    leaseMs: t.u32(),
    agentId: t.string(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const workerId = requireText("workerId", args.workerId, 160);
    const claimToken = requireText("claimToken", args.claimToken, 200);
    const agentId = args.agentId.trim();
    if (agentId.length > 120) reject("agentId exceeds 120 characters");
    if (args.leaseMs < 1_000 || args.leaseMs > 600_000) reject("leaseMs must be between 1000 and 600000");
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator", "worker"]);

    for (const job of ctx.db.rosterJob.workspaceId.filter(workspaceId)) {
      if (job.claimToken === claimToken) {
        if (!job.leaseOwner?.equals(ctx.sender) || job.leaseWorker !== workerId) {
          reject("claimToken belongs to another worker");
        }
        return;
      }
    }

    const candidates = [...ctx.db.rosterJob.workspaceId.filter(workspaceId)]
      .filter((job) => (
        job.status === "queued"
        && !job.abortRequested
        && job.attempt < job.maxAttempts
        && job.availableAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch
        && (!agentId || job.agentId === agentId)
      ))
      .sort((a, b) => {
        const laneDelta = jobLanePriority(a.lane) - jobLanePriority(b.lane);
        if (laneDelta) return laneDelta;
        if (a.createdAt.microsSinceUnixEpoch < b.createdAt.microsSinceUnixEpoch) return -1;
        if (a.createdAt.microsSinceUnixEpoch > b.createdAt.microsSinceUnixEpoch) return 1;
        return a.id.localeCompare(b.id);
      });
    const next = candidates[0];
    if (!next) return;
    const fence = next.leaseFence + 1n;
    const leaseUntilMicros = ctx.timestamp.microsSinceUnixEpoch + BigInt(args.leaseMs) * 1_000n;
    const leaseUntil = new Timestamp(leaseUntilMicros);
    ctx.db.rosterJob.id.update({
      ...next,
      status: "leased",
      attempt: next.attempt + 1,
      leaseOwner: ctx.sender,
      leaseWorker: workerId,
      leaseFence: fence,
      leaseUntil,
      claimToken,
      lastError: "",
      updatedAt: ctx.timestamp,
    });
    ctx.db.rosterJobLeaseExpiry.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(leaseUntilMicros),
      jobId: next.id,
      fence,
    });
    appendRosterJobEvent(ctx, workspaceId, next.id, "job.leased", {
      type: "job.leased",
      jobId: next.id,
      workerId,
      leaseMs: args.leaseMs,
      attempt: next.attempt + 1,
    });
  }
);

export const heartbeatRosterJob = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    jobId: t.string(),
    workerId: t.string(),
    fence: t.u64(),
    leaseMs: t.u32(),
  },
  (ctx, args) => {
    if (args.leaseMs < 1_000 || args.leaseMs > 600_000) reject("leaseMs must be between 1000 and 600000");
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator", "worker"]);
    const job = requireActiveRosterJobLease(ctx, args.workspaceId, args.jobId, args.workerId, args.fence);
    const leaseUntilMicros = ctx.timestamp.microsSinceUnixEpoch + BigInt(args.leaseMs) * 1_000n;
    ctx.db.rosterJob.id.update({
      ...job,
      status: "running",
      leaseUntil: new Timestamp(leaseUntilMicros),
      updatedAt: ctx.timestamp,
    });
    ctx.db.rosterJobLeaseExpiry.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(leaseUntilMicros),
      jobId: job.id,
      fence: job.leaseFence,
    });
    appendRosterJobEvent(ctx, args.workspaceId, job.id, "job.heartbeat", {
      type: "job.heartbeat",
      jobId: job.id,
      workerId: args.workerId,
      leaseMs: args.leaseMs,
    });
  }
);

const rosterNodeWakeForJob = (ctx: RosterContext, workspaceId: string, jobId: string) =>
  [...ctx.db.rosterNodeWake.workspaceId.filter(workspaceId)]
    .find((wake) => wake.jobId === jobId);

/** Settle continuity in the same transaction as its generic job boundary. */
const completeRosterNodeWakeForJob = (
  ctx: RosterContext,
  workspaceId: string,
  jobId: string,
  jobResultJson: string
): void => {
  const wake = rosterNodeWakeForJob(ctx, workspaceId, jobId);
  if (!wake || wake.status === "completed") return;
  if (wake.status !== "working") reject(`node wake ${wake.id} is ${wake.status} at job completion`);
  const boundValue: unknown = JSON.parse(requireJson(
    "wake inbox deliveries",
    wake.inboxDeliveryIdsJson,
    64_000
  ));
  if (!Array.isArray(boundValue)) reject("wake inbox deliveries must be an array");
  const consumed = (boundValue as unknown[])
    .map((value: unknown) => requireRosterId("consumed delivery id", String(value), 200));
  const consumedSet = new Set(consumed);
  for (const item of ctx.db.rosterNodeInboxItem.nodeId.filter(wake.nodeId)) {
    if (item.workspaceId !== wake.workspaceId || !consumedSet.has(item.deliveryId)) continue;
    ctx.db.rosterNodeInboxItem.id.update({ ...item, status: "consumed", consumedAt: ctx.timestamp });
  }
  const pending = [...ctx.db.rosterNodeInboxItem.nodeId.filter(wake.nodeId)]
    .filter((item) => item.workspaceId === wake.workspaceId && item.status !== "consumed").length;
  const nowMs = ctx.timestamp.microsSinceUnixEpoch / 1_000n;
  const resultJson = JSON.stringify({
    jobId,
    status: "completed",
    ...(jobResultJson ? { resultHash: rosterHashCanonical(JSON.parse(jobResultJson)) } : {}),
  });
  ctx.db.rosterNodeWake.id.update({
    ...wake,
    status: "completed",
    completedAtMs: nowMs,
    resultJson,
    updatedAt: ctx.timestamp,
  });
  let continuity = requireRosterNodeContinuity(ctx, wake.workspaceId, wake.nodeId);
  continuity = {
    ...continuity,
    status: pending ? "waiting" : "dormant",
    activeWakeId: "",
    lastWakeId: wake.id,
    pendingInboxCount: pending,
    updatedAt: ctx.timestamp,
  };
  ctx.db.rosterNodeContinuity.id.update(continuity);
  appendRosterNodeContinuityEvent(ctx, continuity, "node.wake.completed", {
    type: "node.wake.completed",
    wakeId: wake.id,
    consumedDeliveryIds: consumed,
    occurredAt: Number(nowMs),
  });
  continueRosterNodeWakeInternal(ctx, wake.workspaceId, wake.nodeId, nowMs);
};

const failRosterNodeWakeForJob = (
  ctx: RosterContext,
  workspaceId: string,
  jobId: string,
  errorValue: string
): void => {
  const wake = rosterNodeWakeForJob(ctx, workspaceId, jobId);
  if (!wake || wake.status === "failed" || wake.status === "canceled") return;
  if (wake.status === "completed") reject(`completed node wake ${wake.id} cannot fail`);
  const error = errorValue.trim().slice(0, 8_000) || "node wake job failed";
  for (const item of ctx.db.rosterNodeInboxItem.nodeId.filter(wake.nodeId)) {
    if (item.workspaceId !== wake.workspaceId || item.wakeId !== wake.id || item.status === "consumed") continue;
    ctx.db.rosterNodeInboxItem.id.update({ ...item, status: "failed" });
  }
  const nowMs = ctx.timestamp.microsSinceUnixEpoch / 1_000n;
  ctx.db.rosterNodeWake.id.update({
    ...wake,
    status: "failed",
    completedAtMs: nowMs,
    lastError: error,
    updatedAt: ctx.timestamp,
  });
  let continuity = requireRosterNodeContinuity(ctx, wake.workspaceId, wake.nodeId);
  continuity = {
    ...continuity,
    status: continuity.pendingInboxCount ? "waiting" : "dormant",
    activeWakeId: "",
    lastWakeId: wake.id,
    updatedAt: ctx.timestamp,
  };
  ctx.db.rosterNodeContinuity.id.update(continuity);
  continuity = appendRosterNodeContinuityEvent(ctx, continuity, "node.wake.failed", {
    type: "node.wake.failed",
    wakeId: wake.id,
    error,
    occurredAt: Number(nowMs),
  });
  continueRosterNodeWakeInternal(ctx, wake.workspaceId, wake.nodeId, nowMs);
};

export const completeRosterJob = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    jobId: t.string(),
    workerId: t.string(),
    fence: t.u64(),
    resultJson: t.string(),
  },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator", "worker"]);
    const resultJson = args.resultJson.trim()
      ? requireJson("resultJson", args.resultJson, MAX_JOB_RESULT_CHARS)
      : "";
    if (resultJson) asRecord("job result", JSON.parse(resultJson));
    const existing = requireRosterJob(ctx, args.workspaceId, args.jobId);
    if (existing.status === "completed" && existing.leaseFence === args.fence) {
      if (existing.resultJson !== resultJson) reject("completed job result changed on retry");
      return;
    }
    const job = requireActiveRosterJobLease(ctx, args.workspaceId, args.jobId, args.workerId, args.fence);
    const terminalConsumerId = `job_terminal_${job.id}_${args.fence.toString()}`;
    for (const command of ctx.db.rosterJobCommand.jobId.filter(job.id)) {
      if (command.workspaceId !== args.workspaceId) continue;
      if (command.command !== "steer" && command.command !== "follow_up") continue;
      supersedeTerminalRosterJobCommand(
        ctx,
        args.workspaceId,
        job.id,
        command,
        terminalConsumerId
      );
    }
    ctx.db.rosterJob.id.update({
      ...job,
      status: "completed",
      leaseOwner: undefined,
      leaseWorker: "",
      leaseUntil: undefined,
      claimToken: "",
      resultJson,
      updatedAt: ctx.timestamp,
    });
    appendRosterJobEvent(ctx, args.workspaceId, job.id, "job.completed", {
      type: "job.completed",
      jobId: job.id,
      workerId: args.workerId,
      ...(resultJson ? { result: JSON.parse(resultJson) } : {}),
    });
    completeRosterNodeWakeForJob(ctx, args.workspaceId, job.id, resultJson);
    releaseWorkspaceJob(ctx, args.workspaceId);
  }
);

export const failRosterJob = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    jobId: t.string(),
    workerId: t.string(),
    fence: t.u64(),
    error: t.string(),
    retryable: t.bool(),
    resultJson: t.string(),
  },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator", "worker"]);
    const error = requireText("error", args.error, 8_000);
    const resultJson = args.resultJson.trim()
      ? requireJson("resultJson", args.resultJson, MAX_JOB_RESULT_CHARS)
      : "";
    if (resultJson) asRecord("job result", JSON.parse(resultJson));
    const job = requireActiveRosterJobLease(ctx, args.workspaceId, args.jobId, args.workerId, args.fence);
    // A command accepted while this exact lease was active must not be
    // stranded by a racing terminal failure. Retry only failures that the
    // handler classified as retryable; otherwise defer the room intent for a
    // future bounded continuation instead of rerunning the failed objective.
    const continuationPending = [...ctx.db.rosterJobCommand.jobId.filter(job.id)]
      .some((command) => (
        command.workspaceId === args.workspaceId
        && (command.command === "steer" || command.command === "follow_up")
        && !command.consumedAt
        && !command.consumedBy
      ));
    const willRetry = args.retryable && job.attempt < job.maxAttempts;
    const backoffMs = willRetry && !continuationPending
      ? Math.min(60_000, 1_000 * (2 ** Math.max(0, job.attempt - 1)))
      : 0;
    if (!willRetry) {
      const terminalConsumerId = `job_terminal_${job.id}_${args.fence.toString()}`;
      for (const command of ctx.db.rosterJobCommand.jobId.filter(job.id)) {
        if (command.workspaceId !== args.workspaceId) continue;
        if (command.command !== "steer" && command.command !== "follow_up") continue;
        supersedeTerminalRosterJobCommand(
          ctx,
          args.workspaceId,
          job.id,
          command,
          terminalConsumerId
        );
      }
    }
    ctx.db.rosterJob.id.update({
      ...job,
      status: willRetry ? "queued" : "failed",
      leaseOwner: undefined,
      leaseWorker: "",
      leaseUntil: undefined,
      claimToken: "",
      availableAt: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + BigInt(backoffMs) * 1_000n),
      lastError: error,
      resultJson: willRetry ? job.resultJson : resultJson,
      updatedAt: ctx.timestamp,
    });
    appendRosterJobEvent(ctx, args.workspaceId, job.id, "job.failed", {
      type: "job.failed",
      jobId: job.id,
      workerId: args.workerId,
      error,
      retryable: args.retryable,
      willRetry,
      ...(continuationPending ? { continuationPending: true } : {}),
      ...(!willRetry && resultJson ? { result: JSON.parse(resultJson) } : {}),
    });
    if (!willRetry) {
      failRosterNodeWakeForJob(ctx, args.workspaceId, job.id, error);
      releaseWorkspaceJob(ctx, args.workspaceId);
    }
  }
);

export const cancelRosterJob = spacetimedb.reducer(
  { workspaceId: t.string(), jobId: t.string(), reason: t.string(), by: t.string() },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator"]);
    const job = requireRosterJob(ctx, args.workspaceId, args.jobId);
    if (TERMINAL_JOB_STATUSES.has(job.status)) return;
    const reason = args.reason.trim().slice(0, 8_000);
    const by = args.by.trim().slice(0, 200);
    ctx.db.rosterJob.id.update({
      ...job,
      status: "canceled",
      leaseOwner: undefined,
      leaseWorker: "",
      leaseUntil: undefined,
      claimToken: "",
      canceledReason: reason,
      abortRequested: true,
      updatedAt: ctx.timestamp,
    });
    insertRosterJobCommand(ctx, {
      workspaceId: args.workspaceId,
      jobId: job.id,
      commandId: `cancel:${job.leaseFence.toString()}:${job.updatedAt.microsSinceUnixEpoch.toString()}`,
      command: "abort",
      payloadJson: JSON.stringify({ reason }),
      by: by || identityKey(ctx.sender),
    });
    appendRosterJobEvent(ctx, args.workspaceId, job.id, "job.canceled", {
      type: "job.canceled",
      jobId: job.id,
      ...(reason ? { reason } : {}),
      ...(by ? { by } : {}),
    });
    failRosterNodeWakeForJob(ctx, args.workspaceId, job.id, reason || "node wake job canceled");
    releaseWorkspaceJob(ctx, args.workspaceId);
  }
);

export const queueRosterJobCommand = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    jobId: t.string(),
    commandId: t.string(),
    command: t.string(),
    payloadJson: t.string(),
    by: t.string(),
  },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator"]);
    const job = requireRosterJob(ctx, args.workspaceId, args.jobId);
    const command = requireText("command", args.command, 24);
    if (!JOB_COMMANDS.has(command)) reject("invalid job command");
    const commandId = requireText("commandId", args.commandId, 200);
    const payloadJson = args.payloadJson.trim()
      ? requireJson("payloadJson", args.payloadJson, 64_000)
      : "";
    if (payloadJson) asRecord("command payload", JSON.parse(payloadJson));
    const existingCommand = ctx.db.rosterJobCommand.id.find(rosterJobCommandKey(args.workspaceId, commandId));
    insertRosterJobCommand(ctx, {
      workspaceId: args.workspaceId,
      jobId: job.id,
      commandId,
      command,
      payloadJson,
      by: args.by.trim().slice(0, 200),
    });
    const insertedCommand = expectValue(
      ctx.db.rosterJobCommand.id.find(rosterJobCommandKey(args.workspaceId, commandId)),
      `job command ${commandId} was not inserted`
    );
    if (TERMINAL_JOB_STATUSES.has(job.status)) {
      if (command === "abort") reject(`job ${job.id} is terminal`);
      supersedeTerminalRosterJobCommand(
        ctx,
        args.workspaceId,
        job.id,
        insertedCommand,
        `job_terminal_${job.id}_${job.leaseFence.toString()}`
      );
      return;
    }
    if (existingCommand) return;
    ctx.db.rosterJob.id.update({
      ...job,
      abortRequested: command === "abort" ? true : job.abortRequested,
      status: command === "abort" && job.status === "queued" ? "canceled" : job.status,
      canceledReason: command === "abort" && job.status === "queued" ? "abort requested" : job.canceledReason,
      updatedAt: ctx.timestamp,
    });
    if (command === "abort" && job.status === "queued") {
      failRosterNodeWakeForJob(ctx, args.workspaceId, job.id, "abort requested");
      releaseWorkspaceJob(ctx, args.workspaceId);
    }
    appendRosterJobEvent(ctx, args.workspaceId, job.id, "queue.command", {
      type: "queue.command",
      jobId: job.id,
      commandId,
      command,
      lane: command === "follow_up" ? "follow_up" : "steer",
      ...(payloadJson ? { payload: JSON.parse(payloadJson) } : {}),
      ...(args.by.trim() ? { by: args.by.trim().slice(0, 200) } : {}),
      createdAt: Number(ctx.timestamp.microsSinceUnixEpoch / 1_000n),
    });
  }
);

/** Repair commands accepted by an older module at a terminal job boundary. */
export const reconcileTerminalRosterJobCommands = spacetimedb.reducer(
  { workspaceId: t.string(), jobId: t.string() },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator"]);
    const job = requireRosterJob(ctx, args.workspaceId, args.jobId);
    if (!TERMINAL_JOB_STATUSES.has(job.status)) reject(`job ${job.id} is not terminal`);
    const terminalConsumerId = `job_terminal_${job.id}_${job.leaseFence.toString()}`;
    for (const command of ctx.db.rosterJobCommand.jobId.filter(job.id)) {
      if (command.workspaceId !== args.workspaceId) continue;
      if (command.command !== "steer" && command.command !== "follow_up") continue;
      supersedeTerminalRosterJobCommand(
        ctx,
        args.workspaceId,
        job.id,
        command,
        terminalConsumerId
      );
    }
  }
);

/** Atomically assign unconsumed commands to one retry-safe consumer request. */
export const consumeRosterJobCommands = spacetimedb.reducer(
  { workspaceId: t.string(), jobId: t.string(), consumeId: t.string(), filtersJson: t.string() },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator", "worker"]);
    requireRosterJob(ctx, args.workspaceId, args.jobId);
    const consumeId = requireText("consumeId", args.consumeId, 200);
    const filtersValue = JSON.parse(requireJson("filtersJson", args.filtersJson, 1_000));
    const filters = asArray("filtersJson", filtersValue, 3).map((value) => {
      if (typeof value !== "string" || !JOB_COMMANDS.has(value)) reject("filtersJson contains an invalid command");
      return value as string;
    });
    const commands = [...ctx.db.rosterJobCommand.jobId.filter(args.jobId)]
      .filter((command) => command.workspaceId === args.workspaceId);
    if (commands.some((command) => command.consumedBy === consumeId)) return;
    for (const command of commands) {
      if (command.consumedBy === consumeId) continue;
      if (command.consumedAt || command.consumedBy) continue;
      if (filters.length > 0 && !filters.includes(command.command)) continue;
      ctx.db.rosterJobCommand.id.update({
        ...command,
        consumedAt: ctx.timestamp,
        consumedBy: consumeId,
      });
      appendRosterJobEvent(ctx, args.workspaceId, args.jobId, "queue.command.consumed", {
        type: "queue.command.consumed",
        jobId: args.jobId,
        commandId: command.id,
        consumedAt: Number(ctx.timestamp.microsSinceUnixEpoch / 1_000n),
        consumedBy: consumeId,
      });
    }
  }
);

export const expireRosterJobLease = spacetimedb.reducer(
  { timer: rosterJobLeaseExpiry.rowType },
  (ctx, { timer }) => {
    const job = ctx.db.rosterJob.id.find(timer.jobId);
    if (!job || !ACTIVE_JOB_STATUSES.has(job.status)) return;
    if (job.leaseFence !== timer.fence) return;
    if (job.leaseUntil && job.leaseUntil.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch) return;
    const willRetry = job.attempt < job.maxAttempts && !job.abortRequested;
    const backoffMs = willRetry ? Math.min(60_000, 1_000 * (2 ** Math.max(0, job.attempt - 1))) : 0;
    ctx.db.rosterJob.id.update({
      ...job,
      status: willRetry ? "queued" : "failed",
      leaseOwner: undefined,
      leaseWorker: "",
      leaseUntil: undefined,
      claimToken: "",
      availableAt: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + BigInt(backoffMs) * 1_000n),
      lastError: "worker lease expired",
      updatedAt: ctx.timestamp,
    });
    appendRosterJobEvent(ctx, job.workspaceId, job.id, "job.lease_expired", {
      type: "job.lease_expired",
      jobId: job.id,
      retryable: job.attempt < job.maxAttempts,
      willRetry,
    });
    if (!willRetry) {
      failRosterNodeWakeForJob(ctx, job.workspaceId, job.id, "worker lease expired");
      releaseWorkspaceJob(ctx, job.workspaceId);
    }
  }
);

export const createCanvasRun = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    runId: t.string(),
    requestId: t.string(),
    prompt: t.string(),
    desiredAgents: t.u32(),
    maxInflight: t.u32(),
    budgetMicros: t.u64(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator", "worker"]);
    const runId = requireText("runId", args.runId, 160);
    const requestId = requireText("requestId", args.requestId, 160);
    const prompt = requireText("prompt", args.prompt, 1_000);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) reject("runId contains unsafe characters");
    if (args.desiredAgents < 3 || args.desiredAgents > 500) reject("desiredAgents must be between 3 and 500");
    if (args.maxInflight < 1 || args.maxInflight > 64 || args.maxInflight > args.desiredAgents) {
      reject("maxInflight must be between 1 and min(64, desiredAgents)");
    }
    const requestKey = `${identityKey(ctx.sender)}:${requestId}`;
    const existingRequest = ctx.db.canvasRun.requestKey.find(requestKey);
    if (existingRequest) {
      if (
        existingRequest.id !== runId
        || existingRequest.prompt !== prompt
        || existingRequest.desiredAgents !== args.desiredAgents
        || existingRequest.maxInflight !== args.maxInflight
        || existingRequest.budgetMicros !== args.budgetMicros
      ) {
        reject("requestId was retried with different run arguments");
      }
      const link = ctx.db.canvasWorkspaceRun.runId.find(existingRequest.id);
      if (!link) ctx.db.canvasWorkspaceRun.insert({ runId: existingRequest.id, workspaceId, createdAt: ctx.timestamp });
      else if (link.workspaceId !== workspaceId) reject("Canvas run belongs to another workspace");
      return;
    }
    if (ctx.db.canvasRun.id.find(runId)) reject(`run ${runId} already exists`);

    ctx.db.canvasRun.insert({
      id: runId,
      owner: ctx.sender,
      requestKey,
      prompt,
      status: "queued",
      desiredAgents: args.desiredAgents,
      maxInflight: args.maxInflight,
      nextReceiptSeq: 0n,
      headReceiptHash: "",
      budgetMicros: args.budgetMicros,
      reservedMicros: 0n,
      spentMicros: 0n,
      sceneHash: "",
      objectCount: 0,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    const maxTasks = Math.min(MAX_ROSTER_TASKS, Math.max(64, args.desiredAgents * 8));
    const executionPolicy = {
      maxTasks,
      maxDepth: 4,
      maxFanout: Math.min(MAX_ROSTER_TASK_FANOUT, Math.max(16, args.maxInflight)),
      maxInflight: args.maxInflight,
      maxReady: Math.min(maxTasks, Math.max(args.maxInflight * 4, args.maxInflight)),
      maxBlocked: maxTasks,
      maxAttempts: 8,
      maxContextBytes: "128000000",
      maxCostMicros: (args.budgetMicros > 0n ? args.budgetMicros : 1n).toString(),
      maxTokens: "2000000000",
      maxWallTimeMs: 86_400_000,
    };
    const deadlineMicros = ctx.timestamp.microsSinceUnixEpoch
      + BigInt(executionPolicy.maxWallTimeMs) * 1_000n;
    ctx.db.rosterExecution.insert({
      runId,
      protocolVersion: ROSTER_PLATFORM_PROTOCOL_VERSION,
      kind: "canvas",
      workspaceId,
      receiptStreamId: "",
      status: "queued",
      policyJson: canonicalJson("Canvas execution policy", executionPolicy, 32_000),
      graphVersion: 0n,
      nextEventSeq: 0n,
      totalTasks: 0,
      readyTasks: 0,
      blockedTasks: 0,
      inflightTasks: 0,
      acceptedTasks: 0,
      failedTasks: 0,
      delegatedTasks: 0,
      canceledTasks: 0,
      skippedTasks: 0,
      contextBytes: 0n,
      reservedCostMicros: 0n,
      spentCostMicros: 0n,
      usedTokens: 0n,
      terminalReason: "",
      deadlineAt: new Timestamp(deadlineMicros),
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    ctx.db.rosterRoom.insert({
      id: runId,
      workspaceId,
      roomKey: `canvas:${runId}`,
      kind: "canvas",
      title: prompt.slice(0, 240),
      status: "active",
      activeRunId: runId,
      certifiedCheckpointId: "",
      nextTimelineSeq: 0n,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    ctx.db.rosterExecutionDeadline.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(deadlineMicros),
      runId,
      deadlineMicros,
    });
    ctx.db.canvasWorkspaceRun.insert({ runId, workspaceId, createdAt: ctx.timestamp });
    ctx.db.canvasRunDetail.insert({
      runId,
      uiStatus: "planning",
      statusNote: "Waiting for the Art Director.",
      modelRoutingJson: "{}",
      configJson: "{}",
      workflowId: "",
      workflowVersion: "",
      promptHash: "",
      promptPath: "",
      planVersion: "",
      reviewSceneHash: "",
      reviewVerdict: "",
      qualityStatus: "",
      totalTasks: 0,
      completedTasks: 0,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    ctx.db.runMember.insert({
      id: membershipKey(runId, ctx.sender),
      runId,
      member: ctx.sender,
      role: "owner",
      createdAt: ctx.timestamp,
    });
    ctx.db.rosterWorkerCapability.insert({
      id: workerCapabilityKey(runId, ctx.sender, "*"),
      runId,
      worker: ctx.sender,
      capability: "*",
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
    });
    appendReceipt(ctx, {
      runId,
      eventId: `run.created:${requestId}`,
      kind: "run.created",
      agentId: "user",
      payloadJson: JSON.stringify({ desiredAgents: args.desiredAgents, maxInflight: args.maxInflight }),
    });
  }
);

/** Idempotent migration hook for Canvas runs created before workspace linking. */
export const linkCanvasRunWorkspace = spacetimedb.reducer(
  { workspaceId: t.string(), runId: t.string() },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const runId = requireText("runId", args.runId, 160);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator"]);
    const run = requireRun(ctx, runId);
    const runMembership = ctx.db.runMember.id.find(membershipKey(runId, ctx.sender));
    if (!run.owner.equals(ctx.sender) && runMembership?.role !== "owner" && runMembership?.role !== "coordinator") {
      reject(`identity cannot link Canvas run ${runId}`);
    }
    const existing = ctx.db.canvasWorkspaceRun.runId.find(runId);
    if (existing) {
      if (existing.workspaceId !== workspaceId) reject(`Canvas run ${runId} belongs to another workspace`);
      return;
    }
    ctx.db.canvasWorkspaceRun.insert({ runId, workspaceId, createdAt: ctx.timestamp });
  }
);

const projectScenePlan = (
  ctx: RosterContext,
  runId: string,
  planValue: unknown,
  planHash: string
): void => {
  const plan = asRecord("scene plan", planValue);
  const planJson = boundedJson("scene plan", plan, 384_000);
  const planVersion = recordString(plan, "planVersion", 256);
  const existing = ctx.db.scenePlan.runId.find(runId);
  if (existing) {
    if (existing.planVersion !== planVersion || existing.planJson !== planJson) {
      reject(`scene plan for ${runId} changed after publication`);
    }
    return;
  }
  const parts = asArray("scene plan parts", plan.parts, 502);
  const anchors = asArray("scene plan anchors", plan.anchors, 64);
  const focalBounds = asRecord("scene plan focalBounds", plan.focalBounds);
  const palette = asRecord("scene plan palette", plan.palette);
  const painterCount = recordU32(plan, "painterCount", 500);
  if (painterCount < 1 || painterCount > parts.length) reject("scene plan painterCount is inconsistent");
  const width = recordU32(plan, "width", 10_000);
  const height = recordU32(plan, "height", 10_000);
  if (width < 1 || height < 1) reject("scene plan dimensions must be positive");
  ctx.db.scenePlan.insert({
    runId,
    planVersion,
    planHash,
    schemaVersion: recordU32(plan, "schemaVersion", 100),
    width,
    height,
    painterCount,
    subject: recordString(plan, "subject", 2_000),
    artDirection: recordString(plan, "artDirection", 12_000),
    focalBoundsJson: boundedJson("scene plan focalBounds", focalBounds, 8_000),
    anchorsJson: boundedJson("scene plan anchors", anchors, 32_000),
    paletteJson: boundedJson("scene plan palette", palette, 8_000),
    partsJson: boundedJson("scene plan parts", parts, 320_000),
    planJson,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  const partIds = new Set<string>();
  for (let ordinal = 0; ordinal < parts.length; ordinal += 1) {
    const part = asRecord(`scene plan part ${ordinal}`, parts[ordinal]);
    const partId = recordString(part, "id", 160);
    if (partIds.has(partId)) reject(`scene plan repeats part ${partId}`);
    partIds.add(partId);
    const coordinatesWith = asArray(`part ${partId} coordinatesWith`, part.coordinatesWith ?? [], 500);
    const needs = asArray(`part ${partId} needs`, part.needs ?? [], 500);
    const region = part.region === undefined ? {} : asRecord(`part ${partId} region`, part.region);
    const maxFootprint = part.maxFootprint === undefined
      ? {}
      : asRecord(`part ${partId} maxFootprint`, part.maxFootprint);
    const protectedAnchors = asArray(`part ${partId} protectedAnchors`, part.protectedAnchors ?? [], 64);
    ctx.db.scenePlanPart.insert({
      id: compoundKey(runId, partId),
      runId,
      partId,
      planVersion,
      ordinal,
      kind: recordString(part, "kind", 40),
      role: recordString(part, "role", 160),
      label: recordString(part, "label", 500),
      artistName: recordString(part, "artistName", 200),
      focus: recordString(part, "focus", 2_000),
      objective: recordString(part, "objective", 4_000),
      compositionRole: optionalRecordString(part, "compositionRole", 40),
      paintMode: optionalRecordString(part, "paintMode", 40),
      coordinatesWithJson: boundedJson(`part ${partId} coordinatesWith`, coordinatesWith, 32_000),
      needsJson: boundedJson(`part ${partId} needs`, needs, 32_000),
      outputKey: recordString(part, "outputKey", 200),
      regionJson: boundedJson(`part ${partId} region`, region, 8_000),
      maxFootprintJson: boundedJson(`part ${partId} maxFootprint`, maxFootprint, 8_000),
      protectedAnchorsJson: boundedJson(`part ${partId} protectedAnchors`, protectedAnchors, 8_000),
      allowBleed: optionalRecordBoolean(part, "allowBleed"),
      layerBase: optionalRecordU32(part, "layerBase", 100_000),
      minObjects: optionalRecordU32(part, "minObjects", 256),
      maxObjects: optionalRecordU32(part, "maxObjects", 256),
      createdAt: ctx.timestamp,
    });
  }
  const detail = ensureRunDetail(ctx, runId);
  ctx.db.canvasRunDetail.runId.update({
    ...detail,
    uiStatus: "running",
    planVersion,
    statusNote: `${painterCount} artist responsibilities are ready.`,
    updatedAt: ctx.timestamp,
  });
};

const projectCanvasAgent = (
  ctx: RosterContext,
  runId: string,
  agentValue: unknown,
  status = "idle"
): void => {
  const agent = asRecord("canvas agent", agentValue);
  const agentId = recordString(agent, "id", 160);
  const metadata = agent.metadata === undefined ? {} : asRecord(`agent ${agentId} metadata`, agent.metadata);
  const capabilities = asArray(`agent ${agentId} capabilities`, agent.capabilities ?? [], 64);
  const role = optionalRecordString(metadata, "role", 160)
    || (typeof capabilities[0] === "string" ? capabilities[0].slice(0, 160) : "worker");
  const id = canvasAgentKey(runId, agentId);
  const existing = ctx.db.canvasAgent.id.find(id);
  const row = {
    id,
    runId,
    agentId,
    name: recordString(agent, "name", 200),
    role,
    group: optionalRecordString(metadata, "group", 160),
    focus: optionalRecordString(metadata, "focus", 2_000),
    assignment: optionalRecordString(metadata, "assignment", 2_000),
    model: optionalRecordString(metadata, "model", 160),
    status,
    taskId: existing?.taskId ?? "",
    metadataJson: boundedJson(`agent ${agentId} metadata`, metadata, 16_000),
    createdAt: existing?.createdAt ?? ctx.timestamp,
    updatedAt: ctx.timestamp,
  };
  if (existing) ctx.db.canvasAgent.id.update(row);
  else ctx.db.canvasAgent.insert(row);
};

const recomputeCanvasProgress = (ctx: RosterContext, runId: string): void => {
  let totalTasks = 0;
  let completedTasks = 0;
  for (const task of ctx.db.canvasTaskStatus.runId.filter(runId)) {
    totalTasks += 1;
    if (task.status === "completed") completedTasks += 1;
  }
  const detail = ensureRunDetail(ctx, runId);
  ctx.db.canvasRunDetail.runId.update({ ...detail, totalTasks, completedTasks, updatedAt: ctx.timestamp });
};

const projectCanvasTask = (
  ctx: RosterContext,
  runId: string,
  event: JsonRecord,
  status: "planned" | "delegated" | "running" | "completed" | "failed"
): void => {
  const taskId = recordString(event, "taskId", 160);
  const id = canvasTaskStatusKey(runId, taskId);
  const existing = ctx.db.canvasTaskStatus.id.find(id);
  const attempt = optionalRecordU32(event, "attempt", 100, existing?.attempt ?? 0);
  if (
    existing
    && (existing.status === "completed" || existing.status === "failed")
    && status !== existing.status
    && attempt <= existing.attempt
  ) {
    reject(`task ${taskId} cannot regress from ${existing.status} to ${status}`);
  }
  const nodeId = optionalRecordString(event, "nodeId", 160) || existing?.agentId || "orchestrator";
  const artifactIds = event.artifactIds === undefined
    ? JSON.parse(existing?.artifactIdsJson ?? "[]")
    : asArray(`task ${taskId} artifactIds`, event.artifactIds, 256);
  const needs = event.needs === undefined
    ? JSON.parse(existing?.needsJson ?? "[]")
    : asArray(`task ${taskId} needs`, event.needs, 500);
  const provides = event.provides === undefined
    ? JSON.parse(existing?.providesJson ?? "[]")
    : asArray(`task ${taskId} provides`, event.provides, 500);
  const inputVersions = event.inputVersions === undefined
    ? JSON.parse(existing?.inputVersionsJson ?? "{}")
    : asRecord(`task ${taskId} inputVersions`, event.inputVersions);
  const row = {
    id,
    runId,
    taskId,
    delegationId: optionalRecordString(event, "delegationId", 256) || existing?.delegationId || "",
    agentId: nodeId,
    capability: optionalRecordString(event, "capability", 160) || existing?.capability || "",
    objective: optionalRecordString(event, "objective", 4_000) || existing?.objective || "",
    parentTaskId: optionalRecordString(event, "parentTaskId", 160) || existing?.parentTaskId || "",
    planId: optionalRecordString(event, "planId", 160) || existing?.planId || "",
    planVersion: optionalRecordString(event, "planVersion", 256) || existing?.planVersion || "",
    status,
    attempt,
    needsJson: boundedJson(`task ${taskId} needs`, needs, 32_000),
    providesJson: boundedJson(`task ${taskId} provides`, provides, 32_000),
    inputVersionsJson: boundedJson(`task ${taskId} inputVersions`, inputVersions, 64_000),
    artifactIdsJson: boundedJson(`task ${taskId} artifactIds`, artifactIds, 32_000),
    error: optionalRecordString(event, "error", 4_000) || (status === "failed" ? "Task failed" : ""),
    createdAt: existing?.createdAt ?? ctx.timestamp,
    updatedAt: ctx.timestamp,
  };
  if (existing) ctx.db.canvasTaskStatus.id.update(row);
  else ctx.db.canvasTaskStatus.insert(row);
  const agent = ctx.db.canvasAgent.id.find(canvasAgentKey(runId, nodeId));
  if (agent) ctx.db.canvasAgent.id.update({ ...agent, status, taskId, updatedAt: ctx.timestamp });
  recomputeCanvasProgress(ctx, runId);
};

const CANVAS_OBJECT_TYPES = new Set(["group", "ellipse", "circle", "line", "polygon", "polyline", "path", "rect"]);

const projectScenePatch = (
  ctx: RosterContext,
  runId: string,
  event: JsonRecord,
  eventHash: string
): void => {
  const patch = asRecord("scene patch", event.patch);
  const patchId = recordString(patch, "patchId", 200);
  const patchRunId = recordString(patch, "runId", 160);
  if (patchRunId !== runId) reject(`patch ${patchId} belongs to another run`);
  const planVersion = recordString(patch, "planVersion", 256);
  const plan = expectValue(ctx.db.scenePlan.runId.find(runId), `scene plan for ${runId} is not published`);
  if (plan.planVersion !== planVersion) reject(`patch ${patchId} targets a stale plan`);
  const agentId = recordString(patch, "agentId", 160);
  const taskId = recordString(patch, "taskId", 160);
  const partId = recordString(patch, "partId", 160);
  if (recordString(event, "agentId", 160) !== agentId) {
    reject(`patch ${patchId} does not match its event authority`);
  }
  const planPart = expectValue(
    ctx.db.scenePlanPart.id.find(compoundKey(runId, partId)),
    `patch ${patchId} targets unknown plan part ${partId}`
  );
  if (planPart.kind !== "painter") reject(`patch ${patchId} targets a non-painter plan part`);
  const projectedAgent = expectValue(
    ctx.db.canvasAgent.id.find(canvasAgentKey(runId, agentId)),
    `patch ${patchId} references unknown agent ${agentId}`
  );
  const agentMetadata = parseJsonRecord(`agent ${agentId} metadata`, projectedAgent.metadataJson, 16_000);
  const projectedTask = expectValue(
    ctx.db.canvasTaskStatus.id.find(canvasTaskStatusKey(runId, taskId)),
    `patch ${patchId} references unknown task ${taskId}`
  );
  if (projectedTask.agentId !== agentId) reject(`task ${taskId} belongs to another agent`);
  const baseSceneHash = recordString(patch, "baseSceneHash", 256);
  const supersedesPatchId = optionalRecordString(patch, "supersedesPatchId", 200);
  const assignedPartId = optionalRecordString(agentMetadata, "partId", 160);
  const isFencedFinishingRepairTask = /^repair\.(?:first|final|rescue)\.[a-z][a-z0-9-]{1,30}\.[0-9a-f]{12}$/.test(taskId);
  const isDelegatedFinishingRepair = projectedAgent.role === "composer"
    && projectedTask.capability === "compose.final"
    && supersedesPatchId.length > 0
    && isFencedFinishingRepairTask;
  if (assignedPartId !== partId && !isDelegatedFinishingRepair) {
    reject(`agent ${agentId} is not assigned to plan part ${partId}`);
  }
  const objects = asArray(`patch ${patchId} objects`, patch.objects, 256);
  if (objects.length < 1) reject(`patch ${patchId} has no objects`);
  const patchJson = boundedJson(`patch ${patchId}`, patch, 384_000);
  const updateHash = recordString(event, "updateHash", 256);
  const existingData = ctx.db.scenePatchData.patchId.find(patchId);
  if (existingData) {
    if (existingData.patchJson !== patchJson || existingData.updateHash !== updateHash) {
      reject(`patch ${patchId} changed after publication`);
    }
    return;
  }
  if (ctx.db.scenePatch.patchId.find(patchId)) reject(`patch ${patchId} is missing immutable data`);

  if (supersedesPatchId) {
    const parent = expectValue(
      ctx.db.scenePatchData.patchId.find(supersedesPatchId),
      `patch ${patchId} supersedes an unknown patch`
    );
    if (
      !parent.active
      || parent.runId !== runId
      || parent.planVersion !== planVersion
      || parent.partId !== partId
    ) {
      reject(`patch ${patchId} crosses or competes with its active revision boundary`);
    }
    ctx.db.scenePatchData.patchId.update({ ...parent, active: false });
    for (const object of ctx.db.sceneObject.patchId.filter(supersedesPatchId)) {
      if (object.active) ctx.db.sceneObject.id.update({ ...object, active: false, updatedAt: ctx.timestamp });
    }
  } else {
    for (const candidate of ctx.db.scenePatchData.runId.filter(runId)) {
      if (candidate.active && candidate.planVersion === planVersion && candidate.partId === partId) {
        reject(`part ${partId} already has an active patch`);
      }
    }
  }

  const contentRef = `spacetimedb:scene_patch_data/${patchId}`;
  ctx.db.scenePatch.insert({
    patchId,
    runId,
    partId,
    agentId,
    taskKey: taskKey(runId, taskId),
    supersedesPatchId,
    contentRef,
    contentHash: eventHash,
    objectCount: objects.length,
    createdAt: ctx.timestamp,
  });
  ctx.db.scenePatchData.insert({
    patchId,
    runId,
    planVersion,
    baseSceneHash,
    partId,
    agentId,
    taskId,
    supersedesPatchId,
    contentRef,
    contentHash: eventHash,
    updateHash,
    patchJson,
    objectCount: objects.length,
    active: true,
    createdAt: ctx.timestamp,
  });

  const objectIds = new Set<string>();
  for (let index = 0; index < objects.length; index += 1) {
    const object = asRecord(`patch ${patchId} object ${index}`, objects[index]);
    const objectId = recordString(object, "id", 240);
    if (objectIds.has(objectId)) reject(`patch ${patchId} repeats object ${objectId}`);
    objectIds.add(objectId);
    const ownerAgentId = recordString(object, "ownerAgentId", 160);
    const objectTaskId = recordString(object, "taskId", 160);
    const objectPartId = recordString(object, "partId", 160);
    if (ownerAgentId !== agentId || objectTaskId !== taskId || objectPartId !== partId) {
      reject(`object ${objectId} crosses its patch ownership boundary`);
    }
    const objectType = recordString(object, "type", 40);
    if (!CANVAS_OBJECT_TYPES.has(objectType)) reject(`object ${objectId} has an unsupported type`);
    const geometry = asRecord(`object ${objectId} geometry`, object.geometry);
    const style = asRecord(`object ${objectId} style`, object.style ?? {});
    ctx.db.sceneObject.insert({
      id: sceneObjectKey(patchId, objectId),
      runId,
      patchId,
      objectId,
      semanticId: recordString(object, "semanticId", 240),
      ownerAgentId,
      taskId: objectTaskId,
      partId: objectPartId,
      objectType,
      geometryJson: boundedJson(`object ${objectId} geometry`, geometry, 16_000),
      styleJson: boundedJson(`object ${objectId} style`, style, 4_000),
      layer: recordU32(object, "layer", 100_000),
      rank: optionalRecordU32(object, "rank", 1_000_000),
      active: true,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }
  const run = requireRun(ctx, runId);
  let activeObjectCount = 0;
  for (const object of ctx.db.sceneObject.runId.filter(runId)) {
    if (object.active) activeObjectCount += 1;
  }
  ctx.db.canvasRun.id.update({ ...run, objectCount: activeObjectCount, updatedAt: ctx.timestamp });
};

const projectSceneReview = (
  ctx: RosterContext,
  runId: string,
  eventId: string,
  event: JsonRecord
): void => {
  const review = asRecord("scene review", event.review);
  const sceneHash = recordString(event, "sceneHash", 256);
  const verdict = recordString(review, "verdict", 40);
  if (verdict !== "pass" && verdict !== "fail") reject("scene review verdict must be pass or fail");
  const qualityStatus = optionalRecordString(review, "qualityStatus", 80);
  const scope = recordString(review, "scope", 80);
  const scores = review.scores === undefined ? {} : asRecord("scene review scores", review.scores);
  const checks = asArray("scene review checks", review.checks, 128);
  const notes = asArray("scene review notes", review.notes ?? [], 128);
  const id = sceneReviewKey(runId, eventId);
  const agentId = optionalRecordString(event, "agentId", 160) || "critic";
  const row = {
    id,
    runId,
    sceneHash,
    agentId,
    verdict,
    qualityStatus,
    scope,
    scoresJson: boundedJson("scene review scores", scores, 8_000),
    checksJson: boundedJson("scene review checks", checks, 32_000),
    notesJson: boundedJson("scene review notes", notes, 64_000),
    createdAt: ctx.timestamp,
  };
  const existing = ctx.db.sceneReview.id.find(id);
  if (existing) {
    if (boundedJson("existing scene review", existing, 128_000) !== boundedJson("scene review", row, 128_000)) {
      reject(`scene review ${eventId} changed after publication`);
    }
    return;
  }
  ctx.db.sceneReview.insert(row);
  const detail = ensureRunDetail(ctx, runId);
  ctx.db.canvasRunDetail.runId.update({
    ...detail,
    uiStatus: "reviewing",
    reviewSceneHash: sceneHash,
    reviewVerdict: verdict,
    qualityStatus,
    statusNote: verdict === "pass" ? "The rendered scene passed visual review." : "Targeted visual repair requested.",
    updatedAt: ctx.timestamp,
  });
};

/**
 * Atomically project one complete CanvasEvent and append its receipt.
 *
 * The full event remains available to the trusted runtime through my_receipts;
 * browser viewers consume the bounded activity and typed projection views.
 */
export const projectCanvasEvent = spacetimedb.reducer(
  {
    runId: t.string(),
    coordinatorTaskId: t.string(),
    coordinatorFence: t.u64(),
    eventId: t.string(),
    expectedPrev: t.string(),
    eventHash: t.string(),
    kind: t.string(),
    agentId: t.string(),
    eventJson: t.string(),
    summary: t.string(),
  },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const coordinatorTaskId = requireText("coordinatorTaskId", args.coordinatorTaskId, 160);
    const coordinatorLease = requireActiveRosterTaskLease(
      ctx,
      runId,
      coordinatorTaskId,
      args.coordinatorFence
    );
    if (coordinatorLease.capability !== "coordinate.canvas") {
      reject("Canvas events require the active run coordinator lease");
    }
    const eventId = requireText("eventId", args.eventId, 240);
    const eventHash = requireText("eventHash", args.eventHash, 64);
    if (!/^[0-9a-f]{64}$/.test(eventHash)) reject("eventHash must be a lowercase SHA-256 hex digest");
    const kind = requireText("kind", args.kind, 120);
    const agentId = requireText("agentId", args.agentId, 160);
    const eventJson = requireJson("eventJson", args.eventJson, 512_000);
    const summary = requireText("summary", args.summary, 1_000);
    if (args.expectedPrev.length > 256 || args.expectedPrev === "*") {
      reject("expectedPrev must be the exact current receipt hash");
    }
    const expectedPrev = args.expectedPrev.trim();
    const event = asRecord("CanvasEvent", JSON.parse(eventJson));
    if (recordString(event, "type", 120) !== kind) reject("CanvasEvent type does not match kind");
    const eventRunId = optionalRecordString(event, "runId", 160);
    if (eventRunId && eventRunId !== runId) reject("CanvasEvent belongs to another run");
    const eventAgentId = optionalRecordString(event, "agentId", 160);
    if (eventAgentId && eventAgentId !== agentId) reject("CanvasEvent agent does not match receipt authority");

    const membership = requireMembership(ctx, runId, ["owner", "coordinator", "worker", "artist"]);
    const coordinatorKinds = new Set([
      "prompt.set",
      "run.configured",
      "run.status",
      "scene.planned",
      "scene.reviewed",
      "scene.finalized",
      "orchestration.configured",
      "node.spawned",
      "node.retired",
      "plan.created",
      "plan.started",
      "plan.completed",
      "plan.failed",
      "plan.rejected",
      "reflection.recorded",
      "topology.selected",
      "composition.proposed",
      "composition.certified",
      "composition.rejected",
      "control.update.published",
      "control.frontier.projected",
      "control.frontier.certified",
    ]);
    if (coordinatorKinds.has(kind) && membership.role !== "owner" && membership.role !== "coordinator") {
      reject(`${kind} requires coordinator authority`);
    }

    const existingReceipt = ctx.db.receipt.id.find(receiptKey(runId, eventId));
    if (existingReceipt) {
      if (
        existingReceipt.hash !== eventHash
        || existingReceipt.kind !== kind
        || existingReceipt.agentId !== agentId
        || existingReceipt.payloadJson !== eventJson
      ) {
        reject(`event ${eventId} changed after publication`);
      }
      return;
    }
    const run = requireRun(ctx, runId);
    const isTerminalFollowup = kind === "run.status"
      && recordString(event, "status", 40) === "completed"
      && (run.status === "completed" || run.status === "completed_with_notes");
    if (TERMINAL_RUN_STATUSES.has(run.status) && !isTerminalFollowup) reject(`run ${runId} is terminal`);

    switch (kind) {
      case "prompt.set": {
        const prompt = recordString(event, "prompt", 1_000);
        if (prompt !== run.prompt) reject("prompt.set does not match the immutable run prompt");
        break;
      }
      case "run.configured": {
        const detail = ensureRunDetail(ctx, runId);
        const workflow = asRecord("run workflow", event.workflow);
        const config = asRecord("run config", event.config);
        const models = asRecord("run model routing", event.models);
        ctx.db.canvasRunDetail.runId.update({
          ...detail,
          uiStatus: "planning",
          modelRoutingJson: boundedJson("run model routing", models, 8_000),
          configJson: boundedJson("run config", config, 8_000),
          workflowId: recordString(workflow, "id", 160),
          workflowVersion: recordString(workflow, "version", 160),
          promptHash: optionalRecordString(event, "promptHash", 256),
          promptPath: optionalRecordString(event, "promptPath", 1_000),
          statusNote: "The Art Director is interpreting the visual brief.",
          updatedAt: ctx.timestamp,
        });
        const existingDirector = ctx.db.canvasAgent.id.find(canvasAgentKey(runId, "orchestrator"));
        const director = {
          id: canvasAgentKey(runId, "orchestrator"),
          runId,
          agentId: "orchestrator",
          name: "Art Director",
          role: "coordinator",
          group: "Direction",
          focus: "Prompt interpretation and scene contract",
          assignment: "Direct the shared visual composition",
          model: typeof models.director === "string" ? models.director.slice(0, 160) : "",
          status: "running",
          taskId: "",
          metadataJson: "{}",
          createdAt: existingDirector?.createdAt ?? ctx.timestamp,
          updatedAt: ctx.timestamp,
        };
        if (existingDirector) ctx.db.canvasAgent.id.update(director);
        else ctx.db.canvasAgent.insert(director);
        break;
      }
      case "run.status": {
        const status = recordString(event, "status", 40);
        if (!["planning", "running", "reviewing", "completed", "failed"].includes(status)) {
          reject(`unsupported Canvas run status ${status}`);
        }
        const detail = ensureRunDetail(ctx, runId);
        const uiStatus = status;
        ctx.db.canvasRunDetail.runId.update({
          ...detail,
          uiStatus,
          statusNote: optionalRecordString(event, "note", 2_000) || detail.statusNote,
          updatedAt: ctx.timestamp,
        });
        if (!isTerminalFollowup) {
          ctx.db.canvasRun.id.update({
            ...run,
            status: status === "failed" ? "failed" : status,
            updatedAt: ctx.timestamp,
          });
        }
        if (status === "completed") {
          for (const agent of ctx.db.canvasAgent.runId.filter(runId)) {
            if (agent.status !== "retired") {
              ctx.db.canvasAgent.id.update({ ...agent, status, taskId: "", updatedAt: ctx.timestamp });
            }
          }
        } else if (status === "failed") {
          for (const agent of ctx.db.canvasAgent.runId.filter(runId)) {
            if (agent.status === "retired" || agent.status === "completed" || agent.status === "failed") continue;
            const nextStatus = agent.agentId === "orchestrator"
              || ["delegated", "leased", "running"].includes(agent.status)
              ? "failed"
              : "blocked";
            ctx.db.canvasAgent.id.update({ ...agent, status: nextStatus, taskId: "", updatedAt: ctx.timestamp });
          }
        }
        break;
      }
      case "scene.planned":
        projectScenePlan(ctx, runId, event.plan, eventHash);
        break;
      case "node.spawned":
        projectCanvasAgent(ctx, runId, event.node, "idle");
        break;
      case "node.retired": {
        const retiredNodeId = recordString(event, "nodeId", 160);
        const existing = ctx.db.canvasAgent.id.find(canvasAgentKey(runId, retiredNodeId));
        if (existing) {
          ctx.db.canvasAgent.id.update({ ...existing, status: "retired", taskId: "", updatedAt: ctx.timestamp });
        }
        break;
      }
      case "plan.created": {
        const tasks = asArray("plan tasks", event.tasks, 1_024);
        for (const taskValue of tasks) {
          const task = asRecord("plan task", taskValue);
          projectCanvasTask(ctx, runId, {
            ...task,
            planId: recordString(event, "planId", 160),
            planVersion: recordString(event, "planVersion", 256),
          }, "planned");
        }
        break;
      }
      case "task.delegated":
        projectCanvasTask(ctx, runId, event, "delegated");
        break;
      case "task.started":
        projectCanvasTask(ctx, runId, event, "running");
        break;
      case "task.completed":
        projectCanvasTask(ctx, runId, event, "completed");
        break;
      case "task.failed":
        projectCanvasTask(ctx, runId, event, "failed");
        break;
      case "scene.patch.applied":
        projectScenePatch(ctx, runId, event, eventHash);
        break;
      case "scene.reviewed":
        projectSceneReview(ctx, runId, eventId, event);
        break;
      case "scene.finalized": {
        const sceneHash = recordString(event, "sceneHash", 256);
        const requestedObjectCount = recordU32(event, "objectCount", 100_000);
        let activeObjectCount = 0;
        for (const object of ctx.db.sceneObject.runId.filter(runId)) {
          if (object.active) activeObjectCount += 1;
        }
        if (activeObjectCount !== requestedObjectCount) {
          reject(`scene.finalized object count ${requestedObjectCount} does not match ${activeObjectCount} active objects`);
        }
        let passingReview = false;
        let acceptedWithNotes = false;
        for (const review of ctx.db.sceneReview.runId.filter(runId)) {
          if (review.sceneHash !== sceneHash || review.verdict !== "pass") continue;
          passingReview = true;
          if (review.qualityStatus === "accepted-with-notes") acceptedWithNotes = true;
        }
        if (!passingReview) reject("scene.finalized requires a passing review of the same scene hash");
        ctx.db.canvasRun.id.update({
          ...run,
          status: acceptedWithNotes ? "completed_with_notes" : "completed",
          sceneHash,
          objectCount: activeObjectCount,
          updatedAt: ctx.timestamp,
        });
        const detail = ensureRunDetail(ctx, runId);
        ctx.db.canvasRunDetail.runId.update({
          ...detail,
          uiStatus: "completed",
          reviewSceneHash: sceneHash,
          qualityStatus: acceptedWithNotes ? "accepted-with-notes" : "certified",
          statusNote: acceptedWithNotes
            ? "Scene completed with visual notes."
            : "Scene certified against the complete visual frontier.",
          updatedAt: ctx.timestamp,
        });
        break;
      }
      default:
        // The receipt remains authoritative for orchestration events that do
        // not have a dedicated browser projection.
        break;
    }

    appendReceipt(ctx, {
      runId,
      eventId,
      kind,
      agentId,
      payloadJson: eventJson,
      hash: eventHash,
      expectedPrev,
      summary,
    });
  }
);

export const addRunMember = spacetimedb.reducer(
  { runId: t.string(), member: t.identity(), role: t.string() },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const role = requireText("role", args.role, 32);
    requireMembership(ctx, runId, ["owner"]);
    if (!RUN_ROLES.has(role) || role === "owner") reject("invalid delegated run role");
    const id = membershipKey(runId, args.member);
    // An explicit owner delegation is durable even when this identity first
    // reached the run through a temporary viewer capability.
    if (ctx.db.viewerCapabilityRunMember.id.find(id)) {
      ctx.db.viewerCapabilityRunMember.id.delete(id);
    }
    const existing = ctx.db.runMember.id.find(id);
    if (existing) {
      ctx.db.runMember.id.update({ ...existing, role });
    } else {
      ctx.db.runMember.insert({ id, runId, member: args.member, role, createdAt: ctx.timestamp });
    }
    appendReceipt(ctx, {
      runId,
      eventId: `member:${identityKey(args.member)}:${role}`,
      kind: "run.member.updated",
      agentId: "owner",
      payloadJson: JSON.stringify({ member: identityKey(args.member), role }),
    });
  }
);

/** Only workspace owners and coordinators may replace a worker's capability set. */
export const setRosterWorkerCapabilities = spacetimedb.reducer(
  { runId: t.string(), member: t.identity(), capabilitiesJson: t.string() },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const execution = requireActiveRosterExecution(ctx, runId);
    requireRosterCoordinator(ctx, execution);
    const member = expectValue(
      ctx.db.rosterWorkspaceMember.id.find(workspaceMembershipKey(execution.workspaceId, args.member)),
      "capability target is not a workspace member"
    );
    if (member.role === "viewer") reject("viewer identities cannot receive worker capabilities");
    const capabilities = normalizeCapabilities(args.capabilitiesJson);
    const current = [];
    for (const grant of ctx.db.rosterWorkerCapability.worker.filter(args.member)) {
      if (grant.runId === runId) current.push(grant.capability);
    }
    current.sort();
    if (
      current.length === capabilities.length
      && current.every((capability, index) => capability === capabilities[index])
    ) return;
    for (const grant of ctx.db.rosterWorkerCapability.worker.filter(args.member)) {
      if (grant.runId === runId) ctx.db.rosterWorkerCapability.id.delete(grant.id);
    }
    for (const capability of capabilities) {
      ctx.db.rosterWorkerCapability.insert({
        id: workerCapabilityKey(runId, args.member, capability),
        runId,
        worker: args.member,
        capability,
        createdBy: ctx.sender,
        createdAt: ctx.timestamp,
      });
    }
    appendRosterExecutionEvent(ctx, runId, "roster.worker.capabilities.configured", "", {
      member: identityKey(args.member),
      capabilities,
    });
  }
);

/** Create a bearer capability that can only grant the read-only viewer role. */
export const createViewerCapability = spacetimedb.reducer(
  {
    runId: t.string(),
    capabilityId: t.string(),
    capabilityHash: t.string(),
    maxUses: t.u32(),
    ttlSeconds: t.u32(),
  },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const capabilityId = requireText("capabilityId", args.capabilityId, 160);
    const capabilityHash = requireText("capabilityHash", args.capabilityHash, 64);
    const canvas = ctx.db.canvasRun.id.find(runId);
    if (canvas) {
      requireMembership(ctx, runId, ["owner", "coordinator"]);
    } else {
      const execution = requireRosterExecution(ctx, runId);
      ensureRosterRunCoordinatorMembership(ctx, execution);
    }
    if (!/^[0-9a-f]{64}$/.test(capabilityHash)) reject("capabilityHash must be a lowercase SHA-256 hex digest");
    if (args.maxUses < 1 || args.maxUses > 10_000) reject("maxUses must be between 1 and 10000");
    if (args.ttlSeconds !== 0 && (args.ttlSeconds < 1 || args.ttlSeconds > 2_592_000)) {
      reject("ttlSeconds must be 0 or between 1 and 2592000");
    }
    const existingById = ctx.db.viewerCapability.capabilityId.find(capabilityId);
    const existingByHash = ctx.db.viewerCapability.capabilityHash.find(capabilityHash);
    if (existingById || existingByHash) {
      const existing = existingById ?? existingByHash!;
      if (
        existing.runId !== runId
        || existing.capabilityId !== capabilityId
        || existing.capabilityHash !== capabilityHash
        || existing.maxUses !== args.maxUses
        || existing.ttlSeconds !== args.ttlSeconds
      ) {
        reject("viewer capability changed after creation");
      }
      return;
    }
    const expiresAt = args.ttlSeconds === 0
      ? undefined
      : new Timestamp(ctx.timestamp.microsSinceUnixEpoch + BigInt(args.ttlSeconds) * 1_000_000n);
    ctx.db.viewerCapability.insert({
      capabilityHash,
      capabilityId,
      runId,
      maxUses: args.maxUses,
      uses: 0,
      ttlSeconds: args.ttlSeconds,
      expiresAt,
      revoked: false,
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    if (expiresAt) {
      ctx.db.viewerCapabilityExpiration.insert({
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(expiresAt.microsSinceUnixEpoch),
        capabilityId,
        expiresAtMicros: expiresAt.microsSinceUnixEpoch,
      });
    }
    const audit = { capabilityId, maxUses: args.maxUses, ttlSeconds: args.ttlSeconds };
    if (canvas) {
      appendReceipt(ctx, {
        runId,
        eventId: `viewer.capability.created:${capabilityId}`,
        kind: "viewer.capability.created",
        agentId: "access-control",
        payloadJson: JSON.stringify(audit),
      });
    } else {
      appendRosterExecutionEvent(ctx, runId, "viewer.capability.created", "access-control", audit);
    }
  }
);

const activeViewerCapability = (
  ctx: RosterContext,
  capabilityId: string
): ReturnType<typeof ctx.db.viewerCapability.capabilityId.find> => {
  const capability = ctx.db.viewerCapability.capabilityId.find(capabilityId);
  if (!capability || capability.revoked) return null;
  if (
    capability.expiresAt
    && capability.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch
  ) return null;
  return capability;
};

const viewerHasActiveRunGrant = (
  ctx: RosterContext,
  runId: string,
  member: Identity
): boolean => {
  for (const redemption of ctx.db.viewerRedemption.member.filter(member)) {
    if (redemption.runId === runId && activeViewerCapability(ctx, redemption.capabilityId)) return true;
  }
  return false;
};

const removeViewerCapabilityAccess = (
  ctx: RosterContext,
  capabilityId: string,
  runId: string
): void => {
  const affectedMembers: Identity[] = [];
  for (const redemption of ctx.db.viewerRedemption.capabilityId.filter(capabilityId)) {
    affectedMembers.push(redemption.member);
    ctx.db.viewerRedemption.id.delete(redemption.id);
  }
  for (const member of affectedMembers) {
    if (viewerHasActiveRunGrant(ctx, runId, member)) continue;
    const memberId = membershipKey(runId, member);
    if (!ctx.db.viewerCapabilityRunMember.id.find(memberId)) continue;
    const membership = ctx.db.runMember.id.find(memberId);
    if (membership?.role === "viewer") ctx.db.runMember.id.delete(memberId);
    ctx.db.viewerCapabilityRunMember.id.delete(memberId);
  }
};

export const revokeViewerCapability = spacetimedb.reducer(
  { runId: t.string(), capabilityId: t.string() },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const capabilityId = requireText("capabilityId", args.capabilityId, 160);
    const canvas = ctx.db.canvasRun.id.find(runId);
    if (canvas) {
      requireMembership(ctx, runId, ["owner", "coordinator"]);
    } else {
      ensureRosterRunCoordinatorMembership(ctx, requireRosterExecution(ctx, runId));
    }
    const capability = expectValue(
      ctx.db.viewerCapability.capabilityId.find(capabilityId),
      `viewer capability ${capabilityId} does not exist`
    );
    if (capability.runId !== runId) reject("viewer capability belongs to another run");
    if (capability.revoked) return;
    ctx.db.viewerCapability.capabilityHash.update({ ...capability, revoked: true, updatedAt: ctx.timestamp });
    removeViewerCapabilityAccess(ctx, capabilityId, runId);
    if (canvas) {
      appendReceipt(ctx, {
        runId,
        eventId: `viewer.capability.revoked:${capabilityId}`,
        kind: "viewer.capability.revoked",
        agentId: "access-control",
        payloadJson: JSON.stringify({ capabilityId }),
      });
    } else {
      appendRosterExecutionEvent(ctx, runId, "viewer.capability.revoked", "access-control", { capabilityId });
    }
  }
);

/** Redeem a private bearer token and join a run as a read-only viewer. */
export const joinCanvasRun = spacetimedb.reducer(
  { runId: t.string(), capabilityHash: t.string() },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const capabilityHash = requireText("capabilityHash", args.capabilityHash, 64);
    if (!/^[0-9a-f]{64}$/.test(capabilityHash)) reject("capabilityHash must be a lowercase SHA-256 hex digest");
    const capability = expectValue(
      ctx.db.viewerCapability.capabilityHash.find(capabilityHash),
      "viewer capability is invalid"
    );
    if (capability.runId !== runId) reject("viewer capability is invalid");
    if (capability.revoked) reject("viewer capability has been revoked");
    if (
      capability.expiresAt
      && capability.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch
    ) {
      reject("viewer capability has expired");
    }
    const redemptionId = compoundKey(capability.capabilityId, identityKey(ctx.sender));
    if (ctx.db.viewerRedemption.id.find(redemptionId)) return;
    if (capability.uses >= capability.maxUses) reject("viewer capability is exhausted");
    const id = membershipKey(capability.runId, ctx.sender);
    const membership = ctx.db.runMember.id.find(id);
    if (membership && membership.role !== "viewer") return;
    if (!membership) {
      ctx.db.runMember.insert({
        id,
        runId: capability.runId,
        member: ctx.sender,
        role: "viewer",
        createdAt: ctx.timestamp,
      });
      ctx.db.viewerCapabilityRunMember.insert({
        id,
        runId: capability.runId,
        member: ctx.sender,
        createdAt: ctx.timestamp,
      });
    }
    ctx.db.viewerCapability.capabilityHash.update({
      ...capability,
      uses: capability.uses + 1,
      updatedAt: ctx.timestamp,
    });
    ctx.db.viewerRedemption.insert({
      id: redemptionId,
      capabilityId: capability.capabilityId,
      runId: capability.runId,
      member: ctx.sender,
      createdAt: ctx.timestamp,
    });
    if (ctx.db.canvasRun.id.find(capability.runId)) {
      appendReceipt(ctx, {
        runId: capability.runId,
        eventId: `viewer.joined:${identityKey(ctx.sender)}`,
        kind: "viewer.joined",
        agentId: "viewer",
        payloadJson: JSON.stringify({ capabilityId: capability.capabilityId }),
      });
    } else {
      appendRosterExecutionEvent(ctx, capability.runId, "viewer.joined", "viewer", {
        capabilityId: capability.capabilityId,
      });
    }
  }
);

export const expireViewerCapabilityAccess = spacetimedb.reducer(
  { timer: viewerCapabilityExpiration.rowType },
  (ctx, { timer }) => {
    const capability = ctx.db.viewerCapability.capabilityId.find(timer.capabilityId);
    if (!capability?.expiresAt
      || capability.expiresAt.microsSinceUnixEpoch !== timer.expiresAtMicros
      || capability.expiresAt.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch) return;
    removeViewerCapabilityAccess(ctx, capability.capabilityId, capability.runId);
  }
);

/** Allow an authenticated workspace member to open any Canvas run linked to that workspace. */
export const joinCanvasWorkspaceRun = spacetimedb.reducer(
  { workspaceId: t.string(), runId: t.string() },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const runId = requireText("runId", args.runId, 160);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator", "worker", "viewer"]);
    expectValue(ctx.db.canvasRun.id.find(runId), `Canvas run ${runId} does not exist`);
    const link = ctx.db.canvasWorkspaceRun.runId.find(runId);
    if (!link || link.workspaceId !== workspaceId) reject(`Canvas run ${runId} does not belong to workspace ${workspaceId}`);
    const id = membershipKey(runId, ctx.sender);
    if (ctx.db.runMember.id.find(id)) {
      // Workspace membership is an independent durable origin. Preserve it
      // when a temporary capability for the same identity later disappears.
      if (ctx.db.viewerCapabilityRunMember.id.find(id)) {
        ctx.db.viewerCapabilityRunMember.id.delete(id);
      }
      return;
    }
    ctx.db.runMember.insert({ id, runId, member: ctx.sender, role: "viewer", createdAt: ctx.timestamp });
    appendReceipt(ctx, {
      runId,
      eventId: `workspace.viewer.joined:${workspaceId}:${identityKey(ctx.sender)}`,
      kind: "workspace.viewer.joined",
      agentId: "viewer",
      payloadJson: JSON.stringify({ workspaceId }),
    });
  }
);

/**
 * Creates the complete Room OS execution graph in one reducer transaction.
 * Any validation failure rolls back the room, cast, bindings, frontier, tasks,
 * worker grant, deadline, events, and idempotency receipt together.
 */
export const initializeRosterExecution = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    runId: t.string(),
    receiptStreamId: t.string(),
    policyJson: t.string(),
    roomJson: t.string(),
    nodesJson: t.string(),
    runtimeBindingsJson: t.string(),
    seedTasksJson: t.string(),
    contextFrontierJson: t.string(),
    idempotencyKey: t.string(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const runId = requireRosterId("runId", args.runId, 160);
    const receiptStreamId = args.receiptStreamId.trim();
    if (receiptStreamId.length > 500) reject("receiptStreamId exceeds 500 characters");
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator"]);
    const policy = parseRosterExecutionPolicy(args.policyJson);
    const roomRecord = asRecord("roomJson", JSON.parse(requireJson("roomJson", args.roomJson, 64_000)));
    const roomId = requireRosterId("roomJson.id", recordString(roomRecord, "id", 160), 160);
    const roomKey = requireRosterId("roomJson.roomKey", recordString(roomRecord, "roomKey", 200), 200);
    const kind = requireRosterId("roomJson.kind", recordString(roomRecord, "kind", 80), 80);
    const title = recordString(roomRecord, "title", 500);
    const idempotencyKey = requireRosterId("idempotencyKey", args.idempotencyKey, 240);
    const nodeValues = asArray(
      "nodesJson",
      JSON.parse(requireJson("nodesJson", args.nodesJson, 2_000_000)),
      Math.min(MAX_ROOM_NODES, policy.maxTasks)
    );
    if (nodeValues.length < 1) reject("nodesJson must contain at least one logical node");
    const bindingValues = asArray(
      "runtimeBindingsJson",
      JSON.parse(requireJson("runtimeBindingsJson", args.runtimeBindingsJson, 2_000_000)),
      nodeValues.length
    );
    const seedValues = asArray(
      "seedTasksJson",
      JSON.parse(requireJson("seedTasksJson", args.seedTasksJson, 2_000_000)),
      policy.maxTasks
    );
    if (seedValues.length < 1) reject("seedTasksJson must contain at least one task");
    const frontierRecord = asRecord(
      "contextFrontierJson",
      JSON.parse(requireJson("contextFrontierJson", args.contextFrontierJson, 256_000))
    );
    const contextVersion = requireRosterVersion(
      "contextFrontierJson.contextVersion",
      recordString(frontierRecord, "contextVersion", 200),
      200
    );
    const frontierVersion = requireRosterVersion(
      "contextFrontierJson.frontierVersion",
      recordString(frontierRecord, "frontierVersion", 200),
      200
    );
    const topologyVersion = requireRosterVersion(
      "contextFrontierJson.topologyVersion",
      recordString(frontierRecord, "topologyVersion", 200),
      200
    );
    const catalogVersion = requireRosterVersion(
      "contextFrontierJson.catalogVersion",
      recordString(frontierRecord, "catalogVersion", 200),
      200
    );
    const bindingVersion = requireRosterId(
      "contextFrontierJson.bindingVersion",
      recordString(frontierRecord, "bindingVersion", 200),
      200
    );
    const repository = parseRosterTaskRepositoryPlacement(
      "contextFrontierJson.repository",
      frontierRecord.repository,
      true
    );
    const authoritativeFrontierRecord = { ...frontierRecord, repository };
    const canonicalArguments = canonicalJson("Roster initialization arguments", {
      workspaceId,
      runId,
      receiptStreamId,
      policy: JSON.parse(policy.json),
      room: JSON.parse(args.roomJson),
      nodes: JSON.parse(args.nodesJson),
      runtimeBindings: JSON.parse(args.runtimeBindingsJson),
      seedTasks: JSON.parse(args.seedTasksJson),
      contextFrontier: authoritativeFrontierRecord,
    }, 6_000_000);
    const argumentsHash = rosterSha256(canonicalArguments);
    const initializationId = compoundKey(workspaceId, idempotencyKey);
    const existingInitialization = ctx.db.rosterExecutionInitialization.id.find(initializationId);
    if (existingInitialization) {
      if (
        existingInitialization.runId !== runId
        || existingInitialization.roomId !== roomId
        || existingInitialization.argumentsHash !== argumentsHash
      ) reject(`idempotencyKey ${idempotencyKey} was retried with different initialization arguments`);
      return;
    }
    if (ctx.db.rosterExecution.runId.find(runId)) reject(`Roster execution ${runId} already exists`);
    const existingRoom = ctx.db.rosterRoom.id.find(roomId);
    const existingActiveExecution = existingRoom?.activeRunId
      ? ctx.db.rosterExecution.runId.find(existingRoom.activeRunId)
      : undefined;
    if (existingRoom && (
      existingRoom.workspaceId !== workspaceId
      || existingRoom.roomKey !== roomKey
      || existingRoom.title !== title
      || (existingRoom.activeRunId
        && existingRoom.activeRunId !== runId
        && (!existingActiveExecution
          || !TERMINAL_ROSTER_EXECUTION_STATUSES.has(existingActiveExecution.status)))
    )) reject(`Roster room ${roomId} changed after creation`);

    const nodes = nodeValues.map((value, index) => {
      const record = asRecord(`nodesJson[${index}]`, value);
      const nodeId = requireRosterId(`nodesJson[${index}].id`, recordString(record, "id", 160), 160);
      const name = recordString(record, "name", 200);
      const capabilities = asArray(
        `nodesJson[${index}].capabilities`,
        record.capabilities,
        64
      ).map((capability) => {
        if (typeof capability !== "string") reject(`nodesJson[${index}].capabilities entries must be strings`);
        return requireRosterId(`nodesJson[${index}].capability`, capability as string, 120);
      });
      if (capabilities.length < 1) reject(`nodesJson[${index}].capabilities must not be empty`);
      return {
        nodeId,
        name,
        parentNodeId: optionalRecordString(record, "parentId", 160),
        capabilitiesJson: canonicalJson("Node capabilities", [...new Set(capabilities)].sort(), 8_000),
        nodeJson: canonicalJson("Workspace node", record, 64_000),
      };
    });
    const nodeIds = new Set(nodes.map((node) => node.nodeId));
    if (nodeIds.size !== nodes.length) reject("nodesJson contains duplicate node ids");
    for (const node of nodes) {
      if (node.parentNodeId && !nodeIds.has(node.parentNodeId)) {
        reject(`Node ${node.nodeId} references missing parent ${node.parentNodeId}`);
      }
    }

    const bindings = bindingValues.map((value, index) => {
      const record = asRecord(`runtimeBindingsJson[${index}]`, value);
      const nodeId = requireRosterId(
        `runtimeBindingsJson[${index}].nodeId`,
        recordString(record, "nodeId", 160),
        160
      );
      if (!nodeIds.has(nodeId)) reject(`Runtime binding references unknown node ${nodeId}`);
      const bindingId = requireRosterId(
        `runtimeBindingsJson[${index}].bindingId`,
        recordString(record, "bindingId", 240),
        240
      );
      const epoch = recordU64(record, "epoch", BigInt(Number.MAX_SAFE_INTEGER));
      if (epoch < 1n) reject(`Runtime binding ${bindingId} epoch must be positive`);
      const bindingTopologyVersion = requireRosterId(
        `runtimeBindingsJson[${index}].topologyVersion`,
        recordString(record, "topologyVersion", 200),
        200
      );
      if (bindingTopologyVersion !== topologyVersion) {
        reject(`Runtime binding ${bindingId} topologyVersion does not match the initial frontier`);
      }
      return {
        nodeId,
        bindingId,
        epoch,
        topologyVersion: bindingTopologyVersion,
        runtimeJson: canonicalJson("Runtime binding", record, 64_000),
      };
    });
    if (bindings.length !== nodes.length || new Set(bindings.map((binding) => binding.nodeId)).size !== nodes.length) {
      reject("runtimeBindingsJson must provide exactly one binding per logical node");
    }
    const seedSpecs = seedValues.map((value, index) =>
      parseRosterTaskDefinitionValue(`seedTasksJson[${index}]`, value, policy)
    );
    for (const spec of seedSpecs) {
      if (spec.parentTaskId) reject("Seed tasks must be root graph tasks");
      if (!nodeIds.has(spec.nodeId)) reject(`Seed task ${spec.taskId} references unknown node ${spec.nodeId}`);
      if (spec.frontierVersion !== frontierVersion || spec.topologyVersion !== topologyVersion || spec.catalogVersion !== catalogVersion) {
        reject(`Seed task ${spec.taskId} input frontier does not match initialization`);
      }
      const binding = bindings.find((candidate) => candidate.nodeId === spec.nodeId)!;
      if (spec.runtimeBindingEpoch !== binding.epoch) {
        reject(`Seed task ${spec.taskId} runtime binding epoch does not match node ${spec.nodeId}`);
      }
    }

    const deadlineMicros = ctx.timestamp.microsSinceUnixEpoch + BigInt(policy.maxWallTimeMs) * 1_000n;
    ctx.db.rosterExecution.insert({
      runId,
      protocolVersion: ROSTER_PLATFORM_PROTOCOL_VERSION,
      kind,
      workspaceId,
      receiptStreamId,
      status: "queued",
      policyJson: policy.json,
      graphVersion: 0n,
      nextEventSeq: 0n,
      totalTasks: 0,
      readyTasks: 0,
      blockedTasks: 0,
      inflightTasks: 0,
      acceptedTasks: 0,
      failedTasks: 0,
      delegatedTasks: 0,
      canceledTasks: 0,
      skippedTasks: 0,
      contextBytes: 0n,
      reservedCostMicros: 0n,
      spentCostMicros: 0n,
      usedTokens: 0n,
      terminalReason: "",
      deadlineAt: new Timestamp(deadlineMicros),
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    ensureRosterRunCoordinatorMembership(ctx, requireRosterExecution(ctx, runId));
    ctx.db.rosterExecutionDeadline.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(deadlineMicros),
      runId,
      deadlineMicros,
    });
    if (!existingRoom) {
      ctx.db.rosterRoom.insert({
        id: roomId,
        workspaceId,
        roomKey,
        kind,
        title,
        status: "active",
        activeRunId: runId,
        certifiedCheckpointId: "",
        nextTimelineSeq: 0n,
        createdAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      });
    } else {
      ctx.db.rosterRoom.id.update({ ...existingRoom, activeRunId: runId, status: "active", updatedAt: ctx.timestamp });
    }
    for (const node of nodes) {
      ctx.db.rosterRoomNode.insert({
        id: compoundKey(runId, node.nodeId),
        workspaceId,
        roomId,
        runId,
        ...node,
        createdAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      });
    }
    for (const binding of bindings) {
      ctx.db.rosterRuntimeBinding.insert({
        id: compoundKey(runId, binding.bindingId),
        workspaceId,
        roomId,
        runId,
        ...binding,
        createdAt: ctx.timestamp,
      });
    }
    ctx.db.rosterContextFrontier.insert({
      id: runId,
      workspaceId,
      roomId,
      runId,
      contextVersion,
      frontierVersion,
      topologyVersion,
      catalogVersion,
      bindingVersion,
      frontierJson: canonicalJson("Initial context frontier", authoritativeFrontierRecord, 256_000),
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    ctx.db.rosterWorkerCapability.insert({
      id: workerCapabilityKey(runId, ctx.sender, "*"),
      runId,
      worker: ctx.sender,
      capability: "*",
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
    });
    const pendingSeeds = [...seedSpecs];
    while (pendingSeeds.length > 0) {
      const availableIndex = pendingSeeds.findIndex((spec) =>
        spec.dependencies.every((dependency) =>
          Boolean(ctx.db.rosterTaskDefinition.id.find(rosterTaskKey(runId, dependency.taskId)))
        )
      );
      if (availableIndex < 0) reject("seedTasksJson contains a dependency cycle or missing dependency");
      const [spec] = pendingSeeds.splice(availableIndex, 1);
      insertRosterTaskDefinition(ctx, requireRosterExecution(ctx, runId), policy, spec, 0);
      const inserted = requireRosterTask(ctx, runId, spec.taskId);
      if (inserted.status === "skipped") propagateRosterTerminalDisposition(ctx, runId, inserted.id);
    }
    refreshRosterExecution(ctx, runId);
    ctx.db.rosterExecutionInitialization.insert({
      id: initializationId,
      workspaceId,
      roomId,
      runId,
      idempotencyKey,
      argumentsHash,
      createdAt: ctx.timestamp,
    });
    appendRosterExecutionEvent(ctx, runId, "roster.execution.initialized", "", {
      protocolVersion: ROSTER_PLATFORM_PROTOCOL_VERSION,
      roomId,
      workspaceId,
      nodeCount: nodes.length,
      seedTaskCount: seedSpecs.length,
      contextVersion,
      frontierVersion,
      topologyVersion,
      catalogVersion,
      bindingVersion,
      idempotencyKey,
    });
    appendRoomTimelineEntry(ctx, runId, "checkpoint", "", "", {
      type: "checkpoint",
      checkpointId: `execution-initialized:${runId}`,
      summary: "Execution initialized atomically",
      contextVersion,
      frontierVersion,
      topologyVersion,
      catalogVersion,
      bindingVersion,
    });
  }
);

/**
 * Create or update the workspace-wide profile for one logical participant.
 * Historical run snapshots remain immutable; new runs may apply this revision.
 */
export const saveRosterParticipantProfile = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    nodeId: t.string(),
    displayName: t.string(),
    role: t.string(),
    bio: t.string(),
    skillsJson: t.string(),
    capabilitiesJson: t.string(),
    expectedRevision: t.u64(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const nodeId = requireRosterId("nodeId", args.nodeId, 160);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator", "viewer"]);
    const displayName = requireText("displayName", args.displayName, 80).replace(/\s+/g, " ");
    const role = requireText("role", args.role, 120).replace(/\s+/g, " ");
    const bio = args.bio.trim().replace(/\s+/g, " ");
    if (bio.length > 1_000) reject("bio exceeds 1000 characters");
    const skills = normalizeParticipantProfileSkills(args.skillsJson);
    const capabilities = normalizeCapabilities(args.capabilitiesJson);
    if (skills.length > 32) reject("participant profile exceeds 32 skills");
    if (capabilities.length > 32) reject("participant profile exceeds 32 capabilities");
    const id = compoundKey(workspaceId, nodeId);
    const existing = ctx.db.rosterParticipantProfile.id.find(id);
    const currentRevision = existing?.revision ?? 0n;
    if (currentRevision !== args.expectedRevision) {
      reject(`participant profile ${nodeId} changed; refresh before saving`);
    }
    const row = {
      id,
      workspaceId,
      nodeId,
      displayName,
      role,
      bio,
      skillsJson: JSON.stringify(skills),
      capabilitiesJson: JSON.stringify(capabilities),
      revision: currentRevision + 1n,
      updatedBy: ctx.sender,
      createdAt: existing?.createdAt ?? ctx.timestamp,
      updatedAt: ctx.timestamp,
    };
    if (existing) ctx.db.rosterParticipantProfile.id.update(row);
    else ctx.db.rosterParticipantProfile.insert(row);
  }
);

const requestRosterNodeWakeInternal = (
  ctx: RosterContext,
  input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly requestId: string;
    readonly notBeforeMs: bigint;
  }
) => {
  const node = requireRosterWorkspaceNode(ctx, input.workspaceId, input.nodeId);
  let continuity = requireRosterNodeContinuity(ctx, input.workspaceId, input.nodeId);
  const policy = parseRosterNodeContinuityPolicy(node.continuityPolicyJson);
  if (policy.mode !== "workspace") reject(`workspace node ${input.nodeId} has run-scoped continuity`);
  if (continuity.status === "suspended") reject(`workspace node ${input.nodeId} is suspended`);
  if (continuity.activeWakeId) {
    const active = expectValue(ctx.db.rosterNodeWake.id.find(continuity.activeWakeId), "active node wake is missing");
    if (active.requestId !== input.requestId) reject(`workspace node ${input.nodeId} already has an active wake`);
    return active;
  }
  const pendingAcrossLanes = [...ctx.db.rosterNodeInboxItem.nodeId.filter(input.nodeId)]
    .filter((item) => item.workspaceId === input.workspaceId && item.status === "pending")
    .sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : left.id.localeCompare(right.id));
  if (!pendingAcrossLanes.length) reject(`workspace node ${input.nodeId} has no pending inbox items`);
  const head = pendingAcrossLanes[0]!;
  const pending = pendingAcrossLanes
    .filter((item) => item.laneId === head.laneId)
    .slice(0, policy.maxInboxItemsPerWake);
  const nowMs = ctx.timestamp.microsSinceUnixEpoch / 1_000n;
  const windowExpired = nowMs - continuity.wakeWindowStartedAtMs >= BigInt(policy.wakeWindowMs);
  const wakesInWindow = windowExpired ? 0 : continuity.wakesInWindow;
  const earliestMs = continuity.lastWakeAtMs > 0n
    ? continuity.lastWakeAtMs + BigInt(policy.minWakeIntervalMs)
    : nowMs;
  const budgetResetAtMs = !windowExpired && wakesInWindow >= policy.maxWakesPerWindow
    ? continuity.wakeWindowStartedAtMs + BigInt(policy.wakeWindowMs)
    : nowMs;
  const notBeforeMs = [input.notBeforeMs, earliestMs, budgetResetAtMs]
    .reduce((latest, value) => value > latest ? value : latest, nowMs);
  const wakeId = `node_wake_${rosterHashCanonical({
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
    requestId: input.requestId,
    continuityRevision: continuity.revision.toString(),
    laneId: head.laneId,
    inboxDeliveryIds: pending.map((item) => item.deliveryId),
    requestedAt: Number(nowMs),
    notBefore: Number(notBeforeMs),
  }).slice(0, 28)}`;
  const jobId = `node_wake_job_${wakeId}`;
  if (ctx.db.rosterNodeWake.id.find(wakeId)) reject(`node wake request ${input.requestId} changed after publication`);
  const inboxDeliveryIds = pending.map((item) => item.deliveryId);
  const commitments = [...ctx.db.rosterNodeCommitment.nodeId.filter(input.nodeId)]
    .filter((commitment) => commitment.workspaceId === input.workspaceId)
    .sort((left, right) => left.commitmentId.localeCompare(right.commitmentId))
    .map(({ commitmentId, objective, status, revision, sourceId, updatedAtMs }) => ({
      commitmentId,
      objective,
      status,
      revision: Number(revision),
      sourceId,
      updatedAt: Number(updatedAtMs),
    }));
  const wake = {
    wakeId,
    requestId: input.requestId,
    laneId: head.laneId,
    ...(head.roomId ? { roomId: head.roomId } : {}),
    ...(head.runId ? { runId: head.runId } : {}),
    inboxDeliveryIds,
    requestedAt: Number(nowMs),
    notBefore: Number(notBeforeMs),
  };
  const manifest = {
    schemaVersion: "roster.node-continuity-manifest.v1",
    manifestId: `${wakeId}:manifest:${continuity.revision + 1n}`,
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
    nodeRevision: Number(node.nodeRevision),
    continuityRevision: Number(continuity.revision + 1n),
    wake,
    inbox: pending.map((item) => JSON.parse(item.itemJson)),
    commitments,
    ...(continuity.memoryScopeId && continuity.memorySnapshotVersion ? {
      memoryFrontier: {
        scopeId: continuity.memoryScopeId,
        snapshotVersion: continuity.memorySnapshotVersion,
        updatedAt: Number(continuity.updatedAt.microsSinceUnixEpoch / 1_000n),
      },
    } : {}),
    policy: { policyId: policy.policyId, policyVersion: policy.policyVersion },
  };
  const manifestJson = canonicalJson("node continuity manifest", manifest, 512_000);
  const row = ctx.db.rosterNodeWake.insert({
    id: wakeId,
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
    requestId: input.requestId,
    laneId: head.laneId,
    roomId: head.roomId,
    runId: head.runId,
    status: "scheduled",
    inboxDeliveryIdsJson: JSON.stringify(inboxDeliveryIds),
    manifestJson,
    jobId,
    requestedAtMs: nowMs,
    notBeforeMs,
    admittedAtMs: 0n,
    completedAtMs: 0n,
    resultJson: "",
    lastError: "",
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  for (const item of pending) {
    ctx.db.rosterNodeInboxItem.id.update({ ...item, status: "assigned", wakeId });
  }
  continuity = {
    ...continuity,
    status: "queued",
    activeWakeId: wakeId,
    pendingInboxCount: pendingAcrossLanes.length,
    wakeWindowStartedAtMs: windowExpired ? nowMs : continuity.wakeWindowStartedAtMs,
    updatedAt: ctx.timestamp,
  };
  ctx.db.rosterNodeContinuity.id.update(continuity);
  continuity = appendRosterNodeContinuityEvent(ctx, continuity, "node.wake.requested", {
    type: "node.wake.requested",
    wake,
    occurredAt: Number(nowMs),
  });
  ctx.db.rosterNodeWakeSchedule.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(notBeforeMs * 1_000n),
    wakeId,
  });
  return row;
};

/** Admit the next FIFO room lane while leaving failed deliveries for explicit retry. */
const continueRosterNodeWakeInternal = (
  ctx: RosterContext,
  workspaceId: string,
  nodeId: string,
  requestedAtMs: bigint,
): void => {
  const continuity = requireRosterNodeContinuity(ctx, workspaceId, nodeId);
  if (continuity.activeWakeId || continuity.status === "suspended") return;
  const next = [...ctx.db.rosterNodeInboxItem.nodeId.filter(nodeId)]
    .filter((item) => item.workspaceId === workspaceId && item.status === "pending")
    .sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : left.id.localeCompare(right.id))[0];
  if (!next) return;
  const requestId = `continuation_${rosterHashCanonical({
    workspaceId,
    nodeId,
    deliveryId: next.deliveryId,
    laneId: next.laneId,
  }).slice(0, 28)}`;
  requestRosterNodeWakeInternal(ctx, {
    workspaceId,
    nodeId,
    requestId,
    notBeforeMs: requestedAtMs,
  });
};

/** Register or revise a workspace-scoped canonical node and its continuity policy. */
export const registerRosterWorkspaceNode = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    nodeId: t.string(),
    nodeRevision: t.u64(),
    nodeJson: t.string(),
    continuityPolicyJson: t.string(),
    expectedRevision: t.u64(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const nodeId = requireRosterId("nodeId", args.nodeId, 160);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator"]);
    if (args.nodeRevision < 1n) reject("nodeRevision must be positive");
    const node = parseJsonRecord("nodeJson", args.nodeJson, 128_000);
    if (recordString(node, "id", 160) !== nodeId) reject("nodeJson id does not match nodeId");
    const runtime = asRecord("nodeJson.runtime", node.runtime);
    requireRosterId("nodeJson.runtime.kind", recordString(runtime, "kind", 120), 120);
    const policy = parseRosterNodeContinuityPolicy(args.continuityPolicyJson);
    const id = rosterWorkspaceNodeKey(workspaceId, nodeId);
    const existing = ctx.db.rosterWorkspaceNode.id.find(id);
    const currentRevision = existing?.nodeRevision ?? 0n;
    if (currentRevision !== args.expectedRevision) reject(`workspace node ${nodeId} changed; refresh before saving`);
    if (args.nodeRevision !== currentRevision + 1n) reject("nodeRevision must increase by one");
    const nodeJson = canonicalJson("workspace node", node, 128_000);
    const row = {
      id,
      workspaceId,
      nodeId,
      nodeRevision: args.nodeRevision,
      nodeJson,
      continuityPolicyJson: policy.json,
      status: "active",
      createdAt: existing?.createdAt ?? ctx.timestamp,
      updatedAt: ctx.timestamp,
    };
    if (existing) ctx.db.rosterWorkspaceNode.id.update(row);
    else ctx.db.rosterWorkspaceNode.insert(row);
    if (policy.mode !== "workspace") return;
    let continuity = ctx.db.rosterNodeContinuity.id.find(id);
    if (!continuity) {
      continuity = ctx.db.rosterNodeContinuity.insert({
        id,
        workspaceId,
        nodeId,
        status: "dormant",
        revision: 0n,
        nextInboxSeq: 0n,
        nextEventSeq: 0n,
        pendingInboxCount: 0,
        activeWakeId: "",
        lastWakeId: "",
        lastWakeAtMs: 0n,
        wakeWindowStartedAtMs: ctx.timestamp.microsSinceUnixEpoch / 1_000n,
        wakesInWindow: 0,
        memoryScopeId: policy.memory === "private" ? `node:${workspaceId}:${nodeId}` : "",
        memorySnapshotVersion: "",
        createdAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      });
    }
    appendRosterNodeContinuityEvent(ctx, continuity, "node.continuity.registered", {
      type: "node.continuity.registered",
      workspaceId,
      nodeId,
      nodeRevision: Number(args.nodeRevision),
      policy: JSON.parse(policy.json),
      occurredAt: Number(ctx.timestamp.microsSinceUnixEpoch / 1_000n),
    });
  }
);

/** Deliver an immutable source pointer and optionally request one bounded wake atomically. */
export const deliverRosterNodeInbox = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    nodeId: t.string(),
    deliveryId: t.string(),
    cause: t.string(),
    laneId: t.string(),
    roomId: t.string(),
    runId: t.string(),
    sourceId: t.string(),
    sourceVersion: t.string(),
    sourceHash: t.string(),
    payloadReference: t.string(),
    causalParentId: t.string(),
    causalDepth: t.u32(),
    deliveredAtMs: t.u64(),
    requestWake: t.bool(),
    wakeRequestId: t.string(),
    notBeforeMs: t.u64(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const nodeId = requireRosterId("nodeId", args.nodeId, 160);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator", "worker"]);
    const node = requireRosterWorkspaceNode(ctx, workspaceId, nodeId);
    const policy = parseRosterNodeContinuityPolicy(node.continuityPolicyJson);
    if (policy.mode !== "workspace") reject(`workspace node ${nodeId} has run-scoped continuity`);
    const deliveryId = requireRosterId("deliveryId", args.deliveryId, 200);
    const cause = requireText("cause", args.cause, 24);
    if (!NODE_INBOX_CAUSES.has(cause)) reject("invalid node inbox cause");
    const laneId = requireRosterId("laneId", args.laneId, 240);
    const roomId = args.roomId ? requireRosterId("roomId", args.roomId, 240) : "";
    const runId = args.runId ? requireRosterId("runId", args.runId, 240) : "";
    const sourceId = requireRosterId("sourceId", args.sourceId, 240);
    const sourceVersion = requireText("sourceVersion", args.sourceVersion, 240);
    const sourceHash = requireText("sourceHash", args.sourceHash, 256);
    if (args.causalDepth > policy.maxCausalDepth) reject("node inbox delivery exceeds maxCausalDepth");
    if (args.payloadReference.length > 2_000 || args.causalParentId.length > 240) reject("node inbox pointer is too long");
    let continuity = requireRosterNodeContinuity(ctx, workspaceId, nodeId);
    const itemId = rosterNodeInboxKey(continuity.id, deliveryId);
    const existing = ctx.db.rosterNodeInboxItem.id.find(itemId);
    const item = {
      deliveryId,
      sequence: Number(existing?.seq ?? continuity.nextInboxSeq + 1n),
      cause,
      scope: {
        laneId,
        ...(roomId ? { roomId } : {}),
        ...(runId ? { runId } : {}),
      },
      sourceId,
      sourceVersion,
      sourceHash,
      ...(args.payloadReference ? { payloadReference: args.payloadReference } : {}),
      ...(args.causalParentId ? { causalParentId: args.causalParentId } : {}),
      causalDepth: args.causalDepth,
      deliveredAt: Number(args.deliveredAtMs),
    };
    const itemJson = canonicalJson("node inbox item", item, MAX_NODE_INBOX_ITEM_CHARS);
    if (existing) {
      if (existing.itemJson !== itemJson) reject(`node inbox delivery ${deliveryId} changed during replay`);
    } else {
      if (continuity.pendingInboxCount >= policy.maxPendingInboxItems) reject(`workspace node ${nodeId} inbox is full`);
      const seq = continuity.nextInboxSeq + 1n;
      ctx.db.rosterNodeInboxItem.insert({
        id: itemId,
        workspaceId,
        nodeId,
        deliveryId,
        seq,
        cause,
        laneId,
        roomId,
        runId,
        sourceId,
        sourceVersion,
        sourceHash,
        payloadReference: args.payloadReference,
        causalParentId: args.causalParentId,
        causalDepth: args.causalDepth,
        status: "pending",
        wakeId: "",
        itemJson,
        deliveredAtMs: args.deliveredAtMs,
        consumedAt: undefined,
        createdAt: ctx.timestamp,
      });
      continuity = {
        ...continuity,
        nextInboxSeq: seq,
        pendingInboxCount: continuity.pendingInboxCount + 1,
        status: continuity.status === "dormant" ? "waiting" : continuity.status,
        updatedAt: ctx.timestamp,
      };
      ctx.db.rosterNodeContinuity.id.update(continuity);
      continuity = appendRosterNodeContinuityEvent(ctx, continuity, "node.inbox.delivered", {
        type: "node.inbox.delivered",
        item,
        occurredAt: Number(args.deliveredAtMs),
      });
    }
    if (args.requestWake && !continuity.activeWakeId && continuity.status !== "suspended") {
      const wakeRequestId = requireRosterId("wakeRequestId", args.wakeRequestId, 200);
      requestRosterNodeWakeInternal(ctx, { workspaceId, nodeId, requestId: wakeRequestId, notBeforeMs: args.notBeforeMs });
    }
  }
);

export const requestRosterNodeWake = spacetimedb.reducer(
  { workspaceId: t.string(), nodeId: t.string(), requestId: t.string(), notBeforeMs: t.u64() },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const nodeId = requireRosterId("nodeId", args.nodeId, 160);
    const requestId = requireRosterId("requestId", args.requestId, 200);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator", "worker"]);
    requestRosterNodeWakeInternal(ctx, { workspaceId, nodeId, requestId, notBeforeMs: args.notBeforeMs });
  }
);

export const dispatchRosterNodeWake = spacetimedb.reducer(
  { timer: rosterNodeWakeSchedule.rowType },
  (ctx, { timer }) => {
    const wake = ctx.db.rosterNodeWake.id.find(timer.wakeId);
    if (!wake || wake.status !== "scheduled") return;
    const continuity = requireRosterNodeContinuity(ctx, wake.workspaceId, wake.nodeId);
    if (continuity.status === "suspended" || continuity.activeWakeId !== wake.id) return;
    enqueueRosterNodeWakeJob(ctx, wake);
    ctx.db.rosterNodeWake.id.update({ ...wake, status: "queued", updatedAt: ctx.timestamp });
  }
);

/** Bind a claimed generic job lease to the node's one active episodic wake. */
export const admitRosterNodeWake = spacetimedb.reducer(
  { workspaceId: t.string(), wakeId: t.string(), workerId: t.string(), fence: t.u64() },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator", "worker"]);
    const wake = expectValue(ctx.db.rosterNodeWake.id.find(args.wakeId), `node wake ${args.wakeId} does not exist`);
    if (wake.workspaceId !== args.workspaceId) reject("node wake belongs to another workspace");
    if (wake.status === "working" && wake.admittedAtMs > 0n) return;
    if (wake.status !== "queued") reject(`node wake ${wake.id} is ${wake.status}`);
    requireActiveRosterJobLease(ctx, args.workspaceId, wake.jobId, requireText("workerId", args.workerId, 160), args.fence);
    let continuity = requireRosterNodeContinuity(ctx, wake.workspaceId, wake.nodeId);
    if (continuity.activeWakeId !== wake.id) reject("node wake is no longer active");
    const node = requireRosterWorkspaceNode(ctx, wake.workspaceId, wake.nodeId);
    const policy = parseRosterNodeContinuityPolicy(node.continuityPolicyJson);
    const nowMs = ctx.timestamp.microsSinceUnixEpoch / 1_000n;
    const windowExpired = nowMs - continuity.wakeWindowStartedAtMs >= BigInt(policy.wakeWindowMs);
    const wakesInWindow = windowExpired ? 0 : continuity.wakesInWindow;
    if (wakesInWindow >= policy.maxWakesPerWindow) reject("node wake budget is exhausted");
    if (continuity.lastWakeAtMs > 0n && nowMs - continuity.lastWakeAtMs < BigInt(policy.minWakeIntervalMs)) {
      reject("node wake violates minWakeIntervalMs");
    }
    ctx.db.rosterNodeWake.id.update({ ...wake, status: "working", admittedAtMs: nowMs, updatedAt: ctx.timestamp });
    continuity = {
      ...continuity,
      status: "working",
      lastWakeAtMs: nowMs,
      wakeWindowStartedAtMs: windowExpired ? nowMs : continuity.wakeWindowStartedAtMs,
      wakesInWindow: wakesInWindow + 1,
      updatedAt: ctx.timestamp,
    };
    ctx.db.rosterNodeContinuity.id.update(continuity);
    appendRosterNodeContinuityEvent(ctx, continuity, "node.wake.admitted", {
      type: "node.wake.admitted",
      wakeId: wake.id,
      occurredAt: Number(nowMs),
    });
  }
);

export const completeRosterNodeWake = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    wakeId: t.string(),
    consumedDeliveryIdsJson: t.string(),
    resultJson: t.string(),
  },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator", "worker"]);
    const wake = expectValue(ctx.db.rosterNodeWake.id.find(args.wakeId), `node wake ${args.wakeId} does not exist`);
    if (wake.workspaceId !== args.workspaceId) reject("node wake belongs to another workspace");
    const resultJson = args.resultJson.trim()
      ? requireJson("resultJson", args.resultJson, MAX_NODE_WAKE_RESULT_CHARS)
      : "{}";
    asRecord("node wake result", JSON.parse(resultJson));
    if (wake.status === "completed") {
      if (wake.resultJson !== resultJson) reject("completed node wake result changed during replay");
      return;
    }
    if (wake.status !== "working") reject(`node wake ${wake.id} is ${wake.status}`);
    const job = requireRosterJob(ctx, args.workspaceId, wake.jobId);
    if (job.status !== "completed") reject("node wake job must complete before continuity acceptance");
    const consumedValue: unknown = JSON.parse(requireJson(
      "consumedDeliveryIdsJson",
      args.consumedDeliveryIdsJson,
      64_000
    ));
    if (!Array.isArray(consumedValue)) reject("consumedDeliveryIdsJson must be an array");
    const consumed = (consumedValue as unknown[])
      .map((value: unknown) => requireRosterId("consumed delivery id", String(value), 200));
    const boundValue: unknown = JSON.parse(requireJson(
      "wake inbox deliveries",
      wake.inboxDeliveryIdsJson,
      64_000
    ));
    if (!Array.isArray(boundValue)) reject("wake inbox deliveries must be an array");
    const bound = new Set<string>((boundValue as unknown[]).map((value: unknown) => String(value)));
    if (consumed.some((deliveryId: string) => !bound.has(deliveryId))) reject("node wake consumed an unbound inbox delivery");
    const consumedSet = new Set(consumed);
    for (const item of ctx.db.rosterNodeInboxItem.nodeId.filter(wake.nodeId)) {
      if (item.workspaceId !== wake.workspaceId || !bound.has(item.deliveryId)) continue;
      ctx.db.rosterNodeInboxItem.id.update(consumedSet.has(item.deliveryId)
        ? { ...item, status: "consumed", consumedAt: ctx.timestamp }
        : { ...item, status: "pending", wakeId: "" });
    }
    const pending = [...ctx.db.rosterNodeInboxItem.nodeId.filter(wake.nodeId)]
      .filter((item) => item.workspaceId === wake.workspaceId && item.status !== "consumed").length;
    const nowMs = ctx.timestamp.microsSinceUnixEpoch / 1_000n;
    ctx.db.rosterNodeWake.id.update({
      ...wake,
      status: "completed",
      completedAtMs: nowMs,
      resultJson,
      updatedAt: ctx.timestamp,
    });
    let continuity = requireRosterNodeContinuity(ctx, wake.workspaceId, wake.nodeId);
    continuity = {
      ...continuity,
      status: pending ? "waiting" : "dormant",
      activeWakeId: "",
      lastWakeId: wake.id,
      pendingInboxCount: pending,
      updatedAt: ctx.timestamp,
    };
    ctx.db.rosterNodeContinuity.id.update(continuity);
    continuity = appendRosterNodeContinuityEvent(ctx, continuity, "node.wake.completed", {
      type: "node.wake.completed",
      wakeId: wake.id,
      consumedDeliveryIds: consumed,
      occurredAt: Number(nowMs),
    });
    continueRosterNodeWakeInternal(ctx, wake.workspaceId, wake.nodeId, nowMs);
  }
);

export const failRosterNodeWake = spacetimedb.reducer(
  { workspaceId: t.string(), wakeId: t.string(), error: t.string() },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator", "worker"]);
    const wake = expectValue(ctx.db.rosterNodeWake.id.find(args.wakeId), `node wake ${args.wakeId} does not exist`);
    if (wake.workspaceId !== args.workspaceId) reject("node wake belongs to another workspace");
    const error = requireText("error", args.error, 8_000);
    if (wake.status === "failed") {
      if (wake.lastError !== error) reject("failed node wake error changed during replay");
      return;
    }
    if (!NODE_WAKE_STATUSES.has(wake.status) || wake.status === "completed" || wake.status === "canceled") {
      reject(`node wake ${wake.id} cannot fail from ${wake.status}`);
    }
    const job = ctx.db.rosterJob.id.find(wake.jobId);
    if (job && job.status !== "failed" && job.status !== "canceled") {
      reject("node wake job must be terminal before continuity failure");
    }
    for (const item of ctx.db.rosterNodeInboxItem.nodeId.filter(wake.nodeId)) {
      if (item.workspaceId !== wake.workspaceId || item.wakeId !== wake.id || item.status === "consumed") continue;
      ctx.db.rosterNodeInboxItem.id.update({ ...item, status: "failed" });
    }
    const nowMs = ctx.timestamp.microsSinceUnixEpoch / 1_000n;
    ctx.db.rosterNodeWake.id.update({
      ...wake, status: "failed", completedAtMs: nowMs, lastError: error, updatedAt: ctx.timestamp,
    });
    let continuity = requireRosterNodeContinuity(ctx, wake.workspaceId, wake.nodeId);
    continuity = {
      ...continuity,
      status: continuity.pendingInboxCount ? "waiting" : "dormant",
      activeWakeId: "",
      lastWakeId: wake.id,
      updatedAt: ctx.timestamp,
    };
    ctx.db.rosterNodeContinuity.id.update(continuity);
    continuity = appendRosterNodeContinuityEvent(ctx, continuity, "node.wake.failed", {
      type: "node.wake.failed", wakeId: wake.id, error, occurredAt: Number(nowMs),
    });
    continueRosterNodeWakeInternal(ctx, wake.workspaceId, wake.nodeId, nowMs);
  }
);

export const resolveFailedRosterNodeWake = spacetimedb.reducer(
  { workspaceId: t.string(), wakeId: t.string(), resolution: t.string() },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator"]);
    if (args.resolution !== "superseded") reject("unsupported failed node wake resolution");
    const wake = expectValue(ctx.db.rosterNodeWake.id.find(args.wakeId), `node wake ${args.wakeId} does not exist`);
    if (wake.workspaceId !== args.workspaceId) reject("node wake belongs to another workspace");
    if (wake.status !== "failed") reject(`node wake ${wake.id} is not failed`);
    const job = ctx.db.rosterJob.id.find(wake.jobId);
    if (!job || (job.status !== "failed" && job.status !== "canceled")) {
      reject("failed node wake resolution requires its terminal failed job");
    }
    let continuity = requireRosterNodeContinuity(ctx, wake.workspaceId, wake.nodeId);
    const boundValue: unknown = JSON.parse(requireJson(
      "wake inbox deliveries",
      wake.inboxDeliveryIdsJson,
      64_000
    ));
    if (!Array.isArray(boundValue) || boundValue.length === 0) {
      reject("failed node wake has no bound inbox deliveries");
    }
    const bound = new Set<string>((boundValue as unknown[])
      .map((value: unknown) => requireRosterId("resolved delivery id", String(value), 200)));
    const rows = [...ctx.db.rosterNodeInboxItem.nodeId.filter(wake.nodeId)]
      .filter((item) => item.workspaceId === wake.workspaceId && bound.has(item.deliveryId));
    if (rows.length !== bound.size) reject("failed node wake inbox delivery is missing");
    if (rows.every((item) => item.status === "consumed")) return;
    if (continuity.activeWakeId) reject("cannot resolve a failed wake while another wake is active");
    if (continuity.lastWakeId !== wake.id) reject("failed node wake resolution is stale");
    if (rows.some((item) => item.status !== "failed" || item.wakeId !== wake.id)) {
      reject("failed node wake inbox delivery is no longer isolated to that wake");
    }
    for (const item of rows) {
      ctx.db.rosterNodeInboxItem.id.update({ ...item, status: "consumed", consumedAt: ctx.timestamp });
    }
    const pending = [...ctx.db.rosterNodeInboxItem.nodeId.filter(wake.nodeId)]
      .filter((item) => item.workspaceId === wake.workspaceId && item.status !== "consumed").length;
    continuity = {
      ...continuity,
      status: pending ? "waiting" : "dormant",
      pendingInboxCount: pending,
      updatedAt: ctx.timestamp,
    };
    ctx.db.rosterNodeContinuity.id.update(continuity);
    const nowMs = ctx.timestamp.microsSinceUnixEpoch / 1_000n;
    appendRosterNodeContinuityEvent(ctx, continuity, "node.wake.resolved", {
      type: "node.wake.resolved",
      wakeId: wake.id,
      consumedDeliveryIds: [...bound],
      resolution: args.resolution,
      occurredAt: Number(nowMs),
    });
  }
);

export const suspendRosterNodeContinuity = spacetimedb.reducer(
  { workspaceId: t.string(), nodeId: t.string() },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator"]);
    let continuity = requireRosterNodeContinuity(ctx, args.workspaceId, args.nodeId);
    if (continuity.status === "suspended") return;
    if (continuity.status === "working") reject("cannot suspend a working node");
    const wake = continuity.activeWakeId ? ctx.db.rosterNodeWake.id.find(continuity.activeWakeId) : undefined;
    if (wake && (wake.status === "scheduled" || wake.status === "queued")) {
      ctx.db.rosterNodeWake.id.update({ ...wake, status: "canceled", updatedAt: ctx.timestamp });
      for (const item of ctx.db.rosterNodeInboxItem.nodeId.filter(args.nodeId)) {
        if (item.workspaceId !== args.workspaceId || item.wakeId !== wake.id || item.status === "consumed") continue;
        ctx.db.rosterNodeInboxItem.id.update({ ...item, status: "pending", wakeId: "" });
      }
      const job = ctx.db.rosterJob.id.find(wake.jobId);
      if (job && job.status === "queued") {
        ctx.db.rosterJob.id.update({ ...job, status: "canceled", canceledReason: "node suspended", updatedAt: ctx.timestamp });
        appendRosterJobEvent(ctx, args.workspaceId, job.id, "job.canceled", {
          type: "job.canceled", jobId: job.id, reason: "node suspended", by: identityKey(ctx.sender),
        });
        releaseWorkspaceJob(ctx, args.workspaceId);
      }
    }
    continuity = { ...continuity, status: "suspended", activeWakeId: "", updatedAt: ctx.timestamp };
    ctx.db.rosterNodeContinuity.id.update(continuity);
    appendRosterNodeContinuityEvent(ctx, continuity, "node.continuity.suspended", {
      type: "node.continuity.suspended",
      occurredAt: Number(ctx.timestamp.microsSinceUnixEpoch / 1_000n),
    });
  }
);

export const resumeRosterNodeContinuity = spacetimedb.reducer(
  { workspaceId: t.string(), nodeId: t.string() },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator"]);
    let continuity = requireRosterNodeContinuity(ctx, args.workspaceId, args.nodeId);
    if (continuity.status !== "suspended") return;
    continuity = {
      ...continuity,
      status: continuity.pendingInboxCount ? "waiting" : "dormant",
      updatedAt: ctx.timestamp,
    };
    ctx.db.rosterNodeContinuity.id.update(continuity);
    appendRosterNodeContinuityEvent(ctx, continuity, "node.continuity.resumed", {
      type: "node.continuity.resumed",
      occurredAt: Number(ctx.timestamp.microsSinceUnixEpoch / 1_000n),
    });
  }
);

export const changeRosterNodeCommitment = spacetimedb.reducer(
  {
    workspaceId: t.string(), nodeId: t.string(), commitmentId: t.string(), objective: t.string(),
    status: t.string(), revision: t.u64(), sourceId: t.string(), updatedAtMs: t.u64(),
  },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator", "worker"]);
    const node = requireRosterWorkspaceNode(ctx, args.workspaceId, args.nodeId);
    const policy = parseRosterNodeContinuityPolicy(node.continuityPolicyJson);
    let continuity = requireRosterNodeContinuity(ctx, args.workspaceId, args.nodeId);
    const commitmentId = requireRosterId("commitmentId", args.commitmentId, 200);
    const objective = requireText("objective", args.objective, 4_000);
    const status = requireText("status", args.status, 24);
    if (!NODE_COMMITMENT_STATUSES.has(status)) reject("invalid node commitment status");
    const sourceId = requireRosterId("sourceId", args.sourceId, 240);
    const id = rosterNodeCommitmentKey(continuity.id, commitmentId);
    const existing = ctx.db.rosterNodeCommitment.id.find(id);
    if (existing && args.revision < existing.revision) reject("node commitment revision is stale");
    if (existing && args.revision === existing.revision) {
      if (existing.objective !== objective || existing.status !== status || existing.sourceId !== sourceId) {
        reject("node commitment changed without a revision");
      }
      return;
    }
    if (args.revision !== (existing?.revision ?? 0n) + 1n) reject("node commitment revision must increase by one");
    const active = [...ctx.db.rosterNodeCommitment.nodeId.filter(args.nodeId)]
      .filter((entry) => entry.workspaceId === args.workspaceId
        && entry.id !== id
        && (entry.status === "active" || entry.status === "waiting")).length
      + (status === "active" || status === "waiting" ? 1 : 0);
    if (active > policy.maxActiveCommitments) reject("node has too many active commitments");
    const row = {
      id, workspaceId: args.workspaceId, nodeId: args.nodeId, commitmentId, objective, status,
      revision: args.revision, sourceId, updatedAtMs: args.updatedAtMs,
      createdAt: existing?.createdAt ?? ctx.timestamp, updatedAt: ctx.timestamp,
    };
    if (existing) ctx.db.rosterNodeCommitment.id.update(row);
    else ctx.db.rosterNodeCommitment.insert(row);
    continuity = appendRosterNodeContinuityEvent(ctx, continuity, "node.commitment.changed", {
      type: "node.commitment.changed",
      commitment: {
        commitmentId, objective, status, revision: Number(args.revision), sourceId, updatedAt: Number(args.updatedAtMs),
      },
      occurredAt: Number(args.updatedAtMs),
    });
  }
);

export const updateRosterNodeMemoryFrontier = spacetimedb.reducer(
  { workspaceId: t.string(), nodeId: t.string(), scopeId: t.string(), snapshotVersion: t.string() },
  (ctx, args) => {
    requireWorkspaceMembership(ctx, args.workspaceId, ["owner", "coordinator", "worker"]);
    const node = requireRosterWorkspaceNode(ctx, args.workspaceId, args.nodeId);
    const policy = parseRosterNodeContinuityPolicy(node.continuityPolicyJson);
    if (policy.memory !== "private") reject("node does not have private continuity memory");
    const expectedScopeId = `node:${args.workspaceId}:${args.nodeId}`;
    if (args.scopeId !== expectedScopeId) reject("node memory frontier belongs to another scope");
    const snapshotVersion = requireText("snapshotVersion", args.snapshotVersion, 240);
    let continuity = requireRosterNodeContinuity(ctx, args.workspaceId, args.nodeId);
    continuity = {
      ...continuity,
      memoryScopeId: expectedScopeId,
      memorySnapshotVersion: snapshotVersion,
      updatedAt: ctx.timestamp,
    };
    ctx.db.rosterNodeContinuity.id.update(continuity);
    appendRosterNodeContinuityEvent(ctx, continuity, "node.memory.frontier.updated", {
      type: "node.memory.frontier.updated",
      frontier: {
        scopeId: expectedScopeId,
        snapshotVersion,
        updatedAt: Number(ctx.timestamp.microsSinceUnixEpoch / 1_000n),
      },
      occurredAt: Number(ctx.timestamp.microsSinceUnixEpoch / 1_000n),
    });
  }
);

/** Idempotently create one provider-neutral, policy-bounded Roster execution. */
export const ensureRosterExecution = spacetimedb.reducer(
  {
    runId: t.string(),
    kind: t.string(),
    workspaceId: t.string(),
    receiptStreamId: t.string(),
    policyJson: t.string(),
  },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const kind = requireText("kind", args.kind, 80);
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const receiptStreamId = args.receiptStreamId.trim();
    if (receiptStreamId.length > 500) reject("receiptStreamId exceeds 500 characters");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(runId)) reject("runId contains unsafe characters");
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator"]);
    const policy = parseRosterExecutionPolicy(args.policyJson);
    const existing = ctx.db.rosterExecution.runId.find(runId);
    if (existing) {
      if (
        existing.protocolVersion !== ROSTER_PLATFORM_PROTOCOL_VERSION
        || existing.kind !== kind
        || existing.workspaceId !== workspaceId
        || existing.receiptStreamId !== receiptStreamId
        || existing.policyJson !== policy.json
      ) reject(`Roster execution ${runId} changed after creation`);
      return;
    }
    const deadlineMicros = ctx.timestamp.microsSinceUnixEpoch
      + BigInt(policy.maxWallTimeMs) * 1_000n;
    ctx.db.rosterExecution.insert({
      runId,
      protocolVersion: ROSTER_PLATFORM_PROTOCOL_VERSION,
      kind,
      workspaceId,
      receiptStreamId,
      status: "queued",
      policyJson: policy.json,
      graphVersion: 0n,
      nextEventSeq: 0n,
      totalTasks: 0,
      readyTasks: 0,
      blockedTasks: 0,
      inflightTasks: 0,
      acceptedTasks: 0,
      failedTasks: 0,
      delegatedTasks: 0,
      canceledTasks: 0,
      skippedTasks: 0,
      contextBytes: 0n,
      reservedCostMicros: 0n,
      spentCostMicros: 0n,
      usedTokens: 0n,
      terminalReason: "",
      deadlineAt: new Timestamp(deadlineMicros),
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    ctx.db.rosterExecutionDeadline.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(deadlineMicros),
      runId,
      deadlineMicros,
    });
    ctx.db.rosterWorkerCapability.insert({
      id: workerCapabilityKey(runId, ctx.sender, "*"),
      runId,
      worker: ctx.sender,
      capability: "*",
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
    });
    appendRosterExecutionEvent(ctx, runId, "roster.execution.created", "", {
      protocolVersion: ROSTER_PLATFORM_PROTOCOL_VERSION,
      kind,
      workspaceId,
      receiptStreamId,
      policy: JSON.parse(policy.json),
    });
  }
);

export const queueRosterRoomControlIntent = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    roomId: t.string(),
    intentId: t.string(),
    kind: t.string(),
    payloadJson: t.string(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const roomId = requireRosterId("roomId", args.roomId, 160);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator"]);
    const room = requireRosterRoom(ctx, workspaceId, roomId);
    const intentId = requireRosterId("intentId", args.intentId, 240);
    const kind = requireRosterId("kind", args.kind, 80);
    if (!ROOM_CONTROL_INTENT_KINDS.has(kind)) reject(`Room control intent kind ${kind} is invalid`);
    const payloadJson = canonicalJson(
      "Room control intent payload",
      JSON.parse(requireJson("payloadJson", args.payloadJson, 256_000)),
      256_000
    );
    const id = compoundKey(roomId, intentId);
    const existing = ctx.db.rosterRoomControlIntent.id.find(id);
    if (existing) {
      if (existing.kind !== kind || existing.payloadJson !== payloadJson) {
        reject(`Room control intent ${intentId} changed after creation`);
      }
      return;
    }
    const activeExecution = room.activeRunId
      ? ctx.db.rosterExecution.runId.find(room.activeRunId)
      : undefined;
    const targetRunId = activeExecution && !TERMINAL_ROSTER_EXECUTION_STATUSES.has(activeExecution.status)
      ? room.activeRunId
      : "";
    ctx.db.rosterRoomControlIntent.insert({
      id,
      workspaceId,
      roomId,
      intentId,
      kind,
      payloadJson,
      status: "pending",
      targetRunId,
      consumedBy: "",
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      consumedAt: undefined,
    });
    if (targetRunId) {
      appendRoomTimelineEntry(ctx, targetRunId, "message", "", "", {
        type: "message",
        intentId,
        kind,
        payload: JSON.parse(payloadJson),
      });
    }
  }
);

export const consumeRosterRoomControlIntent = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    roomId: t.string(),
    intentId: t.string(),
    runId: t.string(),
    consumerId: t.string(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator"]);
    const room = requireRosterRoom(ctx, workspaceId, requireRosterId("roomId", args.roomId, 160));
    const runId = requireRosterId("runId", args.runId, 160);
    if (room.activeRunId !== runId) reject(`Roster room ${room.id} is not running execution ${runId}`);
    const intentId = requireRosterId("intentId", args.intentId, 240);
    const consumerId = requireRosterId("consumerId", args.consumerId, 240);
    const intent = expectValue(
      ctx.db.rosterRoomControlIntent.id.find(compoundKey(room.id, intentId)),
      `Room control intent ${intentId} does not exist`
    );
    if (intent.status === "consumed") {
      if (intent.consumedBy !== consumerId || intent.targetRunId !== runId) {
        reject(`Room control intent ${intentId} was consumed by another coordinator`);
      }
      return;
    }
    if (intent.status !== "pending") reject(`Room control intent ${intentId} is ${intent.status}`);
    ctx.db.rosterRoomControlIntent.id.update({
      ...intent,
      status: "consumed",
      targetRunId: runId,
      consumedBy: consumerId,
      consumedAt: ctx.timestamp,
    });
    appendRosterExecutionEvent(ctx, runId, "roster.room.control-intent.consumed", "", {
      roomId: room.id,
      intentId,
      kind: intent.kind,
      consumerId,
    });
  }
);

/** Explicit typed timeline path for coordination events not derived from graph state. */
export const appendRosterRoomTimelineEntry = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    roomId: t.string(),
    runId: t.string(),
    entryId: t.string(),
    kind: t.string(),
    taskId: t.string(),
    nodeId: t.string(),
    fence: t.u64(),
    entryJson: t.string(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const membership = requireWorkspaceMembership(
      ctx,
      workspaceId,
      ["owner", "coordinator", "worker"]
    );
    const room = requireRosterRoom(ctx, workspaceId, requireRosterId("roomId", args.roomId, 160));
    const runId = requireRosterId("runId", args.runId, 160);
    if (room.activeRunId !== runId) reject(`Roster room ${room.id} is not running execution ${runId}`);
    const entryId = requireRosterId("entryId", args.entryId, 240);
    const kind = requireRosterId("kind", args.kind, 80);
    if (!ROOM_TIMELINE_KINDS.has(kind)) reject(`Room timeline kind ${kind} is invalid`);
    const taskId = args.taskId.trim();
    const nodeId = args.nodeId.trim();
    if (membership.role === "worker") {
      if (!taskId || args.fence === 0n) reject("Workers require an active task fence to append timeline entries");
      const task = requireActiveRosterTaskLease(ctx, runId, taskId, args.fence);
      if (nodeId !== task.nodeId) reject("Timeline entry node does not own the active task lease");
    }
    const entry = asRecord(
      "entryJson",
      JSON.parse(requireJson("entryJson", args.entryJson, MAX_ROOM_TIMELINE_ENTRY_CHARS))
    );
    if (recordString(entry, "type", 80) !== kind) reject("Timeline entry type must match kind");
    const durableId = compoundKey(room.id, entryId);
    const canonicalEntryJson = canonicalJson("Room timeline entry", entry, MAX_ROOM_TIMELINE_ENTRY_CHARS);
    const existing = ctx.db.rosterRoomTimelineEntry.id.find(durableId);
    if (existing) {
      if (
        existing.runId !== runId
        || existing.kind !== kind
        || existing.taskId !== taskId
        || existing.nodeId !== nodeId
        || existing.entryJson !== canonicalEntryJson
      ) reject(`Room timeline entry ${entryId} changed after publication`);
      return;
    }
    const seq = room.nextTimelineSeq + 1n;
    ctx.db.rosterRoomTimelineEntry.insert({
      id: durableId,
      workspaceId,
      roomId: room.id,
      runId,
      seq,
      kind,
      taskId,
      nodeId,
      entryJson: canonicalEntryJson,
      createdAt: ctx.timestamp,
    });
    ctx.db.rosterRoom.id.update({ ...room, nextTimelineSeq: seq, updatedAt: ctx.timestamp });
  }
);

/**
 * Selects the exact room/run for both its bounded head and optional historical
 * page. Public views recheck membership on every evaluation, so viewer expiry
 * or revocation immediately removes both projections.
 */
const deleteCodingRoomTimelineSelectionExpirations = (
  ctx: RosterContext,
  requestId: string,
): void => {
  for (const expiration of [
    ...ctx.db.codingRoomTimelineSelectionExpiration.requestId.filter(requestId),
  ]) {
    ctx.db.codingRoomTimelineSelectionExpiration.scheduledId.delete(expiration.scheduledId);
  }
};

const deleteCodingRoomTimelineSelection = (
  ctx: RosterContext,
  requestId: string,
): void => {
  deleteCodingRoomTimelineSelectionExpirations(ctx, requestId);
  ctx.db.codingRoomTimelinePageRequest.id.delete(requestId);
};

export const selectCodingRoomTimelinePage = spacetimedb.reducer(
  {
    runId: t.string(),
    roomId: t.string(),
    beforeSeq: t.u64(),
    selectionId: t.string(),
    predecessorSelectionId: t.string(),
    ttlSeconds: t.u64(),
  },
  (ctx, args) => {
    const runId = requireRosterId("runId", args.runId, 160);
    requireMembership(ctx, runId, ["owner", "coordinator", "worker", "artist", "viewer"]);
    const execution = requireRosterExecution(ctx, runId);
    const roomId = requireRosterId("roomId", args.roomId, 160);
    const room = requireRosterRoom(ctx, execution.workspaceId, roomId);
    if (room.activeRunId !== runId) {
      reject(`Roster room ${room.id} is not running execution ${runId}`);
    }
    const selectionId = requireRosterId("selectionId", args.selectionId, 96);
    const predecessorSelectionId = args.predecessorSelectionId
      ? requireRosterId("predecessorSelectionId", args.predecessorSelectionId, 96)
      : "";
    if (args.ttlSeconds < MIN_CODING_TIMELINE_SELECTION_TTL_SECONDS
      || args.ttlSeconds > MAX_CODING_TIMELINE_SELECTION_TTL_SECONDS) {
      reject(`ttlSeconds must be between ${MIN_CODING_TIMELINE_SELECTION_TTL_SECONDS} and ${MAX_CODING_TIMELINE_SELECTION_TTL_SECONDS}`);
    }
    const memberKey = identityKey(ctx.sender);
    for (const request of [...ctx.db.codingRoomTimelinePageRequest.member.filter(ctx.sender)]) {
      const expired = !request.expiresAt
        || request.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch;
      const predecessor = predecessorSelectionId
        && predecessorSelectionId !== selectionId
        && request.selectionId === predecessorSelectionId;
      if (!request.selectionId || expired || predecessor) {
        deleteCodingRoomTimelineSelection(ctx, request.id);
      }
    }
    const id = compoundKey(memberKey, selectionId);
    const existing = ctx.db.codingRoomTimelinePageRequest.id.find(id);
    if (!existing) {
      const activeSelectionCount = [...ctx.db.codingRoomTimelinePageRequest.member.filter(ctx.sender)].length;
      if (activeSelectionCount >= MAX_CODING_TIMELINE_SELECTIONS_PER_IDENTITY) {
        reject(`Coding timeline selection limit is ${MAX_CODING_TIMELINE_SELECTIONS_PER_IDENTITY}`);
      }
    }
    const expiresAt = new Timestamp(
      ctx.timestamp.microsSinceUnixEpoch + args.ttlSeconds * 1_000_000n,
    );
    const request = {
      id,
      member: ctx.sender,
      workspaceId: execution.workspaceId,
      roomId: room.id,
      runId,
      beforeSeq: args.beforeSeq,
      requestedAt: ctx.timestamp,
      selectionId,
      expiresAt,
    };
    // Replacing the prior schedule before updating its request guarantees that
    // one active selection owns exactly one live timer in this transaction.
    deleteCodingRoomTimelineSelectionExpirations(ctx, id);
    if (existing) ctx.db.codingRoomTimelinePageRequest.id.update(request);
    else ctx.db.codingRoomTimelinePageRequest.insert(request);
    ctx.db.codingRoomTimelineSelectionExpiration.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(expiresAt.microsSinceUnixEpoch),
      requestId: id,
      expiresAtMicros: expiresAt.microsSinceUnixEpoch,
    });
  }
);

export const expireCodingRoomTimelineSelection = spacetimedb.reducer(
  { timer: codingRoomTimelineSelectionExpiration.rowType },
  (ctx, { timer }) => {
    const request = ctx.db.codingRoomTimelinePageRequest.id.find(timer.requestId);
    if (!request?.expiresAt
      || request.expiresAt.microsSinceUnixEpoch !== timer.expiresAtMicros
      || request.expiresAt.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch) return;
    ctx.db.codingRoomTimelinePageRequest.id.delete(request.id);
  }
);

const decodedBase64Length = (name: string, value: string, maxBytes: number): number => {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    reject(`${name} must be canonical base64`);
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = value.length / 4 * 3 - padding;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxBytes) {
    reject(`${name} exceeds ${maxBytes} decoded bytes`);
  }
  return bytes;
};

export const publishRosterSharedWorkspaceUpdate = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    roomId: t.string(),
    runId: t.string(),
    artifactId: t.string(),
    updateId: t.string(),
    taskId: t.string(),
    nodeId: t.string(),
    fence: t.u64(),
    frontierVersion: t.string(),
    topologyVersion: t.string(),
    catalogVersion: t.string(),
    runtimeBindingEpoch: t.u64(),
    updateBase64: t.string(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    const roomId = requireRosterId("roomId", args.roomId, 160);
    const runId = requireRosterId("runId", args.runId, 160);
    const room = requireRosterRoom(ctx, workspaceId, roomId);
    if (room.activeRunId !== runId) reject(`Roster room ${roomId} is not running execution ${runId}`);
    const task = requireActiveRosterTaskLease(ctx, runId, args.taskId, args.fence);
    const nodeId = requireRosterId("nodeId", args.nodeId, 160);
    if (nodeId !== task.nodeId) reject("Shared-workspace publication node does not own the task lease");
    const frontierVersion = requireRosterVersion("frontierVersion", args.frontierVersion, 200);
    const topologyVersion = requireRosterVersion("topologyVersion", args.topologyVersion, 200);
    const catalogVersion = requireRosterVersion("catalogVersion", args.catalogVersion, 200);
    if (
      frontierVersion !== task.frontierVersion
      || topologyVersion !== task.topologyVersion
      || catalogVersion !== task.catalogVersion
      || args.runtimeBindingEpoch !== task.runtimeBindingEpoch
      || latestRosterRuntimeBindingEpoch(ctx, runId, nodeId) !== task.runtimeBindingEpoch
    ) reject("Shared-workspace publication has a stale execution frontier");
    const artifactId = requireRosterId("artifactId", args.artifactId, 240);
    const updateId = requireRosterId("updateId", args.updateId, 240);
    const updateBytes = decodedBase64Length(
      "updateBase64",
      args.updateBase64,
      MAX_SHARED_WORKSPACE_UPDATE_BYTES
    );
    const id = compoundKey(runId, updateId);
    const existing = ctx.db.rosterSharedWorkspaceUpdate.id.find(id);
    if (existing) {
      if (
        existing.taskId !== task.taskId
        || existing.nodeId !== nodeId
        || existing.fence !== args.fence
        || existing.artifactId !== artifactId
        || existing.updateBase64 !== args.updateBase64
      ) reject(`Shared-workspace update ${updateId} changed after publication`);
      return;
    }
    let retainedUpdates = 0;
    for (const update of ctx.db.rosterSharedWorkspaceUpdate.runId.filter(runId)) {
      if (update.artifactId === artifactId) retainedUpdates += 1;
    }
    if (retainedUpdates >= 4_096) reject("Shared-workspace retained update bound reached; checkpoint first");
    ctx.db.rosterSharedWorkspaceUpdate.insert({
      id,
      workspaceId,
      roomId,
      runId,
      artifactId,
      updateId,
      taskId: task.taskId,
      nodeId,
      fence: args.fence,
      frontierVersion,
      topologyVersion,
      catalogVersion,
      runtimeBindingEpoch: args.runtimeBindingEpoch,
      updateBase64: args.updateBase64,
      updateBytes,
      createdAt: ctx.timestamp,
    });
    appendProjectionOutbox(ctx, runId, "shared-workspace-update", `workspace-update:${updateId}`, {
      artifactId,
      updateId,
      updateBytes,
    });
  }
);

export const checkpointRosterSharedWorkspace = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    roomId: t.string(),
    runId: t.string(),
    artifactId: t.string(),
    checkpointId: t.string(),
    throughUpdateId: t.string(),
    frontierVersion: t.string(),
    topologyVersion: t.string(),
    stateBase64: t.string(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator"]);
    const roomId = requireRosterId("roomId", args.roomId, 160);
    const runId = requireRosterId("runId", args.runId, 160);
    const room = requireRosterRoom(ctx, workspaceId, roomId);
    if (room.activeRunId !== runId) reject(`Roster room ${roomId} is not running execution ${runId}`);
    const artifactId = requireRosterId("artifactId", args.artifactId, 240);
    const checkpointId = requireRosterId("checkpointId", args.checkpointId, 240);
    const throughUpdateId = requireRosterId("throughUpdateId", args.throughUpdateId, 240);
    const throughUpdate = expectValue(
      ctx.db.rosterSharedWorkspaceUpdate.id.find(compoundKey(runId, throughUpdateId)),
      `Shared-workspace update ${throughUpdateId} does not exist`
    );
    if (throughUpdate.artifactId !== artifactId) reject("Checkpoint through-update targets another artifact");
    const frontierVersion = requireRosterVersion("frontierVersion", args.frontierVersion, 200);
    const topologyVersion = requireRosterVersion("topologyVersion", args.topologyVersion, 200);
    if (
      throughUpdate.frontierVersion !== frontierVersion
      || throughUpdate.topologyVersion !== topologyVersion
    ) reject("Checkpoint frontier does not match its through-update");
    const stateBytes = decodedBase64Length(
      "stateBase64",
      args.stateBase64,
      MAX_SHARED_WORKSPACE_STATE_BYTES
    );
    const id = compoundKey(runId, checkpointId);
    const existing = ctx.db.rosterSharedWorkspaceCheckpoint.id.find(id);
    if (existing) {
      if (
        existing.artifactId !== artifactId
        || existing.throughUpdateId !== throughUpdateId
        || existing.stateBase64 !== args.stateBase64
      ) reject(`Shared-workspace checkpoint ${checkpointId} changed after publication`);
      return;
    }
    ctx.db.rosterSharedWorkspaceCheckpoint.insert({
      id,
      workspaceId,
      roomId,
      runId,
      artifactId,
      checkpointId,
      throughUpdateId,
      frontierVersion,
      topologyVersion,
      stateBase64: args.stateBase64,
      stateBytes,
      createdAt: ctx.timestamp,
    });
    appendRoomTimelineEntry(ctx, runId, "checkpoint", "", "", {
      type: "checkpoint",
      checkpointId,
      artifactId,
      throughUpdateId,
      frontierVersion,
      topologyVersion,
    });
  }
);

export const enqueueRosterTask = spacetimedb.reducer(
  { runId: t.string(), definitionJson: t.string() },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const execution = requireActiveRosterExecution(ctx, runId);
    requireRosterCoordinator(ctx, execution);
    const policy = parseRosterExecutionPolicy(execution.policyJson);
    const spec = parseRosterTaskDefinition("definitionJson", args.definitionJson, policy);
    if (spec.parentTaskId) {
      reject("enqueueRosterTask only admits root tasks; publish child work through task.graph.expanded");
    }
    const existing = ctx.db.rosterTaskDefinition.id.find(rosterTaskKey(runId, spec.taskId));
    if (existing) {
      if (existing.definitionJson !== spec.definitionJson || existing.definitionHash !== spec.definitionHash) {
        reject(`Roster task ${spec.taskId} changed after enqueue`);
      }
      return;
    }
    insertRosterTaskDefinition(ctx, execution, policy, spec, 0);
    const inserted = requireRosterTask(ctx, runId, spec.taskId);
    if (inserted.status === "skipped") propagateRosterTerminalDisposition(ctx, runId, inserted.id);
    refreshRosterExecution(ctx, runId);
    appendRosterExecutionEvent(ctx, runId, "roster.task.enqueued", spec.nodeId, {
      taskId: spec.taskId,
      semanticKey: spec.semanticKey,
      definitionHash: spec.definitionHash,
      status: inserted.status,
    });
  }
);

/**
 * Atomically publish bounded child work and a continuation, then relinquish the
 * parent lease. The expansion key is fence-independent, so a new lease epoch
 * can safely replay an already committed publication.
 */
export const expandAndDelegateRosterTask = spacetimedb.reducer(
  {
    runId: t.string(),
    parentTaskId: t.string(),
    fence: t.u64(),
    expansionKey: t.string(),
    childrenJson: t.string(),
    continuationJson: t.string(),
    usageJson: t.string(),
  },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const parentTaskId = requireText("parentTaskId", args.parentTaskId, 160);
    const expansionKey = requireText("expansionKey", args.expansionKey, 200);
    const execution = requireActiveRosterExecution(ctx, runId);
    const membership = requireWorkspaceMembership(
      ctx,
      execution.workspaceId,
      ["owner", "coordinator", "worker"]
    );
    const policy = parseRosterExecutionPolicy(execution.policyJson);
    const childrenValues = asArray(
      "childrenJson",
      JSON.parse(requireJson("childrenJson", args.childrenJson, 1_500_000)),
      policy.maxFanout
    );
    if (childrenValues.length < 1) reject("childrenJson must contain at least one child");
    const childSpecs = childrenValues.map((value, index) =>
      parseRosterTaskDefinitionValue(`childrenJson[${index}]`, value, policy)
    ).sort((left, right) => left.semanticKey.localeCompare(right.semanticKey));
    const continuationSpec = parseRosterTaskDefinition("continuationJson", args.continuationJson, policy);
    const usage = args.usageJson.trim()
      ? parseJsonRecord("usageJson", args.usageJson, 64_000)
      : {};
    const {
      actualCostMicros,
      totalTokens,
      cachedInputTokens,
      budgetTokens,
    } = rosterUsageTotals("usageJson", usage);
    const allSpecs = [...childSpecs, continuationSpec];
    const canonicalExpansionSpec = canonicalJson("expansion", {
      children: childSpecs.map((spec) => JSON.parse(spec.definitionJson)),
      continuation: JSON.parse(continuationSpec.definitionJson),
      usage,
    }, 1_800_000);
    const parentKey = rosterTaskKey(runId, parentTaskId);
    const expansionId = expansionRecordKey(parentKey, expansionKey);
    const existingExpansion = ctx.db.rosterTaskExpansion.id.find(expansionId);
    if (existingExpansion) {
      if (existingExpansion.expansionSpecJson !== canonicalExpansionSpec) {
        reject(`expansion ${expansionKey} changed after publication`);
      }
      if (!existingExpansion.delegatedBy.equals(ctx.sender) && membership.role === "worker") {
        reject(`expansion ${expansionKey} was published by another worker`);
      }
      return;
    }
    const parent = requireActiveRosterTaskLease(ctx, runId, parentTaskId, args.fence);
    if (!rosterWorkerCanRunTask(ctx, runId, membership.role, parent.capability)) {
      reject(`worker lacks capability ${parent.capability}`);
    }
    if (allSpecs.length > policy.maxFanout + 1) reject("expansion exceeds maxFanout");
    const continuationDependencies = new Set(
      continuationSpec.dependencies.map((dependency) => dependency.taskId)
    );
    for (const child of childSpecs) {
      if (!continuationDependencies.has(child.taskId)) {
        reject(`continuation task must explicitly join child ${child.taskId}`);
      }
    }
    const childDepth = parent.depth + 1;
    if (childDepth > policy.maxDepth) reject("expansion exceeds maxDepth");
    if (execution.totalTasks + allSpecs.length > policy.maxTasks) reject("expansion exceeds maxTasks");
    const seenTaskIds = new Set<string>();
    const seenSemanticKeys = new Set<string>();
    for (const spec of allSpecs) {
      if (spec.parentTaskId !== parentTaskId) {
        reject(`expanded task ${spec.taskId} must name parentTaskId ${parentTaskId}`);
      }
      if (seenTaskIds.has(spec.taskId)) reject(`expansion repeats task ${spec.taskId}`);
      if (seenSemanticKeys.has(spec.semanticKey)) reject(`expansion repeats semantic key ${spec.semanticKey}`);
      seenTaskIds.add(spec.taskId);
      seenSemanticKeys.add(spec.semanticKey);
      if (ctx.db.rosterTaskDefinition.id.find(rosterTaskKey(runId, spec.taskId))) {
        reject(`expanded task ${spec.taskId} already exists`);
      }
    }
    const pending = [...allSpecs];
    const inserted = new Set<string>();
    while (pending.length > 0) {
      const availableIndex = pending.findIndex((spec) =>
        spec.dependencies.every((dependency) =>
          ctx.db.rosterTaskDefinition.id.find(rosterTaskKey(runId, dependency.taskId))
          || inserted.has(dependency.taskId)
        )
      );
      if (availableIndex < 0) reject("expansion contains a dependency cycle or missing dependency");
      const [spec] = pending.splice(availableIndex, 1);
      insertRosterTaskDefinition(ctx, requireRosterExecution(ctx, runId), policy, spec, childDepth);
      inserted.add(spec.taskId);
    }
    ctx.db.rosterTaskExpansion.insert({
      id: expansionId,
      runId,
      parentTaskKey: parent.id,
      parentTaskId,
      publicationFence: args.fence,
      expansionKey,
      expansionSpecJson: canonicalExpansionSpec,
      childCount: childSpecs.length,
      continuationTaskId: continuationSpec.taskId,
      delegatedBy: ctx.sender,
      createdAt: ctx.timestamp,
    });
    ctx.db.rosterTaskDefinition.id.update({
      ...parent,
      status: "delegated",
      leaseOwner: undefined,
      leaseUntil: undefined,
      lastError: "",
      updatedAt: ctx.timestamp,
    });
    settleTaskModelReservation(
      ctx,
      parent,
      args.fence,
      actualCostMicros,
      totalTokens,
      "settled"
    );
    const afterInsert = requireRosterExecution(ctx, runId);
    const spentCostMicros = afterInsert.spentCostMicros + actualCostMicros;
    const usedTokens = afterInsert.usedTokens + budgetTokens;
    const budgetExceeded = spentCostMicros > policy.maxCostMicros || usedTokens > policy.maxTokens;
    ctx.db.rosterExecution.runId.update({
      ...afterInsert,
      reservedCostMicros: afterInsert.reservedCostMicros >= parent.estimatedCostMicros
        ? afterInsert.reservedCostMicros - parent.estimatedCostMicros
        : 0n,
      spentCostMicros,
      usedTokens,
      status: budgetExceeded ? "budget_exhausted" : afterInsert.status,
      terminalReason: budgetExceeded
        ? "delegation usage exceeded execution policy"
        : afterInsert.terminalReason,
      graphVersion: afterInsert.graphVersion + 1n,
      updatedAt: ctx.timestamp,
    });
    if (budgetExceeded) {
      for (const candidate of ctx.db.rosterTaskDefinition.runId.filter(runId)) {
        if (TERMINAL_ROSTER_TASK_STATUSES.has(candidate.status)) continue;
        ctx.db.rosterTaskDefinition.id.update({
          ...candidate,
          status: "canceled",
          leaseOwner: undefined,
          leaseUntil: undefined,
          lastError: "execution budget exhausted",
          updatedAt: ctx.timestamp,
        });
      }
    } else promoteEligibleBlockedRosterTasks(ctx, runId);
    refreshRosterExecution(ctx, runId);
    appendRosterExecutionEvent(ctx, runId, "task.graph.expanded", parent.nodeId, {
      parentTaskId,
      expansionKey,
      publicationFence: args.fence.toString(),
      childTaskIds: childSpecs.map((spec) => spec.taskId),
      continuationTaskId: continuationSpec.taskId,
      actualCostMicros: actualCostMicros.toString(),
      totalTokens: totalTokens.toString(),
      cachedInputTokens: cachedInputTokens.toString(),
      budgetTokens: budgetTokens.toString(),
      budgetExceeded,
    });
    appendRoomTimelineEntry(ctx, runId, "handoff", parentTaskId, parent.nodeId, {
      type: "handoff",
      fromTaskId: parentTaskId,
      toTaskIds: childSpecs.map((spec) => spec.taskId),
      continuationTaskId: continuationSpec.taskId,
      expansionKey,
    });
  }
);

export const claimRosterTask = spacetimedb.reducer(
  { runId: t.string(), taskId: t.string(), leaseMs: t.u32() },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const taskId = requireText("taskId", args.taskId, 160);
    const execution = requireActiveRosterExecution(ctx, runId);
    const membership = requireWorkspaceMembership(
      ctx,
      execution.workspaceId,
      ["owner", "worker", "coordinator"]
    );
    const policy = parseRosterExecutionPolicy(execution.policyJson);
    const task = requireRosterTask(ctx, runId, taskId);
    if (args.leaseMs < 5_000 || args.leaseMs > 600_000) reject("leaseMs must be between 5000 and 600000");
    if (args.leaseMs > task.timeoutMs) reject(`leaseMs exceeds task ${taskId} timeoutMs`);
    if (task.status !== "ready") reject(`Roster task ${taskId} is not ready`);
    if (task.availableAt.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch) {
      reject(`Roster task ${taskId} retry backoff is active`);
    }
    if (execution.inflightTasks >= policy.maxInflight) {
      reject(`Roster execution ${runId} reached maxInflight`);
    }
    if (!rosterWorkerCanRunTask(ctx, runId, membership.role, task.capability)) {
      reject(`worker lacks capability ${task.capability}`);
    }
    const latestBindingEpoch = latestRosterRuntimeBindingEpoch(ctx, runId, task.nodeId);
    if (latestBindingEpoch > 0n && latestBindingEpoch !== task.runtimeBindingEpoch) {
      reject(`Roster task ${taskId} has a stale runtime binding epoch`);
    }
    const attempt = task.attempt + 1;
    if (attempt > task.maxAttempts) reject(`Roster task ${taskId} exhausted its attempts`);
    if (
      execution.spentCostMicros + execution.reservedCostMicros + task.estimatedCostMicros
      > policy.maxCostMicros
    ) reject(`Roster execution ${runId} reached maxCostMicros`);
    const fence = task.leaseFence + 1n;
    const leaseUntilMicros = ctx.timestamp.microsSinceUnixEpoch + BigInt(args.leaseMs) * 1_000n;
    const leaseUntil = new Timestamp(leaseUntilMicros);
    ctx.db.rosterTaskDefinition.id.update({
      ...task,
      status: "leased",
      attempt,
      leaseOwner: ctx.sender,
      leaseFence: fence,
      leaseUntil,
      lastError: "",
      updatedAt: ctx.timestamp,
    });
    ctx.db.rosterTaskLeaseExpiry.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(leaseUntilMicros),
      taskKey: task.id,
      fence,
    });
    const room = roomForRun(ctx.db.rosterRoom.activeRunId.filter(runId));
    const reservationId = compoundKey(task.id, fence.toString());
    ctx.db.rosterModelReservation.insert({
      id: reservationId,
      workspaceId: execution.workspaceId,
      roomId: room?.id ?? "",
      runId,
      taskId,
      nodeId: task.nodeId,
      fence,
      provider: "",
      model: "",
      status: "reserved",
      reservedCostMicros: task.estimatedCostMicros,
      actualCostMicros: 0n,
      reservedTokens: 0n,
      actualTokens: 0n,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    const latest = requireRosterExecution(ctx, runId);
    ctx.db.rosterExecution.runId.update({
      ...latest,
      reservedCostMicros: latest.reservedCostMicros + task.estimatedCostMicros,
      updatedAt: ctx.timestamp,
    });
    promoteEligibleBlockedRosterTasks(ctx, runId);
    refreshRosterExecution(ctx, runId);
    appendRosterExecutionEvent(ctx, runId, "roster.task.claimed", task.nodeId, {
      taskId,
      attempt,
      fence: fence.toString(),
    });
    appendRoomTimelineEntry(ctx, runId, "claim", taskId, task.nodeId, {
      type: "claim",
      taskId,
      nodeId: task.nodeId,
      attempt,
      fence: fence.toString(),
    });
  }
);

export const heartbeatRosterTask = spacetimedb.reducer(
  { runId: t.string(), taskId: t.string(), fence: t.u64(), leaseMs: t.u32() },
  (ctx, args) => {
    if (args.leaseMs < 5_000 || args.leaseMs > 600_000) reject("leaseMs must be between 5000 and 600000");
    const task = requireActiveRosterTaskLease(ctx, args.runId, args.taskId, args.fence);
    if (args.leaseMs > task.timeoutMs) reject(`leaseMs exceeds task ${args.taskId} timeoutMs`);
    const leaseUntilMicros = ctx.timestamp.microsSinceUnixEpoch + BigInt(args.leaseMs) * 1_000n;
    ctx.db.rosterTaskDefinition.id.update({
      ...task,
      leaseUntil: new Timestamp(leaseUntilMicros),
      updatedAt: ctx.timestamp,
    });
    ctx.db.rosterTaskLeaseExpiry.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(leaseUntilMicros),
      taskKey: task.id,
      fence: args.fence,
    });
  }
);

/** Attach provider/model/token bounds to the reservation created with the task lease. */
export const reserveRosterModelCall = spacetimedb.reducer(
  {
    runId: t.string(),
    taskId: t.string(),
    fence: t.u64(),
    provider: t.string(),
    model: t.string(),
    reservedTokens: t.u64(),
  },
  (ctx, args) => {
    const task = requireActiveRosterTaskLease(ctx, args.runId, args.taskId, args.fence);
    const provider = requireText("provider", args.provider, 120);
    const model = requireText("model", args.model, 240);
    const execution = requireRosterExecution(ctx, args.runId);
    const policy = parseRosterExecutionPolicy(execution.policyJson);
    let otherReservedTokens = 0n;
    for (const reservation of ctx.db.rosterModelReservation.runId.filter(args.runId)) {
      if (
        reservation.id !== compoundKey(task.id, args.fence.toString())
        && (reservation.status === "reserved" || reservation.status === "dispatched")
      ) otherReservedTokens += reservation.reservedTokens;
    }
    if (execution.usedTokens + otherReservedTokens + args.reservedTokens > policy.maxTokens) {
      reject(`Roster execution ${args.runId} reached maxTokens`);
    }
    const id = compoundKey(task.id, args.fence.toString());
    let reservation = ctx.db.rosterModelReservation.id.find(id);
    if (!reservation) {
      const room = roomForRun(ctx.db.rosterRoom.activeRunId.filter(args.runId));
      reservation = ctx.db.rosterModelReservation.insert({
        id,
        workspaceId: execution.workspaceId,
        roomId: room?.id ?? "",
        runId: args.runId,
        taskId: args.taskId,
        nodeId: task.nodeId,
        fence: args.fence,
        provider: "",
        model: "",
        status: "reserved",
        reservedCostMicros: task.estimatedCostMicros,
        actualCostMicros: 0n,
        reservedTokens: 0n,
        actualTokens: 0n,
        createdAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      });
    }
    if (reservation.status !== "reserved") {
      if (
        reservation.provider === provider
        && reservation.model === model
        && reservation.reservedTokens === args.reservedTokens
      ) return;
      reject(`Model reservation ${id} cannot change after dispatch`);
    }
    ctx.db.rosterModelReservation.id.update({
      ...reservation,
      provider,
      model,
      reservedTokens: args.reservedTokens,
      updatedAt: ctx.timestamp,
    });
  }
);

/** Persist a replacement runtime placement without changing logical node identity. */
export const bindRosterNodeRuntime = spacetimedb.reducer(
  {
    workspaceId: t.string(),
    roomId: t.string(),
    runId: t.string(),
    bindingJson: t.string(),
  },
  (ctx, args) => {
    const workspaceId = requireText("workspaceId", args.workspaceId, 160);
    requireWorkspaceMembership(ctx, workspaceId, ["owner", "coordinator"]);
    const room = requireRosterRoom(ctx, workspaceId, requireRosterId("roomId", args.roomId, 160));
    const runId = requireRosterId("runId", args.runId, 160);
    if (room.activeRunId !== runId) reject(`Roster room ${room.id} is not running execution ${runId}`);
    const binding = asRecord(
      "bindingJson",
      JSON.parse(requireJson("bindingJson", args.bindingJson, 64_000))
    );
    const bindingId = requireRosterId("bindingJson.bindingId", recordString(binding, "bindingId", 240), 240);
    const nodeId = requireRosterId("bindingJson.nodeId", recordString(binding, "nodeId", 160), 160);
    const epoch = recordU64(binding, "epoch", BigInt(Number.MAX_SAFE_INTEGER));
    const topologyVersion = requireRosterVersion(
      "bindingJson.topologyVersion",
      recordString(binding, "topologyVersion", 200),
      200
    );
    const node = ctx.db.rosterRoomNode.id.find(compoundKey(runId, nodeId));
    if (!node || node.roomId !== room.id) reject(`Roster node ${nodeId} is not in room ${room.id}`);
    const frontier = expectValue(
      ctx.db.rosterContextFrontier.id.find(runId),
      `Roster context frontier ${runId} does not exist`
    );
    if (frontier.topologyVersion !== topologyVersion) reject("Runtime binding has a stale topology version");
    const id = compoundKey(runId, bindingId);
    const runtimeJson = canonicalJson("Runtime binding", binding, 64_000);
    const existing = ctx.db.rosterRuntimeBinding.id.find(id);
    if (existing) {
      if (
        existing.nodeId !== nodeId
        || existing.epoch !== epoch
        || existing.runtimeJson !== runtimeJson
      ) reject(`Runtime binding ${bindingId} changed after publication`);
      return;
    }
    let currentEpoch = 0n;
    for (const candidate of ctx.db.rosterRuntimeBinding.runId.filter(runId)) {
      if (candidate.nodeId === nodeId && candidate.epoch > currentEpoch) currentEpoch = candidate.epoch;
    }
    if (epoch !== currentEpoch + 1n) {
      reject(`Runtime binding epoch for node ${nodeId} must be ${(currentEpoch + 1n).toString()}`);
    }
    ctx.db.rosterRuntimeBinding.insert({
      id,
      workspaceId,
      roomId: room.id,
      runId,
      nodeId,
      bindingId,
      epoch,
      topologyVersion,
      runtimeJson,
      createdAt: ctx.timestamp,
    });
    const bindingVersion = `binding_${rosterHashCanonical({
      prior: frontier.bindingVersion,
      nodeId,
      bindingId,
      epoch: epoch.toString(),
    }).slice(0, 28)}`;
    ctx.db.rosterContextFrontier.id.update({
      ...frontier,
      bindingVersion,
      updatedAt: ctx.timestamp,
    });
    appendRosterExecutionEvent(ctx, runId, "roster.runtime.bound", nodeId, {
      bindingId,
      epoch: epoch.toString(),
      topologyVersion,
      bindingVersion,
    });
  }
);

/** Fence proving that the external provider may have observed the request. */
export const markRosterModelReservationDispatched = spacetimedb.reducer(
  { runId: t.string(), taskId: t.string(), fence: t.u64() },
  (ctx, args) => {
    const task = requireActiveRosterTaskLease(ctx, args.runId, args.taskId, args.fence);
    const id = compoundKey(task.id, args.fence.toString());
    const reservation = expectValue(
      ctx.db.rosterModelReservation.id.find(id),
      `Model reservation for task ${args.taskId} fence ${args.fence.toString()} does not exist`
    );
    if (reservation.status === "dispatched") return;
    if (reservation.status !== "reserved") reject(`Model reservation ${id} cannot be dispatched`);
    ctx.db.rosterModelReservation.id.update({
      ...reservation,
      status: "dispatched",
      updatedAt: ctx.timestamp,
    });
    appendRosterExecutionEvent(ctx, args.runId, "roster.model.dispatched", task.nodeId, {
      taskId: args.taskId,
      fence: args.fence.toString(),
      provider: reservation.provider,
      model: reservation.model,
    });
  }
);

/** Reconcile an uncertain provider call after external billing/result inspection. */
export const settleRosterModelReservation = spacetimedb.reducer(
  {
    runId: t.string(),
    taskId: t.string(),
    fence: t.u64(),
    actualCostMicros: t.u64(),
    actualTokens: t.u64(),
  },
  (ctx, args) => {
    const runId = requireRosterId("runId", args.runId, 160);
    const taskId = requireRosterId("taskId", args.taskId, 160);
    const execution = requireRosterExecution(ctx, runId);
    requireRosterCoordinator(ctx, execution);
    const task = requireRosterTask(ctx, runId, taskId);
    const reservation = expectValue(
      ctx.db.rosterModelReservation.id.find(compoundKey(task.id, args.fence.toString())),
      `Model reservation for task ${taskId} fence ${args.fence.toString()} does not exist`
    );
    if (reservation.status === "settled") {
      if (
        reservation.actualCostMicros !== args.actualCostMicros
        || reservation.actualTokens !== args.actualTokens
      ) reject(`Model reservation ${reservation.id} settlement changed`);
      return;
    }
    if (reservation.status !== "uncertain") {
      reject(`Only an uncertain model reservation can be reconciled explicitly`);
    }
    const policy = parseRosterExecutionPolicy(execution.policyJson);
    const spentCostMicros = execution.spentCostMicros + args.actualCostMicros;
    // Explicit reconciliation receives the already budgeted token count. Raw
    // provider totals remain available on ordinary immutable task outcomes.
    const budgetTokens = args.actualTokens;
    const usedTokens = execution.usedTokens + budgetTokens;
    const budgetExceeded = spentCostMicros > policy.maxCostMicros || usedTokens > policy.maxTokens;
    ctx.db.rosterModelReservation.id.update({
      ...reservation,
      status: "settled",
      actualCostMicros: args.actualCostMicros,
      actualTokens: args.actualTokens,
      updatedAt: ctx.timestamp,
    });
    ctx.db.rosterExecution.runId.update({
      ...execution,
      reservedCostMicros: execution.reservedCostMicros >= reservation.reservedCostMicros
        ? execution.reservedCostMicros - reservation.reservedCostMicros
        : 0n,
      spentCostMicros,
      usedTokens,
      status: budgetExceeded ? "budget_exhausted" : execution.status,
      terminalReason: budgetExceeded ? "reconciled usage exceeded execution policy" : execution.terminalReason,
      updatedAt: ctx.timestamp,
    });
    if (budgetExceeded) {
      for (const candidate of ctx.db.rosterTaskDefinition.runId.filter(runId)) {
        if (TERMINAL_ROSTER_TASK_STATUSES.has(candidate.status)) continue;
        ctx.db.rosterTaskDefinition.id.update({
          ...candidate, status: "canceled", leaseOwner: undefined, leaseUntil: undefined,
          lastError: "execution budget exhausted", updatedAt: ctx.timestamp,
        });
      }
      refreshRosterExecution(ctx, runId);
    }
    appendRosterExecutionEvent(ctx, runId, "roster.model.reconciled", task.nodeId, {
      taskId,
      fence: args.fence.toString(),
      actualCostMicros: args.actualCostMicros.toString(),
      actualTokens: args.actualTokens.toString(),
      budgetTokens: budgetTokens.toString(),
    });
  }
);

const rosterTaskContextSafeNumber = (name: string, value: bigint): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    reject(`${name} exceeds the task context safe-integer bound`);
  }
  return Number(value);
};

const sortedRosterTaskContextIds = (
  name: string,
  values: Iterable<string>
): ReadonlyArray<string> => {
  const ids = [...new Set(values)];
  if (ids.length > 2_000) reject(`${name} exceeds 2000 entries`);
  for (const id of ids) requireRosterId(`${name} entry`, id, 500);
  return ids.sort((left, right) => left.localeCompare(right));
};

const validatedRosterTaskExecutionGrant = (
  name: string,
  value: unknown,
  execution: ReturnType<typeof requireRosterExecution>,
  task: ReturnType<typeof requireRosterTask>,
  fence: bigint
): JsonRecord => {
  const exactKeys = (
    path: string,
    record: JsonRecord,
    allowed: ReadonlyArray<string>
  ): void => {
    const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
    const missing = allowed.find((key) => !(key in record));
    if (unexpected || missing) reject(`${path} does not contain its exact schema fields`);
  };
  const exactStrings = (
    path: string,
    value: unknown,
    maximum: number,
    allowed?: ReadonlyArray<string>
  ): ReadonlyArray<string> => {
    const values = asArray(path, value, maximum).map((item) => {
      if (typeof item !== "string") reject(`${path} entries must be strings`);
      const normalized = (item as string).trim();
      if (!normalized || normalized.length > 240 || normalized !== item) {
        reject(`${path} entries must be normalized bounded strings`);
      }
      if (allowed && !allowed.includes(normalized)) reject(`${path} contains unsupported ${normalized}`);
      return normalized;
    });
    if (
      new Set(values).size !== values.length
      || values.some((item, index) => index > 0 && values[index - 1]!.localeCompare(item) >= 0)
    ) reject(`${path} entries must be unique and sorted`);
    return values;
  };
  const grant = asRecord(name, value);
  exactKeys(name, grant, [
    "schemaVersion",
    "grantId",
    "policyVersion",
    "runId",
    "taskId",
    "nodeId",
    "attempt",
    "fence",
    "taskDefinitionHash",
    "frontierVersion",
    "topologyVersion",
    "catalogVersion",
    "runtimeBindingEpoch",
    "riskAssessment",
    "admissionDecision",
    "functionAccess",
    "workspaceOperations",
    "allowGraphExpansion",
    "surface",
    "budgets",
  ]);
  if (recordString(grant, "schemaVersion", 120) !== "roster.task-execution-grant.v1") {
    reject(`${name} has an unsupported schema version`);
  }
  const grantId = recordString(grant, "grantId", 120);
  const { grantId: _grantId, ...grantIdentity } = grant;
  if (grantId !== `grant_${rosterHashCanonical(grantIdentity).slice(0, 28)}`) {
    reject(`${name} identity does not match its exact contents`);
  }
  const risk = asRecord(`${name}.riskAssessment`, grant.riskAssessment);
  exactKeys(`${name}.riskAssessment`, risk, [
    "schemaVersion",
    "assessmentId",
    "taskDefinitionHash",
    "policyVersion",
    "riskClass",
    "rationale",
  ]);
  if (recordString(risk, "schemaVersion", 120) !== "roster.task-risk-assessment.v1") {
    reject(`${name}.riskAssessment has an unsupported schema version`);
  }
  const riskClass = recordString(risk, "riskClass", 32);
  if (!["read-only", "workspace-write", "external", "non-repeatable"].includes(riskClass)) {
    reject(`${name}.riskAssessment has an unsupported risk class`);
  }
  recordString(risk, "rationale", 2_000);
  const assessmentId = recordString(risk, "assessmentId", 120);
  const { assessmentId: _assessmentId, ...assessmentIdentity } = risk;
  if (assessmentId !== `risk_${rosterHashCanonical(assessmentIdentity).slice(0, 28)}`) {
    reject(`${name}.riskAssessment identity does not match its exact contents`);
  }
  const decision = asRecord(`${name}.admissionDecision`, grant.admissionDecision);
  exactKeys(`${name}.admissionDecision`, decision, [
    "schemaVersion",
    "decisionId",
    "taskDefinitionHash",
    "assessmentId",
    "policyVersion",
    "disposition",
    "authority",
    "reason",
    ...(decision.authorizationId === undefined ? [] : ["authorizationId"]),
  ]);
  if (recordString(decision, "schemaVersion", 120) !== "roster.task-admission-decision.v1") {
    reject(`${name}.admissionDecision has an unsupported schema version`);
  }
  const decisionId = recordString(decision, "decisionId", 120);
  const { decisionId: _decisionId, ...decisionIdentity } = decision;
  if (decisionId !== `admission_${rosterHashCanonical(decisionIdentity).slice(0, 28)}`) {
    reject(`${name}.admissionDecision identity does not match its exact contents`);
  }
  const policyVersion = recordString(grant, "policyVersion", 240);
  const authority = recordString(decision, "authority", 32);
  if (decision.authorizationId !== undefined && typeof decision.authorizationId !== "string") {
    reject(`${name}.admissionDecision.authorizationId must be a string when present`);
  }
  const authorizationId = optionalRecordString(decision, "authorizationId", 240);
  if (
    (authority !== "deterministic-policy" && authority !== "human")
    || (authority === "human" && !authorizationId)
    || (authority === "deterministic-policy" && authorizationId)
  ) reject(`${name}.admissionDecision has inconsistent authority`);
  recordString(decision, "reason", 2_000);
  if (
    recordString(risk, "policyVersion", 240) !== policyVersion
    || recordString(decision, "policyVersion", 240) !== policyVersion
    || recordString(decision, "assessmentId", 120) !== assessmentId
    || recordString(decision, "disposition", 32) !== "granted"
  ) {
    reject(`${name} does not contain one consistent granted policy decision`);
  }
  if (typeof grant.allowGraphExpansion !== "boolean") {
    reject(`${name}.allowGraphExpansion must be a boolean`);
  }
  const expectedFence = rosterTaskContextSafeNumber("Task execution grant fence", fence);
  if (
    recordString(grant, "runId", 240) !== execution.runId
    || recordString(grant, "taskId", 240) !== task.taskId
    || recordString(grant, "nodeId", 240) !== task.nodeId
    || recordU32(grant, "attempt", 4_294_967_295) !== task.attempt
    || recordU32(grant, "fence", Number.MAX_SAFE_INTEGER) !== expectedFence
    || recordString(grant, "taskDefinitionHash", 120) !== task.definitionHash
    || recordString(grant, "frontierVersion", 240) !== task.frontierVersion
    || recordString(grant, "topologyVersion", 240) !== task.topologyVersion
    || recordString(grant, "catalogVersion", 240) !== task.catalogVersion
    || recordU64(grant, "runtimeBindingEpoch", BigInt(Number.MAX_SAFE_INTEGER))
      !== task.runtimeBindingEpoch
    || recordString(risk, "taskDefinitionHash", 120) !== task.definitionHash
    || recordString(decision, "taskDefinitionHash", 120) !== task.definitionHash
  ) {
    reject(`${name} does not match the active run, task, and lease fence`);
  }
  const access = asRecord(`${name}.functionAccess`, grant.functionAccess);
  exactKeys(`${name}.functionAccess`, access, [
    "functionGrants",
    "scopes",
    "allowedEffects",
  ]);
  exactStrings(`${name}.functionAccess.functionGrants`, access.functionGrants, 256);
  exactStrings(`${name}.functionAccess.scopes`, access.scopes, 256);
  const allowedEffects = exactStrings(
    `${name}.functionAccess.allowedEffects`,
    access.allowedEffects,
    3,
    ["external", "read", "write"],
  );
  exactStrings(
    `${name}.workspaceOperations`,
    grant.workspaceOperations,
    2,
    ["publish", "read"],
  );
  const expectedRisk = task.sideEffect === "non-repeatable"
    ? "non-repeatable"
    : allowedEffects.includes("external")
      ? "external"
      : task.sideEffect === "idempotent" || allowedEffects.includes("write")
        ? "workspace-write"
        : "read-only";
  if (riskClass !== expectedRisk) {
    reject(`${name}.riskAssessment does not match deterministic task effects`);
  }
  const surface = asRecord(`${name}.surface`, grant.surface);
  exactKeys(`${name}.surface`, surface, [
    "skills",
    "tools",
    ...(surface.codeMode === undefined ? [] : ["codeMode"]),
  ]);
  const skillIds = asArray(`${name}.surface.skills`, surface.skills, 256).map((value, index) => {
    const skill = asRecord(`${name}.surface.skills[${index}]`, value);
    exactKeys(`${name}.surface.skills[${index}]`, skill, ["id", "contentHash"]);
    recordString(skill, "contentHash", 240);
    return recordString(skill, "id", 240);
  });
  if (
    new Set(skillIds).size !== skillIds.length
    || skillIds.some((id, index) => index > 0 && skillIds[index - 1]!.localeCompare(id) >= 0)
  ) reject(`${name}.surface.skills must have unique sorted IDs`);
  const toolIds = asArray(`${name}.surface.tools`, surface.tools, 256).map((value, index) => {
    const tool = asRecord(`${name}.surface.tools[${index}]`, value);
    exactKeys(`${name}.surface.tools[${index}]`, tool, ["id", "version", "effects"]);
    recordString(tool, "version", 120);
    exactStrings(
      `${name}.surface.tools[${index}].effects`,
      tool.effects,
      3,
      ["external", "read", "write"],
    );
    return recordString(tool, "id", 240);
  });
  if (
    new Set(toolIds).size !== toolIds.length
    || toolIds.some((id, index) => index > 0 && toolIds[index - 1]!.localeCompare(id) >= 0)
  ) reject(`${name}.surface.tools must have unique sorted IDs`);
  let codeModeMaxFunctionCalls: number | undefined;
  if (surface.codeMode !== undefined) {
    const codeMode = asRecord(`${name}.surface.codeMode`, surface.codeMode);
    exactKeys(`${name}.surface.codeMode`, codeMode, [
      "maxFunctionCalls",
      "maxContextValues",
      "maxContextBytes",
      "maxValueBytes",
      "maxObservationBytes",
      "maxRequestBytes",
    ]);
    codeModeMaxFunctionCalls = recordU32(codeMode, "maxFunctionCalls", 128);
    if (codeModeMaxFunctionCalls < 1) reject(`${name}.surface.codeMode.maxFunctionCalls must be positive`);
    if (recordU32(codeMode, "maxContextValues", 512) < 1) {
      reject(`${name}.surface.codeMode.maxContextValues must be positive`);
    }
    if (recordU32(codeMode, "maxContextBytes", 256 * 1_048_576) < 1) {
      reject(`${name}.surface.codeMode.maxContextBytes must be positive`);
    }
    if (recordU32(codeMode, "maxValueBytes", 64 * 1_048_576) < 1) {
      reject(`${name}.surface.codeMode.maxValueBytes must be positive`);
    }
    if (recordU32(codeMode, "maxObservationBytes", 1_048_576) < 1) {
      reject(`${name}.surface.codeMode.maxObservationBytes must be positive`);
    }
    if (recordU32(codeMode, "maxRequestBytes", 8 * 1_048_576) < 1) {
      reject(`${name}.surface.codeMode.maxRequestBytes must be positive`);
    }
  }
  const budgets = asRecord(`${name}.budgets`, grant.budgets);
  exactKeys(`${name}.budgets`, budgets, [
    "maxTokens",
    "maxCostMicros",
    "maxFunctionCalls",
    "timeoutMs",
  ]);
  const policy = parseRosterExecutionPolicy(execution.policyJson);
  const maxTokens = recordU64(budgets, "maxTokens", policy.maxTokens);
  const maxCostMicros = recordU64(budgets, "maxCostMicros", policy.maxCostMicros);
  if (maxCostMicros > task.estimatedCostMicros) {
    reject(`${name}.budgets.maxCostMicros exceeds the admitted task reservation`);
  }
  const maxFunctionCalls = recordU32(budgets, "maxFunctionCalls", 128);
  if (
    maxFunctionCalls < 1
    || (codeModeMaxFunctionCalls !== undefined && maxFunctionCalls > codeModeMaxFunctionCalls)
  ) reject(`${name}.budgets.maxFunctionCalls exceeds its code-mode bound`);
  if (recordU32(budgets, "timeoutMs", 86_400_000) !== task.timeoutMs) {
    reject(`${name}.budgets.timeoutMs does not match the task definition`);
  }
  void maxTokens;
  return JSON.parse(canonicalJson(name, grant, 512_000)) as JsonRecord;
};

/**
 * Reconstruct the only context manifest admissible for an active task lease.
 * Every value comes from reducer-owned rows; contextManifestJson is only a
 * claimant that must match this value byte-for-byte after canonicalization.
 */
const authoritativeRosterTaskContextManifest = (
  ctx: RosterContext,
  execution: ReturnType<typeof requireRosterExecution>,
  room: ReturnType<typeof roomForRun>,
  task: ReturnType<typeof requireRosterTask>,
  fence: bigint,
  claimedManifest: JsonRecord
) => {
  if (room && (
    room.workspaceId !== execution.workspaceId
    || room.activeRunId !== execution.runId
  )) {
    reject(`Roster room ${room.id} does not own execution ${execution.runId}`);
  }
  const inputs = asRecord(
    `Persisted task ${task.taskId} input manifest`,
    JSON.parse(requireJson(
      `Persisted task ${task.taskId} input manifest`,
      task.inputManifestJson,
      256_000
    ))
  );
  const inputVersions = asRecord(
    `Persisted task ${task.taskId} input versions`,
    inputs.inputVersions
  );
  const dataReferences = asArray(
    `Persisted task ${task.taskId} data references`,
    inputs.dataReferences,
    512
  );
  const includedInputIds = new Set<string>(Object.keys(inputVersions));
  const includedArtifactIds = new Set<string>();
  const includedReferenceIds = new Set<string>();
  const excludedUnfinishedInputIds = new Set<string>();
  for (let index = 0; index < dataReferences.length; index += 1) {
    const reference = asRecord(
      `Persisted task ${task.taskId} data reference ${index}`,
      dataReferences[index]
    );
    includedReferenceIds.add(requireRosterId(
      `Persisted task ${task.taskId} data reference id`,
      recordString(reference, "referenceId", 240),
      240
    ));
    if (reference.artifactId !== undefined) {
      includedArtifactIds.add(requireRosterId(
        `Persisted task ${task.taskId} artifact id`,
        recordString(reference, "artifactId", 240),
        240
      ));
    }
  }
  for (const edge of ctx.db.rosterTaskEdge.taskKey.filter(task.id)) {
    if (edge.runId !== execution.runId) reject(`Task context edge ${edge.id} belongs to another execution`);
    const declaredDependency = expectValue(
      ctx.db.rosterTaskDefinition.id.find(edge.prerequisiteTaskKey),
      `Task context dependency ${edge.prerequisiteTaskKey} does not exist`
    );
    if (declaredDependency.runId !== execution.runId) {
      reject(`Task context dependency ${declaredDependency.taskId} belongs to another execution`);
    }
    // A delegated task remains immutable provenance, while its accepted
    // continuation is the effective prerequisite for tasks admitted before
    // the consultation emerged. Mirror the scheduler's effective dependency
    // projection so the reducer and dispatcher construct the same manifest.
    const dependency = effectiveRosterTask(ctx, execution.runId, declaredDependency);
    if (dependency.status !== "accepted") {
      excludedUnfinishedInputIds.add(declaredDependency.taskId);
      continue;
    }
    includedInputIds.add(dependency.taskId);
    const outcome = expectValue(
      ctx.db.rosterTaskOutcome.outcomeId.find(dependency.outcomeId),
      `Accepted task context dependency ${dependency.taskId} has no outcome`
    );
    if (outcome.runId !== execution.runId || outcome.taskKey !== dependency.id) {
      reject(`Task context dependency outcome ${outcome.outcomeId} does not match ${dependency.taskId}`);
    }
    const artifacts = asArray(
      `Task context dependency ${dependency.taskId} artifacts`,
      JSON.parse(requireJson(
        `Task context dependency ${dependency.taskId} artifacts`,
        outcome.artifactsJson,
        256_000
      )),
      512
    );
    for (let index = 0; index < artifacts.length; index += 1) {
      const artifact = asRecord(
        `Task context dependency ${dependency.taskId} artifact ${index}`,
        artifacts[index]
      );
      includedArtifactIds.add(requireRosterId(
        `Task context dependency ${dependency.taskId} artifact id`,
        recordString(artifact, "artifactId", 240),
        240
      ));
    }
    for (const reference of ctx.db.rosterTaskOutputReference.taskKey.filter(dependency.id)) {
      if (reference.runId !== execution.runId || reference.outcomeId !== outcome.outcomeId) {
        reject(`Task context dependency reference ${reference.id} has mismatched authority`);
      }
      includedReferenceIds.add(requireRosterId(
        `Task context dependency ${dependency.taskId} reference id`,
        recordString(
          asRecord(
            `Task context dependency ${dependency.taskId} reference`,
            JSON.parse(requireJson(
              `Task context dependency ${dependency.taskId} reference`,
              reference.referenceJson,
              256_000
            ))
          ),
          "referenceId",
          240
        ),
        240
      ));
    }
  }
  const frontier = ctx.db.rosterContextFrontier.id.find(execution.runId);
  if (frontier && (
    frontier.workspaceId !== execution.workspaceId
    || frontier.runId !== execution.runId
    || (room ? frontier.roomId !== room.id : Boolean(frontier.roomId))
  )) reject("Persisted task context frontier does not match the active run, room, or task");
  // The run frontier owns immutable repository placement. Dynamically admitted
  // children and continuations own their task-scoped frontier, topology, and
  // catalog versions, which are already reducer-validated from the task row
  // and copied into the exact manifest identity below. Requiring those later
  // versions to equal the run's initial snapshot would reject legitimate graph
  // expansion such as a peer consultation against a refreshed catalog.
  const repository = frontier
    ? parseRosterTaskRepositoryPlacement(
        "Persisted task context repository",
        asRecord(
          "Persisted task context frontier",
          JSON.parse(requireJson("Persisted task context frontier", frontier.frontierJson, 256_000))
        ).repository,
        true
      )
    : emptyRosterTaskRepositoryPlacement();
  const executionGrant = validatedRosterTaskExecutionGrant(
    "Task context execution grant",
    claimedManifest.executionGrant,
    execution,
    task,
    fence
  );
  const identity = {
    schemaVersion: "roster.task-context-manifest.v2",
    repository,
    runId: execution.runId,
    taskId: task.taskId,
    nodeId: task.nodeId,
    attempt: task.attempt,
    fence: rosterTaskContextSafeNumber("Task context fence", fence),
    frontierVersion: task.frontierVersion,
    topologyVersion: task.topologyVersion,
    catalogVersion: task.catalogVersion,
    bindingVersion: rosterTaskContextSafeNumber(
      "Task context runtime binding version",
      task.runtimeBindingEpoch
    ),
    executionGrant,
    includedInputIds: sortedRosterTaskContextIds(
      "Task context included input ids",
      includedInputIds
    ),
    includedArtifactIds: sortedRosterTaskContextIds(
      "Task context included artifact ids",
      includedArtifactIds
    ),
    includedReferenceIds: sortedRosterTaskContextIds(
      "Task context included reference ids",
      includedReferenceIds
    ),
    excludedUnfinishedInputIds: sortedRosterTaskContextIds(
      "Task context excluded unfinished input ids",
      excludedUnfinishedInputIds
    ),
  };
  const contextVersion = `context_${rosterHashCanonical(identity).slice(0, 28)}`;
  const manifestId = `context_manifest_${rosterHashCanonical({
    ...identity,
    contextVersion,
  }).slice(0, 28)}`;
  const manifest = { ...identity, contextVersion, manifestId };
  return {
    manifest,
    manifestId,
    contextVersion,
    canonicalManifestJson: canonicalJson("Task context manifest", manifest, 512_000),
  };
};

export const startRosterTask = spacetimedb.reducer(
  { runId: t.string(), taskId: t.string(), fence: t.u64(), contextManifestJson: t.string() },
  (ctx, args) => {
    const task = requireActiveRosterTaskLease(ctx, args.runId, args.taskId, args.fence);
    const latestBindingEpoch = latestRosterRuntimeBindingEpoch(ctx, args.runId, task.nodeId);
    if (latestBindingEpoch > 0n && latestBindingEpoch !== task.runtimeBindingEpoch) {
      reject(`Roster task ${args.taskId} has a stale runtime binding epoch`);
    }
    const execution = requireRosterExecution(ctx, args.runId);
    const room = roomForRun(ctx.db.rosterRoom.activeRunId.filter(args.runId));
    const claimedManifest = asRecord(
      "contextManifestJson",
      JSON.parse(requireJson("contextManifestJson", args.contextManifestJson, 512_000))
    );
    const schemaVersion = recordString(claimedManifest, "schemaVersion", 120);
    if (schemaVersion !== "roster.task-context-manifest.v2") {
      reject(`Unsupported task context manifest schema ${schemaVersion}`);
    }
    const authoritativeManifest = authoritativeRosterTaskContextManifest(
      ctx,
      execution,
      room,
      task,
      args.fence,
      claimedManifest
    );
    if (
      canonicalJson("Claimed task context manifest", claimedManifest, 512_000)
      !== authoritativeManifest.canonicalManifestJson
    ) {
      reject("Task context manifest does not match reducer-authoritative run, task, room, and dependency facts");
    }
    const {
      manifestId,
      contextVersion,
      canonicalManifestJson,
    } = authoritativeManifest;
    const manifestKey = compoundKey(task.id, args.fence.toString());
    const existing = ctx.db.rosterTaskContextManifest.id.find(manifestKey);
    if (existing) {
      if (existing.manifestId !== manifestId || existing.manifestJson !== canonicalManifestJson) {
        reject(`Task context manifest changed for fence ${args.fence.toString()}`);
      }
      if (task.status === "running") return;
    } else {
      ctx.db.rosterTaskContextManifest.insert({
        id: manifestKey,
        workspaceId: execution.workspaceId,
        roomId: room?.id ?? "",
        runId: args.runId,
        taskId: args.taskId,
        nodeId: task.nodeId,
        attempt: task.attempt,
        fence: args.fence,
        manifestId,
        contextVersion,
        frontierVersion: task.frontierVersion,
        topologyVersion: task.topologyVersion,
        catalogVersion: task.catalogVersion,
        bindingVersion: task.runtimeBindingEpoch,
        manifestJson: canonicalManifestJson,
        createdAt: ctx.timestamp,
      });
    }
    ctx.db.rosterTaskDefinition.id.update({ ...task, status: "running", updatedAt: ctx.timestamp });
    appendRosterExecutionEvent(ctx, args.runId, "roster.task.started", task.nodeId, {
      taskId: args.taskId,
      fence: args.fence.toString(),
      manifestId,
      contextVersion,
    });
  }
);

export const acceptRosterTaskOutcome = spacetimedb.reducer(
  {
    runId: t.string(),
    taskId: t.string(),
    fence: t.u64(),
    outcomeJson: t.string(),
    dataReferencesJson: t.string(),
  },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const taskId = requireText("taskId", args.taskId, 160);
    const task = requireRosterTask(ctx, runId, taskId);
    const outcome = parseJsonRecord("outcomeJson", args.outcomeJson, 768_000);
    const schemaVersion = recordString(outcome, "schemaVersion", 80);
    if (schemaVersion !== ROSTER_TASK_OUTCOME_VERSION) {
      reject(`outcomeJson.schemaVersion must be ${ROSTER_TASK_OUTCOME_VERSION}`);
    }
    const outcomeRunId = requireText(
      "outcomeJson.runId",
      recordString(outcome, "runId", 160),
      160
    );
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(outcomeRunId)) {
      reject("outcomeJson.runId contains unsafe characters");
    }
    const outcomeTaskId = requireRosterId(
      "outcomeJson.taskId",
      recordString(outcome, "taskId", 160),
      160
    );
    const outcomeNodeId = requireRosterId(
      "outcomeJson.nodeId",
      recordString(outcome, "nodeId", 160),
      160
    );
    const outcomeAttempt = recordU32(outcome, "attempt", 32);
    const outcomeDefinitionHash = recordString(outcome, "definitionHash", 64);
    if (!/^[0-9a-f]{64}$/.test(outcomeDefinitionHash)) {
      reject("outcomeJson.definitionHash must be a lowercase SHA-256 hex digest");
    }
    const inputVersions = asRecord("outcomeJson.inputVersions", outcome.inputVersions);
    const normalizedInputVersions: Record<string, string> = {};
    for (const [key, value] of Object.entries(inputVersions)) {
      requireRosterId("outcomeJson.inputVersions key", key, 240);
      if (typeof value !== "string") reject(`outcomeJson.inputVersions.${key} must be a string`);
      normalizedInputVersions[key] = requireText(
        `outcomeJson.inputVersions.${key}`,
        value as string,
        256
      );
    }
    const frontierVersion = recordString(outcome, "frontierVersion", 256);
    const topologyVersion = recordString(outcome, "topologyVersion", 256);
    const catalogVersion = recordString(outcome, "catalogVersion", 256);
    const acceptancePolicyId = requireRosterId(
      "outcomeJson.acceptancePolicyId",
      recordString(outcome, "acceptancePolicyId", 160),
      160
    );
    const acceptancePolicyVersion = recordString(outcome, "acceptancePolicyVersion", 160);
    const artifacts = asArray("outcomeJson.artifacts", outcome.artifacts, 512)
      .map((value, index) => {
        const artifact = asRecord(`outcomeJson.artifacts[${index}]`, value);
        requireRosterId(
          `outcomeJson.artifacts[${index}].artifactId`,
          recordString(artifact, "artifactId", 240),
          240
        );
        requireRosterId(
          `outcomeJson.artifacts[${index}].outputKey`,
          recordString(artifact, "outputKey", 240),
          240
        );
        requireRosterId(
          `outcomeJson.artifacts[${index}].kind`,
          recordString(artifact, "kind", 160),
          160
        );
        recordString(artifact, "contentHash", 256);
        recordString(artifact, "mediaType", 160);
        recordU64(artifact, "byteLength", MAX_ROSTER_CONTEXT_BYTES);
        const storage = recordString(artifact, "storage", 32);
        if (!["inline", "artifact", "object"].includes(storage)) {
          reject(`outcomeJson.artifacts[${index}].storage is invalid`);
        }
        if (storage === "object") recordString(artifact, "uri", 2_000);
        if (artifact.presentationText !== undefined) {
          requireText(
            `outcomeJson.artifacts[${index}].presentationText`,
            recordString(artifact, "presentationText", 1_600),
            1_600
          );
        }
        return artifact;
      })
      .sort((left, right) => (
        recordString(left, "outputKey", 240).localeCompare(recordString(right, "outputKey", 240))
        || recordString(left, "artifactId", 240).localeCompare(recordString(right, "artifactId", 240))
      ));
    const artifactIds = new Set<string>();
    for (const artifact of artifacts) {
      const artifactId = recordString(artifact, "artifactId", 240);
      if (artifactIds.has(artifactId)) reject(`outcomeJson repeats artifact ${artifactId}`);
      artifactIds.add(artifactId);
    }
    const outputReferences = asArray(
      "dataReferencesJson",
      JSON.parse(requireJson("dataReferencesJson", args.dataReferencesJson, 768_000)),
      512
    ).map((value, index) => {
      const entry = asRecord(`dataReferencesJson[${index}]`, value);
      const artifactId = requireRosterId(
        `dataReferencesJson[${index}].artifactId`,
        recordString(entry, "artifactId", 240),
        240
      );
      const artifact = expectValue(
        artifacts.find((candidate) =>
          recordString(candidate, "artifactId", 240) === artifactId),
        `dataReferencesJson[${index}] names unknown artifact ${artifactId}`
      );
      const reference = asRecord(`dataReferencesJson[${index}].reference`, entry.reference);
      if (
        recordString(reference, "schemaVersion", 80)
        !== ROSTER_DATA_REFERENCE_VERSION
      ) {
        reject(`dataReferencesJson[${index}].reference.schemaVersion is invalid`);
      }
      requireRosterId(
        `dataReferencesJson[${index}].reference.referenceId`,
        recordString(reference, "referenceId", 160),
        160
      );
      const contentHash = recordString(reference, "contentHash", 256);
      const mediaType = recordString(reference, "mediaType", 160);
      const byteLength = recordU64(
        reference,
        "byteLength",
        MAX_ROSTER_CONTEXT_BYTES
      );
      const storage = recordString(reference, "storage", 32);
      if (!["ephemeral", "artifact", "object"].includes(storage)) {
        reject(`dataReferencesJson[${index}].reference.storage is invalid`);
      }
      if (storage === "artifact") {
        requireRosterId(
          `dataReferencesJson[${index}].reference.artifactId`,
          recordString(reference, "artifactId", 240),
          240
        );
      }
      if (storage === "object") {
        recordString(reference, "uri", 2_000);
      }
      if (
        contentHash !== recordString(artifact, "contentHash", 256)
        || mediaType !== recordString(artifact, "mediaType", 160)
        || byteLength !== recordU64(artifact, "byteLength", MAX_ROSTER_CONTEXT_BYTES)
      ) {
        reject(`dataReferencesJson[${index}] does not match artifact ${artifactId}`);
      }
      return {
        artifactId,
        outputKey: recordString(artifact, "outputKey", 240),
        presentationText: optionalRecordString(entry, "presentationText", 1_600),
        reference,
        referenceJson: canonicalJson(
          `dataReferencesJson[${index}].reference`,
          reference,
          64_000
        ),
      };
    }).sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    if (new Set(outputReferences.map((entry) => entry.artifactId)).size !== outputReferences.length) {
      reject("dataReferencesJson repeats an artifact");
    }
    const usage = outcome.usage === undefined ? undefined : asRecord("outcomeJson.usage", outcome.usage);
    const normalizedOutcomeWithoutId = {
      schemaVersion,
      runId: outcomeRunId,
      taskId: outcomeTaskId,
      nodeId: outcomeNodeId,
      attempt: outcomeAttempt,
      definitionHash: outcomeDefinitionHash,
      inputVersions: Object.fromEntries(
        Object.entries(normalizedInputVersions).sort(([left], [right]) => left.localeCompare(right))
      ),
      frontierVersion,
      topologyVersion,
      catalogVersion,
      acceptancePolicyId,
      acceptancePolicyVersion,
      artifacts,
      ...(usage ? { usage } : {}),
    };
    const expectedOutcomeId = `task_outcome_${rosterHashCanonical(normalizedOutcomeWithoutId).slice(0, 28)}`;
    const outcomeId = recordString(outcome, "outcomeId", 240);
    if (outcomeId !== expectedOutcomeId) reject("outcomeJson.outcomeId does not match its canonical content");
    const canonicalOutcome = canonicalJson(
      "outcomeJson",
      { ...normalizedOutcomeWithoutId, outcomeId },
      768_000
    );
    const existingOutcome = ctx.db.rosterTaskOutcome.outcomeId.find(outcomeId);
    if (existingOutcome) {
      if (
        existingOutcome.taskKey !== task.id
        || existingOutcome.outcomeJson !== canonicalOutcome
        || task.status !== "accepted"
      ) reject(`accepted outcome ${outcomeId} changed after publication`);
      const storedReferences = [...ctx.db.rosterTaskOutputReference.outcomeId.filter(outcomeId)]
        .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
      if (
        storedReferences.length !== outputReferences.length
        || storedReferences.some((stored, index) => (
          stored.artifactId !== outputReferences[index]?.artifactId
          || stored.referenceJson !== outputReferences[index]?.referenceJson
        ))
      ) {
        reject(`accepted outcome ${outcomeId} data references changed after publication`);
      }
      return;
    }
    const leasedTask = requireActiveRosterTaskLease(ctx, runId, taskId, args.fence);
    if (outcomeRunId !== runId) reject("outcome runId does not match");
    if (outcomeTaskId !== taskId) reject("outcome taskId does not match");
    if (outcomeNodeId !== leasedTask.nodeId) reject("outcome nodeId does not match");
    if (outcomeAttempt !== leasedTask.attempt) {
      reject("outcome attempt does not match the active attempt");
    }
    if (outcomeDefinitionHash !== leasedTask.definitionHash) {
      reject("outcome definitionHash does not match");
    }
    const storedDefinition = parseRosterTaskDefinitionValue(
      "stored definition",
      JSON.parse(leasedTask.definitionJson),
      parseRosterExecutionPolicy(requireRosterExecution(ctx, runId).policyJson)
    );
    if (
      canonicalJson("outcomeJson.inputVersions", normalizedInputVersions, 128_000)
      !== storedDefinition.inputVersionsJson
    ) reject("outcome inputVersions do not match the executable definition");
    if (frontierVersion !== leasedTask.frontierVersion) {
      reject("outcome frontierVersion does not match");
    }
    if (topologyVersion !== leasedTask.topologyVersion) {
      reject("outcome topologyVersion does not match");
    }
    if (catalogVersion !== leasedTask.catalogVersion) {
      reject("outcome catalogVersion does not match");
    }
    if (
      acceptancePolicyId !== leasedTask.acceptancePolicyId
      || acceptancePolicyVersion !== leasedTask.acceptancePolicyVersion
    ) reject("outcome acceptance policy does not match");
    const result = asRecord("stored definition result", JSON.parse(leasedTask.resultJson));
    const resultMode = recordString(result, "mode", 32);
    if (resultMode === "none" && artifacts.length !== 0) {
      reject(`Roster task ${taskId} must not publish an artifact`);
    }
    if (resultMode !== "none") {
      const outputKey = recordString(result, "outputKey", 240);
      const matching = artifacts.filter((artifact) => (
        recordString(artifact, "outputKey", 240) === outputKey
      ));
      if (matching.length !== 1) {
        reject(`Roster task ${taskId} must publish exactly one ${outputKey} artifact`);
      }
    }
    const acceptedBytes = artifacts.reduce(
      (total, artifact) => total + recordU64(artifact, "byteLength", MAX_ROSTER_CONTEXT_BYTES),
      0n
    );
    const policy = parseRosterExecutionPolicy(requireRosterExecution(ctx, runId).policyJson);
    if (acceptedBytes > policy.maxContextBytes) {
      reject(`Roster task ${taskId} accepted artifacts exceed maxContextBytes`);
    }
    const usageRecord = usage ?? {};
    const {
      actualCostMicros,
      totalTokens,
      cachedInputTokens,
      budgetTokens,
    } = rosterUsageTotals(
      "outcomeJson.usage",
      usageRecord
    );
    settleTaskModelReservation(
      ctx,
      leasedTask,
      args.fence,
      actualCostMicros,
      totalTokens,
      "settled"
    );
    ctx.db.rosterTaskOutcome.insert({
      outcomeId,
      runId,
      taskKey: leasedTask.id,
      definitionHash: leasedTask.definitionHash,
      outcomeJson: canonicalOutcome,
      artifactsJson: canonicalJson("outcomeJson.artifacts", artifacts, 512_000),
      usageJson: canonicalJson("outcomeJson.usage", usageRecord, 64_000),
      actualCostMicros,
      totalTokens,
      createdAt: ctx.timestamp,
    });
    for (const entry of outputReferences) {
      ctx.db.rosterTaskOutputReference.insert({
        id: compoundKey(outcomeId, entry.artifactId),
        runId,
        taskKey: leasedTask.id,
        taskId,
        outcomeId,
        artifactId: entry.artifactId,
        outputKey: entry.outputKey,
        referenceJson: entry.referenceJson,
        createdAt: ctx.timestamp,
      });
    }
    ctx.db.rosterTaskDefinition.id.update({
      ...leasedTask,
      status: "accepted",
      outcomeId,
      leaseOwner: undefined,
      leaseUntil: undefined,
      lastError: "",
      updatedAt: ctx.timestamp,
    });
    const execution = requireRosterExecution(ctx, runId);
    const spentCostMicros = execution.spentCostMicros + actualCostMicros;
    const usedTokens = execution.usedTokens + budgetTokens;
    const budgetExceeded = spentCostMicros > policy.maxCostMicros || usedTokens > policy.maxTokens;
    ctx.db.rosterExecution.runId.update({
      ...execution,
      reservedCostMicros: execution.reservedCostMicros >= leasedTask.estimatedCostMicros
        ? execution.reservedCostMicros - leasedTask.estimatedCostMicros
        : 0n,
      spentCostMicros,
      usedTokens,
      status: budgetExceeded ? "budget_exhausted" : execution.status,
      terminalReason: budgetExceeded ? "accepted usage exceeded execution policy" : execution.terminalReason,
      updatedAt: ctx.timestamp,
    });
    if (budgetExceeded) {
      for (const candidate of ctx.db.rosterTaskDefinition.runId.filter(runId)) {
        if (TERMINAL_ROSTER_TASK_STATUSES.has(candidate.status)) continue;
        ctx.db.rosterTaskDefinition.id.update({
          ...candidate,
          status: "canceled",
          leaseOwner: undefined,
          leaseUntil: undefined,
          lastError: "execution budget exhausted",
          updatedAt: ctx.timestamp,
        });
      }
    } else {
      propagateRosterTerminalDisposition(ctx, runId, leasedTask.id);
      promoteEligibleBlockedRosterTasks(ctx, runId);
    }
    refreshRosterExecution(ctx, runId);
    appendRosterExecutionEvent(ctx, runId, "roster.task.outcome.accepted", leasedTask.nodeId, {
      taskId,
      outcomeId,
      definitionHash: leasedTask.definitionHash,
      actualCostMicros: actualCostMicros.toString(),
      totalTokens: totalTokens.toString(),
      cachedInputTokens: cachedInputTokens.toString(),
      budgetTokens: budgetTokens.toString(),
      budgetExceeded,
    });
    for (const artifact of artifacts) {
      const presentationText = optionalRecordString(artifact, "presentationText", 1_600)
        || outputReferences.find((reference) => (
          reference.artifactId === recordString(artifact, "artifactId", 240)
        ))?.presentationText;
      appendAcceptedPeerConversation(ctx, runId, leasedTask, {
        ...artifact,
        ...(presentationText ? { presentationText } : {}),
      });
    }
    appendRoomTimelineEntry(ctx, runId, "artifact", taskId, leasedTask.nodeId, {
      type: "artifact",
      taskId,
      outcomeId,
      artifactIds: artifacts.map((artifact) => recordString(artifact, "artifactId", 240)),
      outputKeys: [...new Set(
        artifacts.map((artifact) => recordString(artifact, "outputKey", 240))
      )].sort(),
      definitionHash: leasedTask.definitionHash,
    });
    if (/review|critic|certif/i.test(leasedTask.capability)) {
      appendRoomTimelineEntry(ctx, runId, "review", taskId, leasedTask.nodeId, {
        type: "review",
        taskId,
        outcomeId,
        artifactIds: artifacts.map((artifact) => recordString(artifact, "artifactId", 240)),
      });
    }
    if (/decision|coordinat|plan|select/i.test(leasedTask.capability)) {
      appendRoomTimelineEntry(ctx, runId, "decision", taskId, leasedTask.nodeId, {
        type: "decision",
        taskId,
        outcomeId,
        decisionArtifactIds: artifacts.map((artifact) => recordString(artifact, "artifactId", 240)),
      });
    }
    appendProjectionOutbox(ctx, runId, "task-outcome", `task-outcome:${outcomeId}`, {
      taskId,
      outcomeId,
      nodeId: leasedTask.nodeId,
    });
  }
);

export const failRosterTask = spacetimedb.reducer(
  {
    runId: t.string(),
    taskId: t.string(),
    fence: t.u64(),
    error: t.string(),
    retryable: t.bool(),
  },
  (ctx, args) => {
    const task = requireActiveRosterTaskLease(ctx, args.runId, args.taskId, args.fence);
    const reservationId = compoundKey(task.id, args.fence.toString());
    const reservation = ctx.db.rosterModelReservation.id.find(reservationId);
    const providerOutcomeUncertain = reservation?.status === "dispatched";
    const willRetry = !providerOutcomeUncertain && args.retryable
      && task.sideEffect !== "non-repeatable"
      && task.attempt < task.maxAttempts;
    const error = requireText("error", args.error, 2_000);
    let availableAt = ctx.timestamp;
    if (willRetry) {
      const exponent = Math.min(Math.max(task.attempt - 1, 0), 16);
      const delayMs = Math.min(
        task.retryMaximumBackoffMs,
        task.retryInitialBackoffMs * (2 ** exponent)
      );
      const availableAtMicros = ctx.timestamp.microsSinceUnixEpoch + BigInt(delayMs) * 1_000n;
      availableAt = new Timestamp(availableAtMicros);
      ctx.db.rosterTaskRetryWake.insert({
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(availableAtMicros),
        taskKey: task.id,
        availableAtMicros,
      });
    }
    ctx.db.rosterTaskDefinition.id.update({
      ...task,
      status: willRetry ? "retry_wait" : "failed",
      availableAt,
      leaseOwner: undefined,
      leaseUntil: undefined,
      lastError: error,
      updatedAt: ctx.timestamp,
    });
    const execution = requireRosterExecution(ctx, args.runId);
    if (reservation) {
      ctx.db.rosterModelReservation.id.update({
        ...reservation,
        status: providerOutcomeUncertain ? "uncertain" : "canceled",
        updatedAt: ctx.timestamp,
      });
    }
    ctx.db.rosterExecution.runId.update({
      ...execution,
      reservedCostMicros: providerOutcomeUncertain
        ? execution.reservedCostMicros
        : execution.reservedCostMicros >= task.estimatedCostMicros
          ? execution.reservedCostMicros - task.estimatedCostMicros
          : 0n,
      updatedAt: ctx.timestamp,
    });
    if (!willRetry) propagateRosterTerminalDisposition(ctx, args.runId, task.id);
    promoteEligibleBlockedRosterTasks(ctx, args.runId);
    refreshRosterExecution(ctx, args.runId);
    appendRosterExecutionEvent(
      ctx,
      args.runId,
      willRetry ? "roster.task.retry.scheduled" : "roster.task.failed",
      task.nodeId,
      {
        taskId: args.taskId,
        fence: args.fence.toString(),
        error,
        retryable: willRetry,
        modelReservationStatus: providerOutcomeUncertain ? "uncertain" : "canceled",
      }
    );
    if (providerOutcomeUncertain) {
      appendRoomTimelineEntry(ctx, args.runId, "attention", args.taskId, task.nodeId, {
        type: "attention",
        taskId: args.taskId,
        reason: "Provider call outcome is uncertain; retry is fenced pending reconciliation",
        reservationId,
      });
    }
  }
);

export const expireRosterTaskLease = spacetimedb.reducer(
  { timer: rosterTaskLeaseExpiry.rowType },
  (ctx, { timer }) => {
    const task = ctx.db.rosterTaskDefinition.id.find(timer.taskKey);
    if (!task || !ACTIVE_ROSTER_TASK_STATUSES.has(task.status)) return;
    if (task.leaseFence !== timer.fence) return;
    if (task.leaseUntil && task.leaseUntil.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch) return;
    const reservationId = compoundKey(task.id, task.leaseFence.toString());
    const reservation = ctx.db.rosterModelReservation.id.find(reservationId);
    const providerOutcomeUncertain = reservation?.status === "dispatched";
    const willRetry = !providerOutcomeUncertain
      && task.sideEffect !== "non-repeatable"
      && task.attempt < task.maxAttempts;
    let availableAt = ctx.timestamp;
    if (willRetry) {
      const exponent = Math.min(Math.max(task.attempt - 1, 0), 16);
      const delayMs = Math.min(
        task.retryMaximumBackoffMs,
        task.retryInitialBackoffMs * (2 ** exponent)
      );
      const availableAtMicros = ctx.timestamp.microsSinceUnixEpoch + BigInt(delayMs) * 1_000n;
      availableAt = new Timestamp(availableAtMicros);
      ctx.db.rosterTaskRetryWake.insert({
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(availableAtMicros),
        taskKey: task.id,
        availableAtMicros,
      });
    }
    ctx.db.rosterTaskDefinition.id.update({
      ...task,
      status: willRetry ? "retry_wait" : "failed",
      availableAt,
      leaseOwner: undefined,
      leaseUntil: undefined,
      lastError: "worker lease expired",
      updatedAt: ctx.timestamp,
    });
    const execution = requireRosterExecution(ctx, task.runId);
    if (reservation) {
      ctx.db.rosterModelReservation.id.update({
        ...reservation,
        status: providerOutcomeUncertain ? "uncertain" : "canceled",
        updatedAt: ctx.timestamp,
      });
    }
    ctx.db.rosterExecution.runId.update({
      ...execution,
      reservedCostMicros: providerOutcomeUncertain
        ? execution.reservedCostMicros
        : execution.reservedCostMicros >= task.estimatedCostMicros
          ? execution.reservedCostMicros - task.estimatedCostMicros
          : 0n,
      updatedAt: ctx.timestamp,
    });
    if (!willRetry) propagateRosterTerminalDisposition(ctx, task.runId, task.id);
    promoteEligibleBlockedRosterTasks(ctx, task.runId);
    refreshRosterExecution(ctx, task.runId);
    appendRosterExecutionEvent(
      ctx,
      task.runId,
      willRetry ? "roster.task.retry.scheduled" : "roster.task.failed",
      task.nodeId,
      {
        taskId: task.taskId,
        fence: task.leaseFence.toString(),
        reason: "lease expired",
        modelReservationStatus: providerOutcomeUncertain ? "uncertain" : "canceled",
      }
    );
    if (providerOutcomeUncertain) {
      appendRoomTimelineEntry(ctx, task.runId, "attention", task.taskId, task.nodeId, {
        type: "attention",
        taskId: task.taskId,
        reason: "Worker lease expired after provider dispatch; retry is fenced pending reconciliation",
        reservationId,
      });
    }
  }
);

/** Wake a bounded retry by moving it back into the ready frontier. */
export const wakeRosterTaskRetry = spacetimedb.reducer(
  { timer: rosterTaskRetryWake.rowType },
  (ctx, { timer }) => {
    const task = ctx.db.rosterTaskDefinition.id.find(timer.taskKey);
    if (!task || task.status !== "retry_wait") return;
    if (task.availableAt.microsSinceUnixEpoch !== timer.availableAtMicros) return;
    if (timer.availableAtMicros > ctx.timestamp.microsSinceUnixEpoch) return;
    const execution = requireRosterExecution(ctx, task.runId);
    if (TERMINAL_ROSTER_EXECUTION_STATUSES.has(execution.status)) return;
    const policy = parseRosterExecutionPolicy(execution.policyJson);
    let readyCount = 0;
    for (const candidate of ctx.db.rosterTaskDefinition.runId.filter(task.runId)) {
      if (candidate.status === "ready") readyCount += 1;
    }
    ctx.db.rosterTaskDefinition.id.update({
      ...task,
      status: readyCount < policy.maxReady ? "ready" : "blocked",
      updatedAt: ctx.timestamp,
    });
    refreshRosterExecution(ctx, task.runId);
  }
);

const deferPendingRosterRoomControlIntents = (ctx: RosterContext, runId: string): number => {
  const execution = requireRosterExecution(ctx, runId);
  let deferred = 0;
  for (const intent of ctx.db.rosterRoomControlIntent.workspaceId.filter(execution.workspaceId)) {
    if (intent.status !== "pending" || intent.targetRunId !== runId) continue;
    ctx.db.rosterRoomControlIntent.id.update({
      ...intent,
      targetRunId: "",
    });
    deferred += 1;
  }
  return deferred;
};

/**
 * Domain coordinators finalize only after their accepted frontier is complete.
 * The reducer first repairs any terminal continuation chain, then rejects a
 * premature or contradictory terminal disposition.
 */
export const finalizeRosterExecution = spacetimedb.reducer(
  { runId: t.string(), outcome: t.string(), reason: t.string() },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const outcome = requireText("outcome", args.outcome, 24);
    if (outcome !== "completed" && outcome !== "failed") {
      reject("Roster execution outcome must be completed or failed");
    }
    let execution = requireRosterExecution(ctx, runId);
    requireRosterCoordinator(ctx, execution);
    if (execution.status === outcome) return;
    const repairedFrom = execution.status === "canceled"
      && execution.terminalReason === "execution wall-time limit exceeded"
      ? execution.status
      : "";
    if (TERMINAL_ROSTER_EXECUTION_STATUSES.has(execution.status) && !repairedFrom) {
      reject(`Roster execution ${runId} is already ${execution.status}`);
    }
    const settledDelegations = settleCompletedRosterDelegations(ctx, runId);
    refreshRosterExecution(ctx, runId);
    execution = requireRosterExecution(ctx, runId);
    const tasks = [...ctx.db.rosterTaskDefinition.runId.filter(runId)];
    if (tasks.length === 0) reject(`Roster execution ${runId} has no tasks`);
    const unfinished = tasks.find((task) => !TERMINAL_ROSTER_TASK_STATUSES.has(task.status));
    if (unfinished) reject(`Roster execution ${runId} still has unfinished task ${unfinished.taskId}`);
    const failed = tasks.filter((task) => task.status === "failed" || task.status === "canceled");
    if (outcome === "completed" && failed.length > 0) {
      reject(`Roster execution ${runId} has failed or canceled tasks`);
    }
    const requestedReason = args.reason.trim().slice(0, 2_000);
    if (outcome === "failed" && !requestedReason && failed.length === 0) {
      reject(`Roster execution ${runId} failure requires a reason`);
    }
    const reason = requestedReason
      || (outcome === "failed" ? "one or more Roster tasks failed" : "");
    const deferredControlIntents = deferPendingRosterRoomControlIntents(ctx, runId);
    ctx.db.rosterExecution.runId.update({
      ...execution,
      status: outcome,
      terminalReason: reason,
      updatedAt: ctx.timestamp,
    });
    refreshRosterExecution(ctx, runId);
    appendRosterExecutionEvent(ctx, runId, `roster.execution.${outcome}`, "", {
      reason,
      settledDelegations,
      deferredControlIntents,
      ...(repairedFrom ? { repairedFrom } : {}),
    });
  }
);

export const cancelRosterExecution = spacetimedb.reducer(
  { runId: t.string(), reason: t.string() },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const execution = requireRosterExecution(ctx, runId);
    requireRosterCoordinator(ctx, execution);
    const reason = requireText("reason", args.reason, 2_000);
    if (execution.status === "canceled") return;
    if (TERMINAL_ROSTER_EXECUTION_STATUSES.has(execution.status)) {
      reject(`Roster execution ${runId} is already terminal`);
    }
    for (const task of ctx.db.rosterTaskDefinition.runId.filter(runId)) {
      if (TERMINAL_ROSTER_TASK_STATUSES.has(task.status)) continue;
      ctx.db.rosterTaskDefinition.id.update({
        ...task,
        status: "canceled",
        leaseOwner: undefined,
        leaseUntil: undefined,
        lastError: reason,
        updatedAt: ctx.timestamp,
      });
    }
    ctx.db.rosterExecution.runId.update({
      ...execution,
      status: "canceled",
      reservedCostMicros: 0n,
      terminalReason: reason,
      updatedAt: ctx.timestamp,
    });
    refreshRosterExecution(ctx, runId);
    appendRosterExecutionEvent(ctx, runId, "roster.execution.canceled", "", { reason });
  }
);

/** Cancel one logical task without broadening the operation to the whole run. */
export const cancelRosterTask = spacetimedb.reducer(
  {
    runId: t.string(),
    taskId: t.string(),
    fence: t.u64(),
    reason: t.string(),
  },
  (ctx, args) => {
    const runId = requireText("runId", args.runId, 160);
    const taskId = requireText("taskId", args.taskId, 160);
    const execution = requireActiveRosterExecution(ctx, runId);
    const reason = requireText("reason", args.reason, 2_000);
    let task = requireRosterTask(ctx, runId, taskId);
    if (TERMINAL_ROSTER_TASK_STATUSES.has(task.status)) return;
    if (args.fence === 0n) {
      requireRosterCoordinator(ctx, execution);
      if (ACTIVE_ROSTER_TASK_STATUSES.has(task.status)) {
        reject(`Roster task ${taskId} requires its active lease fence`);
      }
    } else {
      task = requireActiveRosterTaskLease(ctx, runId, taskId, args.fence);
    }
    ctx.db.rosterTaskDefinition.id.update({
      ...task,
      status: "canceled",
      leaseOwner: undefined,
      leaseUntil: undefined,
      lastError: reason,
      updatedAt: ctx.timestamp,
    });
    if (ACTIVE_ROSTER_TASK_STATUSES.has(task.status)) {
      const current = requireRosterExecution(ctx, runId);
      ctx.db.rosterExecution.runId.update({
        ...current,
        reservedCostMicros: current.reservedCostMicros >= task.estimatedCostMicros
          ? current.reservedCostMicros - task.estimatedCostMicros
          : 0n,
        updatedAt: ctx.timestamp,
      });
    }
    propagateRosterTerminalDisposition(ctx, runId, task.id);
    promoteEligibleBlockedRosterTasks(ctx, runId);
    refreshRosterExecution(ctx, runId);
    appendRosterExecutionEvent(ctx, runId, "roster.task.canceled", task.nodeId, {
      taskId,
      fence: args.fence.toString(),
      reason,
    });
  }
);

export const expireRosterExecutionDeadline = spacetimedb.reducer(
  { timer: rosterExecutionDeadline.rowType },
  (ctx, { timer }) => {
    const execution = ctx.db.rosterExecution.runId.find(timer.runId);
    if (!execution || TERMINAL_ROSTER_EXECUTION_STATUSES.has(execution.status)) return;
    if (execution.deadlineAt.microsSinceUnixEpoch !== timer.deadlineMicros) return;
    if (timer.deadlineMicros > ctx.timestamp.microsSinceUnixEpoch) return;
    for (const task of ctx.db.rosterTaskDefinition.runId.filter(timer.runId)) {
      if (TERMINAL_ROSTER_TASK_STATUSES.has(task.status)) continue;
      ctx.db.rosterTaskDefinition.id.update({
        ...task,
        status: "canceled",
        leaseOwner: undefined,
        leaseUntil: undefined,
        lastError: "execution wall-time limit exceeded",
        updatedAt: ctx.timestamp,
      });
    }
    ctx.db.rosterExecution.runId.update({
      ...execution,
      status: "canceled",
      reservedCostMicros: 0n,
      terminalReason: "execution wall-time limit exceeded",
      updatedAt: ctx.timestamp,
    });
    refreshRosterExecution(ctx, timer.runId);
    appendRosterExecutionEvent(ctx, timer.runId, "roster.execution.deadline.exceeded", "", {
      deadlineMicros: timer.deadlineMicros.toString(),
    });
    const canvas = ctx.db.canvasRun.id.find(timer.runId);
    if (canvas && !TERMINAL_RUN_STATUSES.has(canvas.status)) {
      ctx.db.canvasRun.id.update({ ...canvas, status: "canceled", updatedAt: ctx.timestamp });
    }
  }
);

export const cancelCanvasRun = spacetimedb.reducer(
  { runId: t.string(), reason: t.string() },
  (ctx, args) => {
    const run = requireRun(ctx, args.runId);
    requireMembership(ctx, args.runId, ["owner", "coordinator"]);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    ctx.db.canvasRun.id.update({ ...run, status: "canceled", updatedAt: ctx.timestamp });
    const execution = ctx.db.rosterExecution.runId.find(args.runId);
    if (execution) {
      for (const task of ctx.db.rosterTaskDefinition.runId.filter(args.runId)) {
        if (TERMINAL_ROSTER_TASK_STATUSES.has(task.status)) continue;
        ctx.db.rosterTaskDefinition.id.update({
          ...task,
          status: "canceled",
          leaseOwner: undefined,
          leaseUntil: undefined,
          lastError: args.reason.slice(0, 2_000),
          updatedAt: ctx.timestamp,
        });
      }
      ctx.db.rosterExecution.runId.update({
        ...execution,
        status: "canceled",
        reservedCostMicros: 0n,
        terminalReason: args.reason.slice(0, 2_000),
        updatedAt: ctx.timestamp,
      });
      refreshRosterExecution(ctx, args.runId);
      appendRosterExecutionEvent(ctx, args.runId, "roster.execution.canceled", "", {
        reason: args.reason.slice(0, 2_000),
      });
    }
    appendReceipt(ctx, {
      runId: args.runId,
      eventId: "run.canceled",
      kind: "run.canceled",
      agentId: "coordinator",
      payloadJson: JSON.stringify({ reason: args.reason.slice(0, 500) }),
    });
  }
);

export const finalizeCanvasRun = spacetimedb.reducer(
  {
    runId: t.string(),
    outcome: t.string(),
    sceneHash: t.string(),
    objectCount: t.u32(),
  },
  (ctx, args) => {
    const run = requireRun(ctx, args.runId);
    requireMembership(ctx, args.runId, ["owner", "coordinator"]);
    if (args.outcome !== "completed" && args.outcome !== "completed_with_notes") {
      reject("outcome must be completed or completed_with_notes");
    }
    settleCompletedRosterDelegations(ctx, args.runId);
    for (const task of ctx.db.rosterTaskDefinition.runId.filter(args.runId)) {
      if (!TERMINAL_ROSTER_TASK_STATUSES.has(task.status)) {
        reject(`run ${args.runId} still has unfinished tasks`);
      }
      if (task.status === "failed" && args.outcome === "completed") {
        reject(`run ${args.runId} has failed tasks and requires completed_with_notes`);
      }
    }
    ctx.db.canvasRun.id.update({
      ...run,
      status: args.outcome,
      sceneHash: requireText("sceneHash", args.sceneHash, 256),
      objectCount: args.objectCount,
      updatedAt: ctx.timestamp,
    });
    const execution = requireRosterExecution(ctx, args.runId);
    ctx.db.rosterExecution.runId.update({
      ...execution,
      status: "completed",
      terminalReason: args.outcome === "completed_with_notes" ? "completed with Canvas notes" : "",
      updatedAt: ctx.timestamp,
    });
    appendReceipt(ctx, {
      runId: args.runId,
      eventId: `run.finalized:${args.sceneHash}`,
      kind: "run.finalized",
      agentId: "coordinator",
      payloadJson: JSON.stringify({ outcome: args.outcome, objectCount: args.objectCount }),
      hash: args.sceneHash,
    });
  }
);

// Public views must return explicit product types rather than private table
// row types. Reusing a private table's rowType gives the view the correct
// runtime shape, but the generated client type for the named view is empty.
// These projections also form an intentional boundary: adding a private
// column does not expose it until it is added here deliberately.
const workspaceProjection = t.row("WorkspaceProjection", {
  id: t.string().primaryKey(),
  name: t.string(),
  role: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const workspaceUsageProjection = t.row("WorkspaceUsageProjection", {
  workspaceId: t.string().primaryKey(),
  jobsInWindow: t.u32(),
  activeJobs: t.u32(),
  totalJobs: t.u64(),
  maxJobsInWindow: t.u32(),
  maxActiveJobs: t.u32(),
  windowStartedAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const eventStreamProjection = t.row("EventStreamProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  streamId: t.string(),
  kind: t.string(),
  headHash: t.string(),
  receiptCount: t.u64(),
  parentStreamId: t.string(),
  forkAt: t.u32(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const streamReceiptProjection = t.row("StreamReceiptProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  streamId: t.string(),
  seq: t.u64(),
  receiptId: t.string(),
  occurredAtMs: t.u64(),
  prevHash: t.string(),
  hash: t.string(),
  bodyJson: t.string(),
  hintsJson: t.string(),
  createdAt: t.timestamp(),
});

const codingRoomProjection = t.row("CodingRoomProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  codingWorkspaceId: t.string(),
  roomId: t.string(),
  conversationId: t.string(),
  streamId: t.string(),
  title: t.string(),
  state: t.string(),
  firstMessageId: t.string(),
  messageCount: t.u32(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

/** A selected timeline row keeps durable entry identity separate from routing. */
const codingSelectedRoomTimelineProjection = t.row("CodingSelectedRoomTimelineProjection", {
  selectionRowId: t.string().primaryKey(),
  selectionId: t.string(),
  id: t.string(),
  workspaceId: t.string(),
  roomId: t.string(),
  runId: t.string(),
  seq: t.u64(),
  kind: t.string(),
  taskId: t.string(),
  nodeId: t.string(),
  entryJson: t.string(),
  createdAt: t.timestamp(),
});

const streamBranchProjection = t.row("StreamBranchProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  streamId: t.string(),
  parentStreamId: t.string(),
  forkAt: t.u32(),
  createdAtMs: t.u64(),
});

const rosterJobProjection = t.row("RosterJobProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  agentId: t.string(),
  lane: t.string(),
  sessionKey: t.string(),
  singletonMode: t.string(),
  payloadJson: t.string(),
  status: t.string(),
  attempt: t.u32(),
  maxAttempts: t.u32(),
  leaseOwner: t.option(t.identity()),
  leaseWorker: t.string(),
  leaseFence: t.u64(),
  leaseUntil: t.option(t.timestamp()),
  claimToken: t.string(),
  availableAt: t.timestamp(),
  lastError: t.string(),
  resultJson: t.string(),
  canceledReason: t.string(),
  abortRequested: t.bool(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const rosterJobCommandProjection = t.row("RosterJobCommandProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  jobId: t.string(),
  command: t.string(),
  lane: t.string(),
  payloadJson: t.string(),
  by: t.string(),
  createdAt: t.timestamp(),
  consumedAt: t.option(t.timestamp()),
  consumedBy: t.string(),
});

const rosterJobEventProjection = t.row("RosterJobEventProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  jobId: t.string(),
  seq: t.u64(),
  kind: t.string(),
  eventJson: t.string(),
  createdAt: t.timestamp(),
});

const rosterJobRequestProjection = t.row("RosterJobRequestProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  requestId: t.string(),
  requestedJobId: t.string(),
  resolvedJobId: t.string(),
  createdAt: t.timestamp(),
});

const canvasRunProjection = t.row("CanvasRunProjection", {
  id: t.string().primaryKey(),
  owner: t.identity(),
  prompt: t.string(),
  status: t.string(),
  desiredAgents: t.u32(),
  maxInflight: t.u32(),
  nextReceiptSeq: t.u64(),
  headReceiptHash: t.string(),
  budgetMicros: t.u64(),
  reservedMicros: t.u64(),
  spentMicros: t.u64(),
  sceneHash: t.string(),
  objectCount: t.u32(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const canvasFleetRunProjection = t.row("CanvasFleetRunProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  prompt: t.string(),
  status: t.string(),
  desiredAgents: t.u32(),
  maxInflight: t.u32(),
  objectCount: t.u32(),
  activeAgents: t.u32(),
  totalAgents: t.u32(),
  totalTasks: t.u32(),
  completedTasks: t.u32(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const runMemberProjection = t.row("RunMemberProjection", {
  id: t.string().primaryKey(),
  runId: t.string(),
  member: t.identity(),
  role: t.string(),
  createdAt: t.timestamp(),
});

const rosterTaskProjection = t.row("RosterTaskProjection", {
  id: t.string().primaryKey(),
  runId: t.string(),
  taskId: t.string(),
  semanticKey: t.string(),
  definitionHash: t.string(),
  definitionJson: t.string(),
  nodeId: t.string(),
  capability: t.string(),
  objective: t.string(),
  status: t.string(),
  parentTaskId: t.string(),
  depth: t.u32(),
  attempt: t.u32(),
  maxAttempts: t.u32(),
  leaseOwner: t.option(t.identity()),
  leaseFence: t.u64(),
  leaseUntil: t.option(t.timestamp()),
  availableAt: t.timestamp(),
  lastError: t.string(),
  outcomeId: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

/** Public Coding workbench task state; task definitions and execution errors stay private. */
const codingRunTaskProjection = t.row("CodingRunTaskProjection", {
  id: t.string().primaryKey(),
  runId: t.string(),
  taskId: t.string(),
  nodeId: t.string(),
  capability: t.string(),
  status: t.string(),
  attempt: t.u32(),
  failureCategory: t.string(),
  failureReason: t.string(),
  updatedAt: t.timestamp(),
});

type CodingPublicTaskState = {
  readonly nodeId: string;
  readonly capability: string;
  readonly status: string;
  readonly lastError: string;
};

const isCodingUserVisibleTask = (
  task: Pick<CodingPublicTaskState, "nodeId" | "capability">,
): boolean => task.nodeId !== "coordinator"
  && task.capability !== "coordinate"
  && task.capability !== "room";

const CODING_PUBLIC_FAILURE_REASONS = {
  "budget-exhausted": "The run reached its execution budget before this step returned an accepted result.",
  "runtime-unavailable": "The assigned runtime was unavailable before this step returned an accepted result.",
  "task-failed": "Roster did not receive an accepted result for this step.",
  "validation-failed": "Validation did not pass for this step.",
  "worker-timeout": "The assigned runtime stopped responding before it returned an accepted result.",
} as const;

type CodingPublicFailureCategory = keyof typeof CODING_PUBLIC_FAILURE_REASONS;

const codingPublicTaskFailure = (
  task: CodingPublicTaskState,
): { readonly category: CodingPublicFailureCategory | ""; readonly reason: string } => {
  if (task.status !== "failed" && task.status !== "canceled") return { category: "", reason: "" };
  const error = task.lastError.toLocaleLowerCase();
  const category: CodingPublicFailureCategory =
    /worker lease expired|lease expired|timed out|timeout|wall-time/u.test(error)
      ? "worker-timeout"
      : /budget|usage limit|execution policy/u.test(error)
        ? "budget-exhausted"
        : /validation|test failed|verify failed/u.test(error)
          ? "validation-failed"
          : /runtime|provider|model|authentication|authorization/u.test(error)
            ? "runtime-unavailable"
            : "task-failed";
  return { category, reason: CODING_PUBLIC_FAILURE_REASONS[category] };
};

const codingUserVisibleExecutionCounts = (
  tasks: Iterable<CodingPublicTaskState>,
): {
  readonly totalTasks: number;
  readonly readyTasks: number;
  readonly blockedTasks: number;
  readonly inflightTasks: number;
  readonly acceptedTasks: number;
  readonly failedTasks: number;
  readonly canceledTasks: number;
  readonly skippedTasks: number;
} => {
  let totalTasks = 0;
  let readyTasks = 0;
  let blockedTasks = 0;
  let inflightTasks = 0;
  let acceptedTasks = 0;
  let failedTasks = 0;
  let canceledTasks = 0;
  let skippedTasks = 0;
  for (const task of tasks) {
    if (!isCodingUserVisibleTask(task)) continue;
    totalTasks += 1;
    if (task.status === "ready") readyTasks += 1;
    else if (task.status === "blocked" || task.status === "retry_wait") blockedTasks += 1;
    else if (ACTIVE_ROSTER_TASK_STATUSES.has(task.status)) inflightTasks += 1;
    else if (task.status === "accepted") acceptedTasks += 1;
    else if (task.status === "failed") failedTasks += 1;
    else if (task.status === "canceled") canceledTasks += 1;
    else if (task.status === "skipped") skippedTasks += 1;
  }
  return {
    totalTasks,
    readyTasks,
    blockedTasks,
    inflightTasks,
    acceptedTasks,
    failedTasks,
    canceledTasks,
    skippedTasks,
  };
};

const workerCapabilityProjection = t.row("WorkerCapabilityProjection", {
  id: t.string().primaryKey(),
  runId: t.string(),
  capability: t.string(),
  createdAt: t.timestamp(),
});

const receiptProjection = t.row("ReceiptProjection", {
  id: t.string().primaryKey(),
  runId: t.string(),
  seq: t.u64(),
  eventId: t.string(),
  kind: t.string(),
  actor: t.identity(),
  agentId: t.string(),
  payloadJson: t.string(),
  prevHash: t.string(),
  hash: t.string(),
  createdAt: t.timestamp(),
});

const scenePatchProjection = t.row("ScenePatchProjection", {
  patchId: t.string().primaryKey(),
  runId: t.string(),
  partId: t.string(),
  planVersion: t.string(),
  agentId: t.string(),
  taskKey: t.string(),
  taskId: t.string(),
  supersedesPatchId: t.string(),
  contentRef: t.string(),
  contentHash: t.string(),
  updateHash: t.string(),
  baseSceneHash: t.string(),
  patchJson: t.string(),
  objectCount: t.u32(),
  active: t.bool(),
  createdAt: t.timestamp(),
});

const canvasRunUiProjection = t.row("CanvasRunUiProjection", {
  id: t.string().primaryKey(),
  prompt: t.string(),
  status: t.string(),
  uiStatus: t.string(),
  statusNote: t.string(),
  desiredAgents: t.u32(),
  maxInflight: t.u32(),
  sceneHash: t.string(),
  objectCount: t.u32(),
  modelRoutingJson: t.string(),
  configJson: t.string(),
  workflowId: t.string(),
  workflowVersion: t.string(),
  planVersion: t.string(),
  reviewSceneHash: t.string(),
  reviewVerdict: t.string(),
  qualityStatus: t.string(),
  totalTasks: t.u32(),
  completedTasks: t.u32(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const scenePlanProjection = t.row("ScenePlanProjection", {
  runId: t.string().primaryKey(),
  planVersion: t.string(),
  planHash: t.string(),
  schemaVersion: t.u32(),
  width: t.u32(),
  height: t.u32(),
  painterCount: t.u32(),
  subject: t.string(),
  artDirection: t.string(),
  focalBoundsJson: t.string(),
  anchorsJson: t.string(),
  paletteJson: t.string(),
  partsJson: t.string(),
  planJson: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const scenePlanPartProjection = t.row("ScenePlanPartProjection", {
  id: t.string().primaryKey(),
  runId: t.string(),
  partId: t.string(),
  planVersion: t.string(),
  ordinal: t.u32(),
  kind: t.string(),
  role: t.string(),
  label: t.string(),
  artistName: t.string(),
  focus: t.string(),
  objective: t.string(),
  compositionRole: t.string(),
  paintMode: t.string(),
  coordinatesWithJson: t.string(),
  needsJson: t.string(),
  outputKey: t.string(),
  regionJson: t.string(),
  maxFootprintJson: t.string(),
  protectedAnchorsJson: t.string(),
  allowBleed: t.bool(),
  layerBase: t.u32(),
  minObjects: t.u32(),
  maxObjects: t.u32(),
  createdAt: t.timestamp(),
});

const canvasAgentProjection = t.row("CanvasAgentProjection", {
  id: t.string().primaryKey(),
  runId: t.string(),
  agentId: t.string(),
  name: t.string(),
  role: t.string(),
  group: t.string(),
  focus: t.string(),
  assignment: t.string(),
  model: t.string(),
  status: t.string(),
  taskId: t.string(),
  metadataJson: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const canvasTaskStatusProjection = t.row("CanvasTaskStatusProjection", {
  id: t.string().primaryKey(),
  runId: t.string(),
  taskId: t.string(),
  delegationId: t.string(),
  agentId: t.string(),
  capability: t.string(),
  objective: t.string(),
  parentTaskId: t.string(),
  planId: t.string(),
  planVersion: t.string(),
  status: t.string(),
  attempt: t.u32(),
  needsJson: t.string(),
  providesJson: t.string(),
  inputVersionsJson: t.string(),
  artifactIdsJson: t.string(),
  error: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const sceneObjectProjection = t.row("SceneObjectProjection", {
  id: t.string().primaryKey(),
  runId: t.string(),
  patchId: t.string(),
  objectId: t.string(),
  semanticId: t.string(),
  ownerAgentId: t.string(),
  taskId: t.string(),
  partId: t.string(),
  objectType: t.string(),
  geometryJson: t.string(),
  styleJson: t.string(),
  layer: t.u32(),
  rank: t.u32(),
  active: t.bool(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const sceneReviewProjection = t.row("SceneReviewProjection", {
  id: t.string().primaryKey(),
  runId: t.string(),
  sceneHash: t.string(),
  agentId: t.string(),
  verdict: t.string(),
  qualityStatus: t.string(),
  scope: t.string(),
  scoresJson: t.string(),
  checksJson: t.string(),
  notesJson: t.string(),
  createdAt: t.timestamp(),
});

const canvasActivityProjection = t.row("CanvasActivityProjection", {
  id: t.string().primaryKey(),
  runId: t.string(),
  seq: t.u64(),
  kind: t.string(),
  agentId: t.string(),
  agentName: t.string(),
  summary: t.string(),
  createdAt: t.timestamp(),
});

/**
 * A deliberately narrow replay contract for browser viewers. The private
 * receipt payload can contain operator-only orchestration data, inline
 * artifacts, task keys, and actor identities, so this projection exposes only
 * the stable ordering metadata and the fields needed to replay the public
 * Canvas scene.
 */
const canvasReplayStepProjection = t.row("CanvasReplayStepProjection", {
  id: t.string().primaryKey(),
  runId: t.string(),
  seq: t.u64(),
  kind: t.string(),
  agentId: t.string(),
  label: t.string(),
  patchId: t.string(),
  supersedesPatchId: t.string(),
  partId: t.string(),
  status: t.string(),
  objectCount: t.u32(),
  createdAt: t.timestamp(),
});

type CanvasReplayFields = {
  readonly label: string;
  readonly patchId: string;
  readonly supersedesPatchId: string;
  readonly partId: string;
  readonly status: string;
  readonly objectCount: number;
};

const replayRecord = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;

const replayString = (record: JsonRecord | undefined, key: string, maxLength: number): string => {
  const value = record?.[key];
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
};

const codingPublicRuntimeFields = (runtimeJson: string): {
  readonly runtimeKind: string;
  readonly model: string;
  readonly reasoningEffort: string;
} => {
  try {
    const binding = replayRecord(JSON.parse(runtimeJson));
    const runtime = replayRecord(binding?.runtime);
    const metadata = replayRecord(runtime?.metadata);
    const kind = replayString(runtime, "kind", 40);
    const model = replayString(metadata, "model", 160);
    const reasoningEffort = replayString(metadata, "reasoningEffort", 20);
    return {
      runtimeKind: /^(?:codex-cli|claude-code|pi-agent|hermes-agent|shell|roster-native)$/u.test(kind) ? kind : "",
      model: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(model) ? model : "",
      reasoningEffort: /^(?:low|medium|high|xhigh|max|ultra)$/u.test(reasoningEffort) ? reasoningEffort : "",
    };
  } catch {
    return { runtimeKind: "", model: "", reasoningEffort: "" };
  }
};

const replayU32 = (record: JsonRecord | undefined, key: string): number => {
  const value = record?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
    ? value
    : 0;
};

const replayKindLabel = (kind: string): string => kind
  .replace(/[._:-]+/g, " ")
  .replace(/\b\w/g, (character) => character.toUpperCase())
  .slice(0, 160);

const canvasReplayFields = (kind: string, payloadJson: string): CanvasReplayFields => {
  const fallback: CanvasReplayFields = {
    label: replayKindLabel(kind),
    patchId: "",
    supersedesPatchId: "",
    partId: "",
    status: "",
    objectCount: 0,
  };
  let event: JsonRecord | undefined;
  try {
    event = replayRecord(JSON.parse(payloadJson));
  } catch {
    return fallback;
  }
  // Even allowlisted rows must carry the validated Canvas event type before
  // any semantic field is projected.
  if (replayString(event, "type", 120) !== kind) return fallback;

  if (kind === "scene.patch.applied") {
    const patch = replayRecord(event?.patch);
    const patchId = replayString(patch, "patchId", 200);
    const supersedesPatchId = replayString(patch, "supersedesPatchId", 200);
    const partId = replayString(patch, "partId", 160);
    const objects = Array.isArray(patch?.objects) ? patch.objects : [];
    const objectCount = Math.min(objects.length, 256);
    return {
      ...fallback,
      label: `${partId || "Scene"} published ${objectCount} visual mark${objectCount === 1 ? "" : "s"}${supersedesPatchId ? " as a repair" : ""}`.slice(0, 160),
      patchId,
      supersedesPatchId,
      partId,
      objectCount,
    };
  }

  if (kind === "run.status") {
    const status = replayString(event, "status", 40);
    return {
      ...fallback,
      label: status ? `Run ${replayKindLabel(status)}` : fallback.label,
      status,
    };
  }

  if (kind === "scene.reviewed") {
    const review = replayRecord(event?.review);
    const status = replayString(review, "qualityStatus", 80) || replayString(review, "verdict", 40);
    return {
      ...fallback,
      label: status ? `Review ${replayKindLabel(status)}` : fallback.label,
      status,
    };
  }

  if (kind === "scene.finalized") {
    const objectCount = replayU32(event, "objectCount");
    return {
      ...fallback,
      label: `${objectCount} visual mark${objectCount === 1 ? "" : "s"} certified`,
      status: "completed",
      objectCount,
    };
  }

  const statusByKind: Readonly<Record<string, string>> = {
    "task.delegated": "delegated",
    "task.started": "running",
    "task.completed": "completed",
    "task.failed": "failed",
    "plan.started": "running",
    "plan.completed": "completed",
    "plan.failed": "failed",
    "plan.rejected": "failed",
    "run.canceled": "canceled",
    "run.finalized": "completed",
  };
  return { ...fallback, status: statusByKind[kind] ?? "" };
};

const CANVAS_REPLAY_KINDS = new Set([
  "prompt.set",
  "run.configured",
  "run.status",
  "scene.planned",
  "scene.patch.applied",
  "scene.reviewed",
  "scene.finalized",
  "orchestration.configured",
  "node.spawned",
  "node.retired",
  "plan.created",
  "plan.started",
  "plan.completed",
  "plan.failed",
  "plan.rejected",
  "reflection.recorded",
  "topology.selected",
  "task.delegated",
  "task.started",
  "task.completed",
  "task.failed",
  "prompt.compiled",
  "artifact.published",
  "evidence.recorded",
  "composition.proposed",
  "composition.certified",
  "composition.rejected",
  "control.update.published",
  "control.frontier.projected",
  "control.frontier.certified",
]);

const rosterRoomNodeProjection = t.row("RosterRoomNodeProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  roomId: t.string(),
  runId: t.string(),
  nodeId: t.string(),
  name: t.string(),
  capabilitiesJson: t.string(),
  parentNodeId: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const rosterParticipantProfileProjection = t.row("RosterParticipantProfileProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  nodeId: t.string(),
  displayName: t.string(),
  role: t.string(),
  bio: t.string(),
  skillsJson: t.string(),
  capabilitiesJson: t.string(),
  revision: t.u64(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const rosterContextFrontierProjection = t.row("RosterContextFrontierProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  roomId: t.string(),
  runId: t.string(),
  contextVersion: t.string(),
  frontierVersion: t.string(),
  topologyVersion: t.string(),
  catalogVersion: t.string(),
  bindingVersion: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const rosterExecutionSummaryProjection = t.row("RosterExecutionSummaryProjection", {
  runId: t.string().primaryKey(),
  protocolVersion: t.string(),
  kind: t.string(),
  workspaceId: t.string(),
  receiptStreamId: t.string(),
  status: t.string(),
  policyJson: t.string(),
  graphVersion: t.u64(),
  totalTasks: t.u32(),
  readyTasks: t.u32(),
  blockedTasks: t.u32(),
  inflightTasks: t.u32(),
  acceptedTasks: t.u32(),
  failedTasks: t.u32(),
  delegatedTasks: t.u32(),
  canceledTasks: t.u32(),
  skippedTasks: t.u32(),
  contextBytes: t.u64(),
  reservedCostMicros: t.u64(),
  spentCostMicros: t.u64(),
  usedTokens: t.u64(),
  terminalReason: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const rosterCollaborationSummaryProjection = t.row("RosterCollaborationSummaryProjection", {
  runId: t.string().primaryKey(),
  workspaceId: t.string(),
  proposalCount: t.u32(),
  responseCount: t.u32(),
  endorsementCount: t.u32(),
  updatedAt: t.timestamp(),
});

const rosterRoomControlIntentProjection = t.row("RosterRoomControlIntentProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  roomId: t.string(),
  intentId: t.string(),
  kind: t.string(),
  status: t.string(),
  targetRunId: t.string(),
  createdAt: t.timestamp(),
  consumedAt: t.option(t.timestamp()),
});

const codingPublicRoomProjection = t.row("CodingPublicRoomProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  kind: t.string(),
  status: t.string(),
  activeRunId: t.string(),
  certifiedCheckpointId: t.string(),
  nextTimelineSeq: t.u64(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

const codingTaskOutputReferenceProjection = t.row("CodingTaskOutputReferenceProjection", {
  id: t.string().primaryKey(),
  runId: t.string(),
  taskKey: t.string(),
  taskId: t.string(),
  outcomeId: t.string(),
  artifactId: t.string(),
  outputKey: t.string(),
  createdAt: t.timestamp(),
});

const codingExecutionSummaryProjection = t.row("CodingExecutionSummaryProjection", {
  runId: t.string().primaryKey(),
  workspaceId: t.string(),
  kind: t.string(),
  status: t.string(),
  graphVersion: t.u64(),
  totalTasks: t.u32(),
  readyTasks: t.u32(),
  blockedTasks: t.u32(),
  inflightTasks: t.u32(),
  acceptedTasks: t.u32(),
  failedTasks: t.u32(),
  canceledTasks: t.u32(),
  skippedTasks: t.u32(),
  terminalReason: t.string(),
  updatedAt: t.timestamp(),
});

/** Public execution identity only; runtimeJson may contain placement credentials. */
const codingActiveRuntimeBindingProjection = t.row("CodingActiveRuntimeBindingProjection", {
  id: t.string().primaryKey(),
  workspaceId: t.string(),
  roomId: t.string(),
  runId: t.string(),
  nodeId: t.string(),
  bindingId: t.string(),
  epoch: t.u64(),
  topologyVersion: t.string(),
  runtimeKind: t.string(),
  model: t.string(),
  reasoningEffort: t.string(),
  createdAt: t.timestamp(),
});

/** Provider-neutral caller-scoped Room OS directory and normalized projections. */
export const myRosterRooms = spacetimedb.view(
  { name: "my_roster_rooms", public: true },
  t.array(rosterRoom.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const row of ctx.db.rosterRoom.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    return rows;
  }
);

export const myRosterRoomNodes = spacetimedb.view(
  { name: "my_roster_room_nodes", public: true },
  t.array(rosterRoomNodeProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const row of ctx.db.rosterRoomNode.workspaceId.filter(membership.workspaceId)) {
        rows.push({
          id: row.id,
          workspaceId: row.workspaceId,
          roomId: row.roomId,
          runId: row.runId,
          nodeId: row.nodeId,
          name: row.name,
          capabilitiesJson: row.capabilitiesJson,
          parentNodeId: row.parentNodeId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      }
    }
    return rows;
  }
);

export const myRosterParticipantProfiles = spacetimedb.view(
  { name: "my_roster_participant_profiles", public: true },
  t.array(rosterParticipantProfileProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const row of ctx.db.rosterParticipantProfile.workspaceId.filter(membership.workspaceId)) {
        rows.push({
          id: row.id,
          workspaceId: row.workspaceId,
          nodeId: row.nodeId,
          displayName: row.displayName,
          role: row.role,
          bio: row.bio,
          skillsJson: row.skillsJson,
          capabilitiesJson: row.capabilitiesJson,
          revision: row.revision,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      }
    }
    return rows;
  }
);

/** Exact-run, bounded Coding browser DTOs. Run membership is the only authority. */
export const myCodingRoomsWindow = spacetimedb.view(
  { name: "my_coding_rooms_window", public: true },
  t.array(codingPublicRoomProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      const room = roomForRun(ctx.db.rosterRoom.activeRunId.filter(membership.runId));
      if (!room) continue;
      rows.push({
        id: room.id,
        workspaceId: room.workspaceId,
        kind: room.kind,
        status: room.status,
        activeRunId: room.activeRunId,
        certifiedCheckpointId: room.certifiedCheckpointId,
        nextTimelineSeq: room.nextTimelineSeq,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
      });
    }
    return rows;
  }
);

export const myCodingRoomNodesWindow = spacetimedb.view(
  { name: "my_coding_room_nodes_window", public: true },
  t.array(rosterRoomNodeProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      for (const row of ctx.db.rosterRoomNode.runId.filter(membership.runId)) {
        rows.push({
          id: row.id,
          workspaceId: row.workspaceId,
          roomId: row.roomId,
          runId: row.runId,
          nodeId: row.nodeId,
          name: row.name,
          capabilitiesJson: row.capabilitiesJson,
          parentNodeId: row.parentNodeId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      }
    }
    return rows;
  }
);

export const myCodingParticipantProfilesWindow = spacetimedb.view(
  { name: "my_coding_participant_profiles_window", public: true },
  t.array(rosterParticipantProfileProjection),
  (ctx) => {
    const rows = [];
    const seen = new Set<string>();
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      const execution = ctx.db.rosterExecution.runId.find(membership.runId);
      if (!execution) continue;
      const nodeIds = new Set(
        [...ctx.db.rosterRoomNode.runId.filter(membership.runId)].map((node) => node.nodeId)
      );
      for (const row of ctx.db.rosterParticipantProfile.workspaceId.filter(execution.workspaceId)) {
        if (!nodeIds.has(row.nodeId) || seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push({
          id: row.id,
          workspaceId: row.workspaceId,
          nodeId: row.nodeId,
          displayName: row.displayName,
          role: row.role,
          bio: row.bio,
          skillsJson: row.skillsJson,
          capabilitiesJson: row.capabilitiesJson,
          revision: row.revision,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      }
    }
    return rows;
  }
);

/** Caller-scoped canonical node directory and continuity control projections. */
export const myRosterWorkspaceNodes = spacetimedb.view(
  { name: "my_roster_workspace_nodes", public: true },
  t.array(rosterWorkspaceNode.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const row of ctx.db.rosterWorkspaceNode.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    return rows;
  }
);

export const myRosterNodeContinuities = spacetimedb.view(
  { name: "my_roster_node_continuities", public: true },
  t.array(rosterNodeContinuity.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const row of ctx.db.rosterNodeContinuity.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    return rows;
  }
);

export const myRosterNodeInboxItems = spacetimedb.view(
  { name: "my_roster_node_inbox_items", public: true },
  t.array(rosterNodeInboxItem.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      for (const row of ctx.db.rosterNodeInboxItem.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    return rows;
  }
);

export const myRosterNodeWakes = spacetimedb.view(
  { name: "my_roster_node_wakes", public: true },
  t.array(rosterNodeWake.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      for (const row of ctx.db.rosterNodeWake.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    return rows;
  }
);

export const myRosterNodeCommitments = spacetimedb.view(
  { name: "my_roster_node_commitments", public: true },
  t.array(rosterNodeCommitment.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      for (const row of ctx.db.rosterNodeCommitment.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    return rows;
  }
);

export const myRosterNodeContinuityEvents = spacetimedb.view(
  { name: "my_roster_node_continuity_events", public: true },
  t.array(rosterNodeContinuityEvent.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role !== "owner" && membership.role !== "coordinator") continue;
      for (const row of ctx.db.rosterNodeContinuityEvent.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    rows.sort((left, right) => {
      const nodeOrder = left.nodeId.localeCompare(right.nodeId);
      return nodeOrder || (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
    });
    return rows;
  }
);

export const myRosterRoomTimelineEntries = spacetimedb.view(
  { name: "my_roster_room_timeline_entries", public: true },
  t.array(rosterRoomTimelineEntry.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const row of ctx.db.rosterRoomTimelineEntry.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    rows.sort((left, right) => {
      const roomOrder = left.roomId.localeCompare(right.roomId);
      return roomOrder || (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
    });
    return rows;
  }
);

/**
 * Browser-specific recent timeline projection. The complete ordered timeline
 * remains authoritative in roster_room_timeline_entry and available through
 * the operator view for explicit cursor pages; a live Coding tab never keeps
 * an unbounded room history subscribed in memory.
 */
export const myCodingRoomTimelineWindow = spacetimedb.view(
  { name: "my_coding_room_timeline_window", public: true },
  t.array(codingSelectedRoomTimelineProjection),
  (ctx) => {
    const rows = [];
    for (const request of ctx.db.codingRoomTimelinePageRequest.member.filter(ctx.sender)) {
      if (!request.selectionId || !request.expiresAt) continue;
      if (!ctx.db.runMember.id.find(membershipKey(request.runId, ctx.sender))) continue;
      const execution = ctx.db.rosterExecution.runId.find(request.runId);
      const room = ctx.db.rosterRoom.id.find(request.roomId);
      if (!execution || !room
        || execution.workspaceId !== request.workspaceId
        || room.workspaceId !== request.workspaceId
        || room.activeRunId !== request.runId) continue;
      rows.push(...codingTimelineHead(
        ctx.db.rosterRoomTimelineEntry.runId.filter(request.runId),
        {
          runId: request.runId,
          roomId: request.roomId,
          maxRows: CODING_TIMELINE_WINDOW_ROWS,
        },
      ).map((row) => ({
        selectionRowId: compoundKey(request.selectionId, row.id),
        selectionId: request.selectionId,
        id: row.id,
        workspaceId: row.workspaceId,
        roomId: row.roomId,
        runId: row.runId,
        seq: row.seq,
        kind: row.kind,
        taskId: row.taskId,
        nodeId: row.nodeId,
        entryJson: row.entryJson,
        createdAt: row.createdAt,
      })));
    }
    rows.sort((left, right) => left.selectionId.localeCompare(right.selectionId)
      || (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : left.id.localeCompare(right.id)));
    return rows;
  }
);

export const myCodingRoomTimeline = spacetimedb.view(
  { name: "my_coding_room_timeline", public: true },
  t.array(rosterRoomTimelineEntry.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      for (const row of ctx.db.rosterRoomTimelineEntry.runId.filter(membership.runId)) rows.push(row);
    }
    return [...boundedCodingTimelineRows(rows, CODING_TIMELINE_PUBLIC_ROWS)];
  }
);

export const myCodingRoomTimelinePage = spacetimedb.view(
  { name: "my_coding_room_timeline_page", public: true },
  t.array(codingSelectedRoomTimelineProjection),
  (ctx) => {
    const rows = [];
    for (const request of ctx.db.codingRoomTimelinePageRequest.member.filter(ctx.sender)) {
      if (!request.selectionId || !request.expiresAt || request.beforeSeq === 0n) continue;
      if (!ctx.db.runMember.id.find(membershipKey(request.runId, ctx.sender))) continue;
      const execution = ctx.db.rosterExecution.runId.find(request.runId);
      const room = ctx.db.rosterRoom.id.find(request.roomId);
      if (!execution || !room
        || execution.workspaceId !== request.workspaceId
        || room.workspaceId !== request.workspaceId
        || room.activeRunId !== request.runId) continue;
      rows.push(...codingTimelinePage(
        ctx.db.rosterRoomTimelineEntry.runId.filter(request.runId),
        {
          runId: request.runId,
          roomId: request.roomId,
          beforeSeq: request.beforeSeq,
          maxRows: CODING_TIMELINE_PAGE_ROWS,
        },
      ).map((row) => ({
        selectionRowId: compoundKey(request.selectionId, row.id),
        selectionId: request.selectionId,
        id: row.id,
        workspaceId: row.workspaceId,
        roomId: row.roomId,
        runId: row.runId,
        seq: row.seq,
        kind: row.kind,
        taskId: row.taskId,
        nodeId: row.nodeId,
        entryJson: row.entryJson,
        createdAt: row.createdAt,
      })));
    }
    rows.sort((left, right) => {
      const selectionOrder = left.selectionId.localeCompare(right.selectionId);
      const runOrder = left.runId.localeCompare(right.runId);
      const roomOrder = left.roomId.localeCompare(right.roomId);
      return selectionOrder || runOrder || roomOrder
        || (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : left.id.localeCompare(right.id));
    });
    return rows;
  }
);

export const myCodingControlIntentDeliveriesWindow = spacetimedb.view(
  { name: "my_coding_control_intent_deliveries_window", public: true },
  t.array(rosterRoomControlIntentProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      const room = roomForRun(ctx.db.rosterRoom.activeRunId.filter(membership.runId));
      if (!room) continue;
      for (const row of ctx.db.rosterRoomControlIntent.roomId.filter(room.id)) {
        if (row.targetRunId && row.targetRunId !== membership.runId) continue;
        rows.push({
          id: row.id,
          workspaceId: row.workspaceId,
          roomId: row.roomId,
          intentId: row.intentId,
          kind: row.kind,
          status: row.status,
          targetRunId: row.targetRunId,
          createdAt: row.createdAt,
          consumedAt: row.consumedAt,
        });
      }
    }
    return rows;
  }
);

export const myCodingContextFrontiersWindow = spacetimedb.view(
  { name: "my_coding_context_frontiers_window", public: true },
  t.array(rosterContextFrontierProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      for (const row of ctx.db.rosterContextFrontier.runId.filter(membership.runId)) {
        rows.push({
          id: row.id,
          workspaceId: row.workspaceId,
          roomId: row.roomId,
          runId: row.runId,
          contextVersion: row.contextVersion,
          frontierVersion: row.frontierVersion,
          topologyVersion: row.topologyVersion,
          catalogVersion: row.catalogVersion,
          bindingVersion: row.bindingVersion,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      }
    }
    return rows;
  }
);

export const myCodingExecutionSummariesWindow = spacetimedb.view(
  { name: "my_coding_execution_summaries_window", public: true },
  t.array(codingExecutionSummaryProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      const row = ctx.db.rosterExecution.runId.find(membership.runId);
      if (!row) continue;
      const publicCounts = codingUserVisibleExecutionCounts(
        ctx.db.rosterTaskDefinition.runId.filter(membership.runId)
      );
      rows.push({
        runId: row.runId,
        kind: row.kind,
        workspaceId: row.workspaceId,
        status: row.status,
        graphVersion: row.graphVersion,
        ...publicCounts,
        terminalReason: row.status === "completed_with_notes"
          ? "completed-with-notes"
          : row.status === "budget_exhausted"
            ? "budget-exhausted"
            : row.status === "failed"
              ? "run-failed"
              : row.status === "canceled"
                ? "run-canceled"
                : "",
        updatedAt: row.updatedAt,
      });
    }
    return rows;
  }
);

export const myRosterControlIntents = spacetimedb.view(
  { name: "my_roster_control_intents", public: true },
  t.array(rosterRoomControlIntent.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role !== "owner" && membership.role !== "coordinator") continue;
      for (const row of ctx.db.rosterRoomControlIntent.workspaceId.filter(membership.workspaceId)) {
        rows.push(row);
      }
    }
    return rows;
  }
);

/** Delivery state only; safe for every workspace member and browser client. */
export const myRosterControlIntentDeliveries = spacetimedb.view(
  { name: "my_roster_control_intent_deliveries", public: true },
  t.array(rosterRoomControlIntentProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const row of ctx.db.rosterRoomControlIntent.workspaceId.filter(membership.workspaceId)) {
        rows.push({
          id: row.id,
          workspaceId: row.workspaceId,
          roomId: row.roomId,
          intentId: row.intentId,
          kind: row.kind,
          status: row.status,
          targetRunId: row.targetRunId,
          createdAt: row.createdAt,
          consumedAt: row.consumedAt,
        });
      }
    }
    return rows;
  }
);

export const myRosterContextFrontiers = spacetimedb.view(
  { name: "my_roster_context_frontiers", public: true },
  t.array(rosterContextFrontierProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const row of ctx.db.rosterContextFrontier.workspaceId.filter(membership.workspaceId)) {
        rows.push({
          id: row.id,
          workspaceId: row.workspaceId,
          roomId: row.roomId,
          runId: row.runId,
          contextVersion: row.contextVersion,
          frontierVersion: row.frontierVersion,
          topologyVersion: row.topologyVersion,
          catalogVersion: row.catalogVersion,
          bindingVersion: row.bindingVersion,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      }
    }
    return rows;
  }
);

export const myRosterTaskContextManifests = spacetimedb.view(
  { name: "my_roster_task_context_manifests", public: true },
  t.array(rosterTaskContextManifest.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      for (const row of ctx.db.rosterTaskContextManifest.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    return rows;
  }
);

export const myRosterExecutionSummaries = spacetimedb.view(
  { name: "my_roster_execution_summaries", public: true },
  t.array(rosterExecutionSummaryProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const row of ctx.db.rosterExecution.workspaceId.filter(membership.workspaceId)) {
        rows.push({
          runId: row.runId,
          protocolVersion: row.protocolVersion,
          kind: row.kind,
          workspaceId: row.workspaceId,
          receiptStreamId: row.receiptStreamId,
          status: row.status,
          policyJson: row.policyJson,
          graphVersion: row.graphVersion,
          totalTasks: row.totalTasks,
          readyTasks: row.readyTasks,
          blockedTasks: row.blockedTasks,
          inflightTasks: row.inflightTasks,
          acceptedTasks: row.acceptedTasks,
          failedTasks: row.failedTasks,
          delegatedTasks: row.delegatedTasks,
          canceledTasks: row.canceledTasks,
          skippedTasks: row.skippedTasks,
          contextBytes: row.contextBytes,
          reservedCostMicros: row.reservedCostMicros,
          spentCostMicros: row.spentCostMicros,
          usedTokens: row.usedTokens,
          terminalReason: row.terminalReason,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      }
    }
    return rows;
  }
);

export const myRosterTaskEdges = spacetimedb.view(
  { name: "my_roster_task_edges", public: true },
  t.array(rosterTaskEdge.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const execution of ctx.db.rosterExecution.workspaceId.filter(membership.workspaceId)) {
        for (const row of ctx.db.rosterTaskEdge.runId.filter(execution.runId)) rows.push(row);
      }
    }
    return rows;
  }
);

export const myRosterTaskOutcomes = spacetimedb.view(
  { name: "my_roster_task_outcomes", public: true },
  t.array(rosterTaskOutcome.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      for (const execution of ctx.db.rosterExecution.workspaceId.filter(membership.workspaceId)) {
        for (const row of ctx.db.rosterTaskOutcome.runId.filter(execution.runId)) rows.push(row);
      }
    }
    return rows;
  }
);

export const myRosterTaskExpansions = spacetimedb.view(
  { name: "my_roster_task_expansions", public: true },
  t.array(rosterTaskExpansion.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      for (const execution of ctx.db.rosterExecution.workspaceId.filter(membership.workspaceId)) {
        for (const row of ctx.db.rosterTaskExpansion.runId.filter(execution.runId)) rows.push(row);
      }
    }
    return rows;
  }
);

export const myRosterTaskOutputReferences = spacetimedb.view(
  { name: "my_roster_task_output_references", public: true },
  t.array(rosterTaskOutputReference.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      for (const execution of ctx.db.rosterExecution.workspaceId.filter(membership.workspaceId)) {
        for (const row of ctx.db.rosterTaskOutputReference.runId.filter(execution.runId)) rows.push(row);
      }
    }
    return rows;
  }
);

export const myRosterCollaborationSummaries = spacetimedb.view(
  { name: "my_roster_collaboration_summaries", public: true },
  t.array(rosterCollaborationSummaryProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const execution of ctx.db.rosterExecution.workspaceId.filter(membership.workspaceId)) {
        const proposals = new Set<string>();
        const responses = new Set<string>();
        const endorsements = new Set<string>();
        for (const reference of ctx.db.rosterTaskOutputReference.runId.filter(execution.runId)) {
          if (reference.outputKey.startsWith("collaboration_proposal_")) {
            proposals.add(reference.outputKey);
          } else if (reference.outputKey.startsWith("collaboration_response_")) {
            responses.add(reference.outputKey);
          } else if (reference.outputKey.startsWith("collaboration_endorsement_")) {
            endorsements.add(reference.outputKey);
          }
        }
        rows.push({
          runId: execution.runId,
          workspaceId: execution.workspaceId,
          proposalCount: proposals.size,
          responseCount: responses.size,
          endorsementCount: endorsements.size,
          updatedAt: execution.updatedAt,
        });
      }
    }
    return rows;
  }
);

export const myRosterRuntimeBindings = spacetimedb.view(
  { name: "my_roster_runtime_bindings", public: true },
  t.array(rosterRuntimeBinding.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      for (const row of ctx.db.rosterRuntimeBinding.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    return rows;
  }
);

export const myCodingCollaborationSummariesWindow = spacetimedb.view(
  { name: "my_coding_collaboration_summaries_window", public: true },
  t.array(rosterCollaborationSummaryProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      const execution = ctx.db.rosterExecution.runId.find(membership.runId);
      if (!execution) continue;
      const proposals = new Set<string>();
      const responses = new Set<string>();
      const endorsements = new Set<string>();
      for (const reference of ctx.db.rosterTaskOutputReference.runId.filter(membership.runId)) {
        if (reference.outputKey.startsWith("collaboration_proposal_")) proposals.add(reference.outputKey);
        else if (reference.outputKey.startsWith("collaboration_response_")) responses.add(reference.outputKey);
        else if (reference.outputKey.startsWith("collaboration_endorsement_")) endorsements.add(reference.outputKey);
      }
      rows.push({
        runId: membership.runId,
        workspaceId: execution.workspaceId,
        proposalCount: proposals.size,
        responseCount: responses.size,
        endorsementCount: endorsements.size,
        updatedAt: execution.updatedAt,
      });
    }
    return rows;
  }
);

export const myCodingActiveRuntimeBindingsWindow = spacetimedb.view(
  { name: "my_coding_active_runtime_bindings_window", public: true },
  t.array(codingActiveRuntimeBindingProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      for (const row of ctx.db.rosterRuntimeBinding.runId.filter(membership.runId)) {
        const runtime = codingPublicRuntimeFields(row.runtimeJson);
        rows.push({
          id: row.id,
          workspaceId: row.workspaceId,
          roomId: row.roomId,
          runId: row.runId,
          nodeId: row.nodeId,
          bindingId: row.bindingId,
          epoch: row.epoch,
          topologyVersion: row.topologyVersion,
          runtimeKind: runtime.runtimeKind,
          model: runtime.model,
          reasoningEffort: runtime.reasoningEffort,
          createdAt: row.createdAt,
        });
      }
    }
    return rows;
  }
);

export const myRosterModelReservations = spacetimedb.view(
  { name: "my_roster_model_reservations", public: true },
  t.array(rosterModelReservation.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role !== "owner" && membership.role !== "coordinator") continue;
      for (const row of ctx.db.rosterModelReservation.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    return rows;
  }
);

export const myRosterProjectionOutbox = spacetimedb.view(
  { name: "my_roster_projection_outbox", public: true },
  t.array(rosterProjectionOutbox.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role !== "owner" && membership.role !== "coordinator") continue;
      for (const row of ctx.db.rosterProjectionOutbox.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    return rows;
  }
);

export const myRosterSharedWorkspaceUpdates = spacetimedb.view(
  { name: "my_roster_shared_workspace_updates", public: true },
  t.array(rosterSharedWorkspaceUpdate.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      for (const row of ctx.db.rosterSharedWorkspaceUpdate.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    return rows;
  }
);

export const myRosterSharedWorkspaceCheckpoints = spacetimedb.view(
  { name: "my_roster_shared_workspace_checkpoints", public: true },
  t.array(rosterSharedWorkspaceCheckpoint.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      for (const row of ctx.db.rosterSharedWorkspaceCheckpoint.workspaceId.filter(membership.workspaceId)) rows.push(row);
    }
    return rows;
  }
);

export const myWorkspaces = spacetimedb.view(
  { name: "my_workspaces", public: true },
  t.array(workspaceProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      const workspace = ctx.db.rosterWorkspace.id.find(membership.workspaceId);
      if (!workspace) continue;
      rows.push({
        id: workspace.id,
        name: workspace.name,
        role: membership.role,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      });
    }
    return rows;
  }
);

export const myWorkspaceUsage = spacetimedb.view(
  { name: "my_workspace_usage", public: true },
  t.array(workspaceUsageProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      const usage = ctx.db.rosterWorkspaceUsage.workspaceId.find(membership.workspaceId);
      if (!usage) continue;
      rows.push({
        workspaceId: usage.workspaceId,
        jobsInWindow: usage.jobsInWindow,
        activeJobs: usage.activeJobs,
        totalJobs: usage.totalJobs,
        maxJobsInWindow: MAX_JOBS_PER_WORKSPACE_WINDOW,
        maxActiveJobs: MAX_ACTIVE_JOBS_PER_WORKSPACE,
        windowStartedAt: usage.windowStartedAt,
        updatedAt: usage.updatedAt,
      });
    }
    return rows;
  }
);

/** Caller-scoped stream metadata. Subscribe narrowly by `stream_id`. */
export const myEventStreams = spacetimedb.view(
  { name: "my_event_streams", public: true },
  t.array(eventStreamProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const stream of ctx.db.eventStream.workspaceId.filter(membership.workspaceId)) {
        rows.push({
          id: stream.id,
          workspaceId: stream.workspaceId,
          streamId: logicalStreamId(stream.workspaceId, stream.id),
          kind: stream.kind,
          headHash: stream.headHash,
          receiptCount: stream.receiptCount,
          parentStreamId: stream.parentStreamId
            ? logicalStreamId(stream.workspaceId, stream.parentStreamId)
            : "",
          forkAt: stream.forkAt,
          createdAt: stream.createdAt,
          updatedAt: stream.updatedAt,
        });
      }
    }
    return rows;
  }
);

/** Caller-scoped durable Coding conversation directory. */
export const myCodingRooms = spacetimedb.view(
  { name: "my_coding_rooms", public: true },
  t.array(codingRoomProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const room of ctx.db.codingRoom.workspaceId.filter(membership.workspaceId)) {
        rows.push({
          id: room.id,
          workspaceId: room.workspaceId,
          codingWorkspaceId: room.codingWorkspaceId,
          roomId: room.roomId,
          conversationId: room.conversationId,
          streamId: logicalStreamId(room.workspaceId, room.streamId),
          title: room.title,
          state: room.state,
          firstMessageId: room.firstMessageId,
          messageCount: room.messageCount,
          createdAt: room.createdAt,
          updatedAt: room.updatedAt,
        });
      }
    }
    rows.sort((left, right) =>
      left.updatedAt.microsSinceUnixEpoch > right.updatedAt.microsSinceUnixEpoch
        ? -1
        : left.updatedAt.microsSinceUnixEpoch < right.updatedAt.microsSinceUnixEpoch
          ? 1
          : left.roomId.localeCompare(right.roomId));
    return rows;
  }
);

/** Complete durable receipts. Browser subscriptions must filter selected streams. */
export const myStreamReceipts = spacetimedb.view(
  { name: "my_stream_receipts", public: true },
  t.array(streamReceiptProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const receipt of ctx.db.streamReceipt.workspaceId.filter(membership.workspaceId)) {
        rows.push({
          id: receipt.id,
          workspaceId: receipt.workspaceId,
          streamId: logicalStreamId(receipt.workspaceId, receipt.streamId),
          seq: receipt.seq,
          receiptId: receipt.receiptId,
          occurredAtMs: receipt.occurredAtMs,
          prevHash: receipt.prevHash,
          hash: receipt.hash,
          bodyJson: receipt.bodyJson,
          hintsJson: receipt.hintsJson,
          createdAt: receipt.createdAt,
        });
      }
    }
    rows.sort((left, right) => {
      const streamOrder = left.streamId.localeCompare(right.streamId);
      return streamOrder || (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
    });
    return rows;
  }
);

export const myStreamBranches = spacetimedb.view(
  { name: "my_stream_branches", public: true },
  t.array(streamBranchProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const stream of ctx.db.eventStream.workspaceId.filter(membership.workspaceId)) {
        if (!stream.parentStreamId) continue;
        rows.push({
          id: stream.id,
          workspaceId: stream.workspaceId,
          streamId: logicalStreamId(stream.workspaceId, stream.id),
          parentStreamId: logicalStreamId(stream.workspaceId, stream.parentStreamId),
          forkAt: stream.forkAt,
          createdAtMs: stream.createdAt.microsSinceUnixEpoch / 1_000n,
        });
      }
    }
    return rows;
  }
);

/** Current queue state for direct worker and monitor subscriptions. */
export const myRosterJobs = spacetimedb.view(
  { name: "my_roster_jobs", public: true },
  t.array(rosterJobProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const job of ctx.db.rosterJob.workspaceId.filter(membership.workspaceId)) {
        rows.push({
          id: job.id,
          workspaceId: job.workspaceId,
          agentId: job.agentId,
          lane: job.lane,
          sessionKey: job.sessionKey,
          singletonMode: job.singletonMode,
          payloadJson: job.payloadJson,
          status: job.status,
          attempt: job.attempt,
          maxAttempts: job.maxAttempts,
          leaseOwner: job.leaseOwner,
          leaseWorker: job.leaseWorker,
          leaseFence: job.leaseFence,
          leaseUntil: job.leaseUntil,
          claimToken: job.claimToken,
          availableAt: job.availableAt,
          lastError: job.lastError,
          resultJson: job.resultJson,
          canceledReason: job.canceledReason,
          abortRequested: job.abortRequested,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        });
      }
    }
    return rows;
  }
);

export const myRosterJobCommands = spacetimedb.view(
  { name: "my_roster_job_commands", public: true },
  t.array(rosterJobCommandProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const command of ctx.db.rosterJobCommand.workspaceId.filter(membership.workspaceId)) {
        rows.push({
          id: command.id,
          workspaceId: command.workspaceId,
          jobId: command.jobId,
          command: command.command,
          lane: command.lane,
          payloadJson: command.payloadJson,
          by: command.by,
          createdAt: command.createdAt,
          consumedAt: command.consumedAt,
          consumedBy: command.consumedBy,
        });
      }
    }
    return rows;
  }
);

export const myRosterJobEvents = spacetimedb.view(
  { name: "my_roster_job_events", public: true },
  t.array(rosterJobEventProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const event of ctx.db.rosterJobEvent.workspaceId.filter(membership.workspaceId)) {
        rows.push({
          id: event.id,
          workspaceId: event.workspaceId,
          jobId: event.jobId,
          seq: event.seq,
          kind: event.kind,
          eventJson: event.eventJson,
          createdAt: event.createdAt,
        });
      }
    }
    rows.sort((left, right) => {
      const jobOrder = left.jobId.localeCompare(right.jobId);
      return jobOrder || (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
    });
    return rows;
  }
);

/** Enqueue response correlation is visible only to identities allowed to mutate work. */
export const myRosterJobRequests = spacetimedb.view(
  { name: "my_roster_job_requests", public: true },
  t.array(rosterJobRequestProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      for (const request of ctx.db.rosterJobRequest.workspaceId.filter(membership.workspaceId)) {
        rows.push({
          id: request.id,
          workspaceId: request.workspaceId,
          requestId: request.requestId,
          requestedJobId: request.requestedJobId,
          resolvedJobId: request.resolvedJobId,
          createdAt: request.createdAt,
        });
      }
    }
    return rows;
  }
);

/** Workspace-scoped Canvas summaries make the Command Center one fleet view. */
export const myCanvasFleetRuns = spacetimedb.view(
  { name: "my_canvas_fleet_runs", public: true },
  t.array(canvasFleetRunProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const link of ctx.db.canvasWorkspaceRun.workspaceId.filter(membership.workspaceId)) {
        const run = ctx.db.canvasRun.id.find(link.runId);
        if (!run) continue;
        const detail = ctx.db.canvasRunDetail.runId.find(run.id);
        let activeAgents = 0;
        let totalAgents = 0;
        for (const agent of ctx.db.canvasAgent.runId.filter(run.id)) {
          totalAgents += 1;
          if (["delegated", "leased", "running"].includes(agent.status)) activeAgents += 1;
        }
        rows.push({
          id: run.id,
          workspaceId: link.workspaceId,
          prompt: run.prompt,
          status: detail?.uiStatus || run.status,
          desiredAgents: run.desiredAgents,
          maxInflight: run.maxInflight,
          objectCount: run.objectCount,
          activeAgents,
          totalAgents,
          totalTasks: detail?.totalTasks ?? 0,
          completedTasks: detail?.completedTasks ?? 0,
          createdAt: run.createdAt,
          updatedAt: detail?.updatedAt ?? run.updatedAt,
        });
      }
    }
    return rows;
  }
);

export const myCanvasRuns = spacetimedb.view(
  { name: "my_canvas_runs", public: true },
  t.array(canvasRunProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      const run = ctx.db.canvasRun.id.find(membership.runId);
      if (run) {
        rows.push({
          id: run.id,
          owner: run.owner,
          prompt: run.prompt,
          status: run.status,
          desiredAgents: run.desiredAgents,
          maxInflight: run.maxInflight,
          nextReceiptSeq: run.nextReceiptSeq,
          headReceiptHash: run.headReceiptHash,
          budgetMicros: run.budgetMicros,
          reservedMicros: run.reservedMicros,
          spentMicros: run.spentMicros,
          sceneHash: run.sceneHash,
          objectCount: run.objectCount,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        });
      }
    }
    return rows;
  }
);

export const myRunMembers = spacetimedb.view(
  { name: "my_run_members", public: true },
  t.array(runMemberProjection),
  (ctx) => {
    const rows = [];
    const seen = new Set<string>();
    for (const mine of ctx.db.runMember.member.filter(ctx.sender)) {
      if (mine.role !== "owner" && mine.role !== "coordinator") continue;
      for (const member of ctx.db.runMember.runId.filter(mine.runId)) {
        if (seen.has(member.id)) continue;
        seen.add(member.id);
        rows.push({
          id: member.id,
          runId: member.runId,
          member: member.member,
          role: member.role,
          createdAt: member.createdAt,
        });
      }
    }
    return rows;
  }
);

/** A worker sees only its own grants, never the fleet's identity/capability map. */
export const myRosterWorkerCapabilities = spacetimedb.view(
  { name: "my_roster_worker_capabilities", public: true },
  t.array(workerCapabilityProjection),
  (ctx) => {
    const rows = [];
    for (const grant of ctx.db.rosterWorkerCapability.worker.filter(ctx.sender)) {
      const execution = ctx.db.rosterExecution.runId.find(grant.runId);
      if (!execution) continue;
      const membership = ctx.db.rosterWorkspaceMember.id.find(
        workspaceMembershipKey(execution.workspaceId, ctx.sender)
      );
      if (!membership || membership.role === "viewer") continue;
      rows.push({
        id: compoundKey(grant.runId, grant.capability),
        runId: grant.runId,
        capability: grant.capability,
        createdAt: grant.createdAt,
      });
    }
    return rows;
  }
);

export const myRosterTasks = spacetimedb.view(
  { name: "my_roster_tasks", public: true },
  t.array(rosterTaskProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      for (const execution of ctx.db.rosterExecution.workspaceId.filter(membership.workspaceId)) {
        for (const task of ctx.db.rosterTaskDefinition.runId.filter(execution.runId)) {
          if (
            membership.role === "worker"
            && !task.leaseOwner?.equals(ctx.sender)
            && !(
              task.status === "ready"
              && Boolean(
                ctx.db.rosterWorkerCapability.id.find(workerCapabilityKey(execution.runId, ctx.sender, "*"))
                || ctx.db.rosterWorkerCapability.id.find(
                  workerCapabilityKey(execution.runId, ctx.sender, task.capability)
                )
              )
            )
          ) continue;
          const sanitized = membership.role === "viewer";
          rows.push({
            id: task.id,
            runId: task.runId,
            taskId: task.taskId,
            semanticKey: sanitized ? "" : task.semanticKey,
            definitionHash: sanitized ? "" : task.definitionHash,
            definitionJson: sanitized ? "{}" : task.definitionJson,
            nodeId: task.nodeId,
            capability: task.capability,
            objective: sanitized ? "" : task.objective,
            status: task.status,
            parentTaskId: task.parentTaskId,
            depth: task.depth,
            attempt: task.attempt,
            maxAttempts: task.maxAttempts,
            leaseOwner: sanitized ? undefined : task.leaseOwner,
            leaseFence: task.leaseFence,
            leaseUntil: sanitized ? undefined : task.leaseUntil,
            availableAt: task.availableAt,
            lastError: sanitized ? "" : task.lastError,
            outcomeId: task.outcomeId,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          });
        }
      }
    }
    return rows;
  }
);

/**
 * Bounded Coding task projection. Non-terminal work is ordered before recent
 * terminal history so a large durable graph remains operable without forcing
 * every browser to retain all 2,000 task rows. The Coding execution-summary
 * view remains the complete substantive-work count authority.
 */
export const myCodingRunTasksWindow = spacetimedb.view(
  { name: "my_coding_run_tasks_window", public: true },
  t.array(codingRunTaskProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      const execution = ctx.db.rosterExecution.runId.find(membership.runId);
      if (execution) {
        const runRows = [];
        for (const task of ctx.db.rosterTaskDefinition.runId.filter(execution.runId)) {
          const failure = codingPublicTaskFailure(task);
          runRows.push({
            id: task.id,
            runId: task.runId,
            taskId: task.taskId,
            nodeId: task.nodeId,
            capability: task.capability,
            status: task.status,
            attempt: task.attempt,
            failureCategory: failure.category,
            failureReason: failure.reason,
            updatedAt: task.updatedAt,
          });
        }
        runRows.sort((left, right) => {
          const leftTerminal = TERMINAL_ROSTER_TASK_STATUSES.has(left.status);
          const rightTerminal = TERMINAL_ROSTER_TASK_STATUSES.has(right.status);
          if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
          const leftUpdated = left.updatedAt.microsSinceUnixEpoch;
          const rightUpdated = right.updatedAt.microsSinceUnixEpoch;
          return leftUpdated < rightUpdated ? 1 : leftUpdated > rightUpdated ? -1 : left.taskId.localeCompare(right.taskId);
        });
        rows.push(...runRows.slice(0, CODING_TASK_WINDOW_ROWS));
      }
    }
    return rows;
  }
);

export const myCodingRunTaskEdgesWindow = spacetimedb.view(
  { name: "my_coding_run_task_edges_window", public: true },
  t.array(rosterTaskEdge.rowType),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      const execution = ctx.db.rosterExecution.runId.find(membership.runId);
      if (execution) {
        const runTasks = [...ctx.db.rosterTaskDefinition.runId.filter(execution.runId)];
        runTasks.sort((left, right) => {
          const leftTerminal = TERMINAL_ROSTER_TASK_STATUSES.has(left.status);
          const rightTerminal = TERMINAL_ROSTER_TASK_STATUSES.has(right.status);
          if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
          const leftUpdated = left.updatedAt.microsSinceUnixEpoch;
          const rightUpdated = right.updatedAt.microsSinceUnixEpoch;
          return leftUpdated < rightUpdated ? 1 : leftUpdated > rightUpdated ? -1 : left.taskId.localeCompare(right.taskId);
        });
        const selected = new Set(runTasks.slice(0, CODING_TASK_WINDOW_ROWS).map((task) => task.id));
        const runEdges = [...ctx.db.rosterTaskEdge.runId.filter(execution.runId)]
          .filter((edge) => selected.has(edge.taskKey) && selected.has(edge.prerequisiteTaskKey))
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, CODING_TASK_EDGE_WINDOW_ROWS);
        rows.push(...runEdges);
      }
    }
    return rows;
  }
);

export const myCodingRunTaskOutputReferencesWindow = spacetimedb.view(
  { name: "my_coding_run_task_output_references_window", public: true },
  t.array(codingTaskOutputReferenceProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      const execution = ctx.db.rosterExecution.runId.find(membership.runId);
      if (execution) {
        const runTasks = [...ctx.db.rosterTaskDefinition.runId.filter(execution.runId)];
        runTasks.sort((left, right) => {
          const leftTerminal = TERMINAL_ROSTER_TASK_STATUSES.has(left.status);
          const rightTerminal = TERMINAL_ROSTER_TASK_STATUSES.has(right.status);
          if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
          const leftUpdated = left.updatedAt.microsSinceUnixEpoch;
          const rightUpdated = right.updatedAt.microsSinceUnixEpoch;
          return leftUpdated < rightUpdated ? 1 : leftUpdated > rightUpdated ? -1 : left.taskId.localeCompare(right.taskId);
        });
        const selected = new Set(runTasks.slice(0, CODING_TASK_WINDOW_ROWS).map((task) => task.id));
        const references = [...ctx.db.rosterTaskOutputReference.runId.filter(execution.runId)]
          .filter((reference) => selected.has(reference.taskKey))
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, CODING_TASK_OUTPUT_REFERENCE_WINDOW_ROWS);
        rows.push(...references.map((reference) => ({
          id: reference.id,
          runId: reference.runId,
          taskKey: reference.taskKey,
          taskId: reference.taskId,
          outcomeId: reference.outcomeId,
          artifactId: reference.artifactId,
          outputKey: reference.outputKey,
          createdAt: reference.createdAt,
        })));
      }
    }
    return rows;
  }
);

export const myReceipts = spacetimedb.view(
  { name: "my_receipts", public: true },
  t.array(receiptProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      if (membership.role === "viewer") continue;
      for (const event of ctx.db.receipt.runId.filter(membership.runId)) {
        rows.push({
          id: event.id,
          runId: event.runId,
          seq: event.seq,
          eventId: event.eventId,
          kind: event.kind,
          actor: event.actor,
          agentId: event.agentId,
          payloadJson: event.payloadJson,
          prevHash: event.prevHash,
          hash: event.hash,
          createdAt: event.createdAt,
        });
      }
    }
    rows.sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
    return rows;
  }
);

export const myScenePatches = spacetimedb.view(
  { name: "my_scene_patches", public: true },
  t.array(scenePatchProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      // Full patch JSON, content references, and task keys are worker/operator
      // data. Viewers render the sanitized scene-object projection instead.
      if (membership.role === "viewer") continue;
      for (const patch of ctx.db.scenePatch.runId.filter(membership.runId)) {
        const data = ctx.db.scenePatchData.patchId.find(patch.patchId);
        rows.push({
          patchId: patch.patchId,
          runId: patch.runId,
          partId: patch.partId,
          planVersion: data?.planVersion ?? "",
          agentId: patch.agentId,
          taskKey: patch.taskKey,
          taskId: data?.taskId ?? "",
          supersedesPatchId: patch.supersedesPatchId,
          contentRef: patch.contentRef,
          contentHash: patch.contentHash,
          updateHash: data?.updateHash ?? "",
          baseSceneHash: data?.baseSceneHash ?? "",
          patchJson: data?.patchJson ?? "{}",
          objectCount: patch.objectCount,
          active: data?.active ?? true,
          createdAt: patch.createdAt,
        });
      }
    }
    return rows;
  }
);

/**
 * Browser-safe, caller-scoped Canvas views. A viewer capability only creates a
 * run membership; it never exposes the capability verifier, worker leases,
 * model accounting, member identities, or the full orchestration receipt log.
 */
export const myCanvasRunUi = spacetimedb.view(
  { name: "my_canvas_run_ui", public: true },
  t.array(canvasRunUiProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      const run = ctx.db.canvasRun.id.find(membership.runId);
      if (!run) continue;
      const detail = ctx.db.canvasRunDetail.runId.find(run.id);
      rows.push({
        id: run.id,
        prompt: run.prompt,
        status: run.status,
        uiStatus: detail?.uiStatus ?? run.status,
        statusNote: detail?.statusNote ?? "",
        desiredAgents: run.desiredAgents,
        maxInflight: run.maxInflight,
        sceneHash: run.sceneHash,
        objectCount: run.objectCount,
        modelRoutingJson: detail?.modelRoutingJson ?? "{}",
        configJson: detail?.configJson ?? "{}",
        workflowId: detail?.workflowId ?? "",
        workflowVersion: detail?.workflowVersion ?? "",
        planVersion: detail?.planVersion ?? "",
        reviewSceneHash: detail?.reviewSceneHash ?? "",
        reviewVerdict: detail?.reviewVerdict ?? "",
        qualityStatus: detail?.qualityStatus ?? "",
        totalTasks: detail?.totalTasks ?? 0,
        completedTasks: detail?.completedTasks ?? 0,
        createdAt: run.createdAt,
        updatedAt: detail?.updatedAt ?? run.updatedAt,
      });
    }
    return rows;
  }
);

export const myScenePlan = spacetimedb.view(
  { name: "my_scene_plan", public: true },
  t.array(scenePlanProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      const plan = ctx.db.scenePlan.runId.find(membership.runId);
      if (!plan) continue;
      rows.push({
        runId: plan.runId,
        planVersion: plan.planVersion,
        planHash: plan.planHash,
        schemaVersion: plan.schemaVersion,
        width: plan.width,
        height: plan.height,
        painterCount: plan.painterCount,
        subject: plan.subject,
        artDirection: plan.artDirection,
        focalBoundsJson: plan.focalBoundsJson,
        anchorsJson: plan.anchorsJson,
        paletteJson: plan.paletteJson,
        partsJson: plan.partsJson,
        planJson: plan.planJson,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      });
    }
    return rows;
  }
);

export const myScenePlanParts = spacetimedb.view(
  { name: "my_scene_plan_parts", public: true },
  t.array(scenePlanPartProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      for (const part of ctx.db.scenePlanPart.runId.filter(membership.runId)) {
        rows.push({
          id: part.id,
          runId: part.runId,
          partId: part.partId,
          planVersion: part.planVersion,
          ordinal: part.ordinal,
          kind: part.kind,
          role: part.role,
          label: part.label,
          artistName: part.artistName,
          focus: part.focus,
          objective: part.objective,
          compositionRole: part.compositionRole,
          paintMode: part.paintMode,
          coordinatesWithJson: part.coordinatesWithJson,
          needsJson: part.needsJson,
          outputKey: part.outputKey,
          regionJson: part.regionJson,
          maxFootprintJson: part.maxFootprintJson,
          protectedAnchorsJson: part.protectedAnchorsJson,
          allowBleed: part.allowBleed,
          layerBase: part.layerBase,
          minObjects: part.minObjects,
          maxObjects: part.maxObjects,
          createdAt: part.createdAt,
        });
      }
    }
    return rows;
  }
);

export const myCanvasAgents = spacetimedb.view(
  { name: "my_canvas_agents", public: true },
  t.array(canvasAgentProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      const viewer = membership.role === "viewer";
      for (const agent of ctx.db.canvasAgent.runId.filter(membership.runId)) {
        rows.push({
          id: agent.id,
          runId: agent.runId,
          agentId: agent.agentId,
          name: agent.name,
          role: agent.role,
          group: agent.group,
          focus: agent.focus,
          assignment: agent.assignment,
          model: agent.model,
          status: agent.status,
          taskId: agent.taskId,
          metadataJson: viewer ? "{}" : agent.metadataJson,
          createdAt: agent.createdAt,
          updatedAt: agent.updatedAt,
        });
      }
    }
    return rows;
  }
);

export const myCanvasTaskStatuses = spacetimedb.view(
  { name: "my_canvas_task_statuses", public: true },
  t.array(canvasTaskStatusProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      const viewer = membership.role === "viewer";
      for (const task of ctx.db.canvasTaskStatus.runId.filter(membership.runId)) {
        rows.push({
          id: task.id,
          runId: task.runId,
          taskId: task.taskId,
          delegationId: task.delegationId,
          agentId: task.agentId,
          capability: task.capability,
          objective: task.objective,
          parentTaskId: task.parentTaskId,
          planId: task.planId,
          planVersion: task.planVersion,
          status: task.status,
          attempt: task.attempt,
          needsJson: task.needsJson,
          providesJson: task.providesJson,
          inputVersionsJson: viewer ? "{}" : task.inputVersionsJson,
          artifactIdsJson: viewer ? "[]" : task.artifactIdsJson,
          error: viewer && task.error ? "Task failed" : task.error,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        });
      }
    }
    return rows;
  }
);

export const mySceneObjects = spacetimedb.view(
  { name: "my_scene_objects", public: true },
  t.array(sceneObjectProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      const viewer = membership.role === "viewer";
      for (const object of ctx.db.sceneObject.runId.filter(membership.runId)) {
        rows.push({
          id: object.id,
          runId: object.runId,
          patchId: object.patchId,
          objectId: object.objectId,
          semanticId: object.semanticId,
          ownerAgentId: object.ownerAgentId,
          taskId: viewer ? "" : object.taskId,
          partId: object.partId,
          objectType: object.objectType,
          geometryJson: object.geometryJson,
          styleJson: object.styleJson,
          layer: object.layer,
          rank: object.rank,
          active: object.active,
          createdAt: object.createdAt,
          updatedAt: object.updatedAt,
        });
      }
    }
    return rows;
  }
);

export const mySceneReviews = spacetimedb.view(
  { name: "my_scene_reviews", public: true },
  t.array(sceneReviewProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      for (const review of ctx.db.sceneReview.runId.filter(membership.runId)) {
        rows.push({
          id: review.id,
          runId: review.runId,
          sceneHash: review.sceneHash,
          agentId: review.agentId,
          verdict: review.verdict,
          qualityStatus: review.qualityStatus,
          scope: review.scope,
          scoresJson: review.scoresJson,
          checksJson: review.checksJson,
          notesJson: review.notesJson,
          createdAt: review.createdAt,
        });
      }
    }
    return rows;
  }
);

export const myCanvasActivity = spacetimedb.view(
  { name: "my_canvas_activity", public: true },
  t.array(canvasActivityProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      for (const activity of ctx.db.canvasActivity.runId.filter(membership.runId)) {
        rows.push({
          id: activity.id,
          runId: activity.runId,
          seq: activity.seq,
          kind: activity.kind,
          agentId: activity.agentId,
          agentName: activity.agentName,
          summary: activity.summary,
          createdAt: activity.createdAt,
        });
      }
    }
    rows.sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
    return rows;
  }
);

/**
 * Complete, ordered, caller-scoped Canvas-event replay metadata for the public Canvas UI.
 * Unlike canvas_activity this view is not a rolling presentation cache: it is
 * derived from the private receipt chain after excluding access/accounting
 * control rows, and it never exposes raw
 * receipt payloads or operator identities.
 */
export const myCanvasReplaySteps = spacetimedb.view(
  { name: "my_canvas_replay_steps", public: true },
  t.array(canvasReplayStepProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.runMember.member.filter(ctx.sender)) {
      for (const event of ctx.db.receipt.runId.filter(membership.runId)) {
        if (!CANVAS_REPLAY_KINDS.has(event.kind)) continue;
        const fields = canvasReplayFields(event.kind, event.payloadJson);
        rows.push({
          id: event.id,
          runId: event.runId,
          seq: event.seq,
          kind: event.kind,
          agentId: event.agentId,
          label: fields.label,
          patchId: fields.patchId,
          supersedesPatchId: fields.supersedesPatchId,
          partId: fields.partId,
          status: fields.status,
          objectCount: fields.objectCount,
          createdAt: event.createdAt,
        });
      }
    }
    rows.sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
    return rows;
  }
);

export const myClaimableRosterTasks = spacetimedb.view(
  { name: "my_claimable_roster_tasks", public: true },
  t.array(rosterTaskProjection),
  (ctx) => {
    const rows = [];
    for (const membership of ctx.db.rosterWorkspaceMember.member.filter(ctx.sender)) {
      if (membership.role !== "owner" && membership.role !== "worker" && membership.role !== "coordinator") continue;
      for (const execution of ctx.db.rosterExecution.workspaceId.filter(membership.workspaceId)) {
        if (TERMINAL_ROSTER_EXECUTION_STATUSES.has(execution.status)) continue;
        const policy = parseRosterExecutionPolicy(execution.policyJson);
        if (execution.inflightTasks >= policy.maxInflight) continue;
        for (const task of ctx.db.rosterTaskDefinition.runId.filter(execution.runId)) {
          if (task.status !== "ready" || task.attempt >= task.maxAttempts) continue;
          if (
            membership.role !== "owner"
            && !ctx.db.rosterWorkerCapability.id.find(workerCapabilityKey(task.runId, ctx.sender, "*"))
            && !ctx.db.rosterWorkerCapability.id.find(
              workerCapabilityKey(task.runId, ctx.sender, task.capability)
            )
          ) continue;
          rows.push({
            id: task.id,
            runId: task.runId,
            taskId: task.taskId,
            semanticKey: task.semanticKey,
            definitionHash: task.definitionHash,
            definitionJson: task.definitionJson,
            nodeId: task.nodeId,
            capability: task.capability,
            objective: task.objective,
            status: task.status,
            parentTaskId: task.parentTaskId,
            depth: task.depth,
            attempt: task.attempt,
            maxAttempts: task.maxAttempts,
            leaseOwner: task.leaseOwner,
            leaseFence: task.leaseFence,
            leaseUntil: task.leaseUntil,
            availableAt: task.availableAt,
            lastError: task.lastError,
            outcomeId: task.outcomeId,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          });
        }
      }
    }
    return rows;
  }
);
