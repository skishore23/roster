import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (relativePath: string): Promise<string> =>
  fs.readFile(path.join(ROOT, relativePath), "utf8");

const section = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return text.slice(from, to);
};

test("Roster platform v3 is the sole durable Spacetime task-graph contract", async () => {
  const moduleSource = await read("spacetimedb/src/index.ts");
  const schemaSource = section(
    moduleSource,
    "const rosterExecution = table(",
    "const receipt = table("
  );

  for (const tableName of [
    "roster_execution",
    "roster_execution_event",
    "roster_task_definition",
    "roster_task_semantic_key",
    "roster_task_edge",
    "roster_task_join",
    "roster_task_outcome",
    "roster_task_output_reference",
    "roster_task_expansion",
    "roster_worker_capability",
  ]) {
    assert.match(schemaSource, new RegExp(`name: ["']${tableName}["']`), `missing ${tableName}`);
  }
  assert.doesNotMatch(schemaSource, /public:\s*true/, "control authority tables must remain private");
  for (const legacyName of [
    "agent_execution_run",
    "agent_task",
    "agent_run_policy",
    "agent_task_graph_node",
    "agent_task_dependency",
    "agent_task_expansion",
    "agent_worker_capability",
  ]) {
    assert.doesNotMatch(moduleSource, new RegExp(`name: ["']${legacyName}["']`));
  }
  assert.match(moduleSource, /ROSTER_PLATFORM_PROTOCOL_VERSION = "roster\.platform\.v3"/);
  assert.match(moduleSource, /coordinatorLease\.capability !== "coordinate\.canvas"/);
  assert.doesNotMatch(moduleSource, /"canvas-coordinator"/);
});

test("Spacetime does not duplicate the shared-workspace or data-reference planes", async () => {
  const sources = await Promise.all([
    read("spacetimedb/src/index.ts"),
    read("src/adapters/spacetimedb-control.ts"),
    read("src/spacetimedb-bindings/index.ts"),
    read("src/spacetimedb-bindings/types.ts"),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /shared_artifact|sharedArtifact|SharedArtifact/);
    assert.doesNotMatch(
      source,
      /publishSharedArtifactUpdate|advanceSharedArtifactFrontier|recordSharedArtifactProjection|certifySharedArtifactFrontier/,
    );
  }
});

test("Coding accepted outputs reattach with the exact persisted execution kind", async () => {
  const [serverSource, codingSource] = await Promise.all([
    read("src/server.ts"),
    read("src/agents/coding.agent.ts"),
  ]);
  const projection = section(
    serverSource,
    "const codingAcceptedOutputs = async",
    "spacetimeControlPlane.onDisconnect",
  );
  const conversationProjection = section(
    codingSource,
    "const readCodingConversationExecution = async",
    "const codingDeliveryRecoveryRequired",
  );

  assert.match(projection, /execution\.kind !== "coding" && execution\.kind !== "coding-investigation"/);
  assert.match(projection, /kind: execution\.kind/);
  assert.doesNotMatch(projection, /kind: "coding"/);
  assert.match(conversationProjection, /readCodingAcceptedOutputs\(deps\.acceptedOutputs, executionRunId\)/);
  assert.match(conversationProjection, /artifacts\[output\.artifactId\]/);
  assert.match(conversationProjection, /outputs\[output\.projectionKey\]/);
  assert.match(conversationProjection, /outputKey: output\.outputKey/);
});

test("execution admission and task publication enforce the complete bounded policy", async () => {
  const moduleSource = await read("spacetimedb/src/index.ts");
  const policy = section(
    moduleSource,
    "const parseRosterExecutionPolicy",
    "type RosterTaskDependencySpec"
  );
  const enqueue = section(
    moduleSource,
    "export const enqueueRosterTask",
    "export const expandAndDelegateRosterTask"
  );

  for (const field of [
    "maxTasks",
    "maxDepth",
    "maxFanout",
    "maxInflight",
    "maxReady",
    "maxBlocked",
    "maxAttempts",
    "maxContextBytes",
    "maxCostMicros",
    "maxTokens",
    "maxWallTimeMs",
  ]) assert.match(policy, new RegExp(`"${field}"`));

  assert.match(enqueue, /parseRosterTaskDefinition\("definitionJson"/);
  assert.match(enqueue, /existing\.definitionJson !== spec\.definitionJson/);
  assert.match(enqueue, /existing\.definitionHash !== spec\.definitionHash/);
  assert.match(moduleSource, /rosterTaskSemanticKey/);
  assert.match(moduleSource, /semantic key .* already exists/);
  assert.match(moduleSource, /execution\.contextBytes \+ spec\.contextBytes|latestExecution\.contextBytes \+ spec\.contextBytes/);
  assert.match(moduleSource, /maxReady exceeded/);
  assert.match(moduleSource, /maxBlocked exceeded/);
});

test("a durable room admits a new execution only after its prior active execution is terminal", async () => {
  const moduleSource = await read("spacetimedb/src/index.ts");
  const initialize = section(
    moduleSource,
    "export const initializeRosterExecution",
    "export const saveRosterParticipantProfile"
  );

  assert.match(initialize, /const existingActiveExecution = existingRoom\?\.activeRunId/);
  assert.match(initialize, /!TERMINAL_ROSTER_EXECUTION_STATUSES\.has\(existingActiveExecution\.status\)/);
  assert.match(initialize, /activeRunId: runId, status: "active"/);
  assert.doesNotMatch(initialize, /existingRoom\.kind !== kind/);
});

test("durable definitions validate canonical identity and bounded replay inputs", async () => {
  const moduleSource = await read("spacetimedb/src/index.ts");
  const parser = section(
    moduleSource,
    "const parseRosterTaskDefinitionValue",
    "const parseRosterTaskDefinition ="
  );

  assert.match(parser, /definitionHash !== rosterHashCanonical\(normalizedWithoutHash\)/);
  assert.match(parser, /repeats data reference/);
  assert.match(parser, /storage === "artifact"/);
  assert.match(parser, /storage === "object"/);
  assert.match(parser, /resultMode === "text" \|\| resultMode === "json"/);
  assert.match(parser, /resultMode === "artifact"/);
  assert.match(parser, /retryMaximumBackoffMs < retryInitialBackoffMs/);
  assert.doesNotMatch(parser, /retryInitialBackoffMs < 1/);
  assert.match(parser, /contextBytes: BigInt\(definitionJson\.length\) \+ referencedContextBytes/);
});

test("dynamic expansion is fence-independent on replay and atomically delegates", async () => {
  const moduleSource = await read("spacetimedb/src/index.ts");
  const expand = section(
    moduleSource,
    "export const expandAndDelegateRosterTask",
    "export const claimRosterTask"
  );

  const existingCheck = expand.indexOf("const existingExpansion");
  const leaseCheck = expand.indexOf("requireActiveRosterTaskLease");
  assert.ok(existingCheck >= 0 && leaseCheck > existingCheck, "idempotent replay must precede lease validation");
  assert.match(expand, /existingExpansion\.expansionSpecJson !== canonicalExpansionSpec/);
  assert.doesNotMatch(expand, /publicationFence !== args\.fence/);
  assert.match(expand, /childrenJson must contain at least one child/);
  assert.match(expand, /expansion exceeds maxDepth/);
  assert.match(expand, /expansion exceeds maxTasks/);
  assert.match(expand, /dependency cycle or missing dependency/);
  assert.match(expand, /continuationTaskId: continuationSpec\.taskId/);
  assert.match(expand, /status: "delegated"/);
  assert.match(expand, /leaseOwner: undefined/);
  assert.match(expand, /reservedCostMicros: afterInsert\.reservedCostMicros >= parent\.estimatedCostMicros/);
  assert.match(expand, /"task\.graph\.expanded"/);
});

test("durable continuations retire delegated parents before execution finalization", async () => {
  const moduleSource = await read("spacetimedb/src/index.ts");
  const terminalStatuses = section(
    moduleSource,
    "const TERMINAL_ROSTER_TASK_STATUSES",
    "const TERMINAL_ROSTER_EXECUTION_STATUSES",
  );
  const propagation = section(
    moduleSource,
    "const propagateRosterTerminalDisposition",
    "const promoteEligibleBlockedRosterTasks",
  );
  const finalization = section(
    moduleSource,
    "export const finalizeRosterExecution",
    "export const cancelRosterExecution",
  );

  assert.doesNotMatch(terminalStatuses, /"delegated"/);
  assert.match(propagation, /rosterTaskExpansion\.runId\.filter\(runId\)/);
  assert.match(propagation, /expansion\.continuationTaskId !== prerequisite\.taskId/);
  assert.match(propagation, /parent\.status !== "delegated"/);
  assert.match(propagation, /status: "skipped"/);
  assert.match(propagation, /continued by/);
  assert.match(propagation, /effectiveRosterTask/);
  assert.match(propagation, /acceptedDependencies:[\s\S]+effectivePrerequisite\.status === "accepted"/);
  assert.match(finalization, /settleCompletedRosterDelegations/);
  assert.match(finalization, /still has unfinished task/);
  assert.match(finalization, /has failed or canceled tasks/);
  assert.match(finalization, /deferPendingRosterRoomControlIntents/);
  assert.match(finalization, /execution wall-time limit exceeded/);
  assert.match(finalization, /repairedFrom/);
  assert.match(finalization, /status: outcome/);
});

test("only accepted outcomes satisfy success joins and impossible joins terminate", async () => {
  const moduleSource = await read("spacetimedb/src/index.ts");
  const join = section(
    moduleSource,
    "const rosterTaskJoinDisposition",
    "const promoteEligibleBlockedRosterTasks"
  );
  const failure = section(
    moduleSource,
    "export const failRosterTask",
    "export const expireRosterTaskLease"
  );

  assert.match(join, /edge\.condition === "accepted" && prerequisite\.status === "accepted"/);
  assert.match(join, /edge\.condition === "terminal" && isTerminal/);
  for (const kind of ["all-success", "all-terminal", "any-success"]) {
    assert.match(join, new RegExp(`join\\.kind === "${kind}"`));
  }
  assert.match(join, /join\.kind !== "quorum"/);
  assert.match(join, /return terminal === join\.totalDependencies \? "skipped" : "blocked"/);
  assert.match(join, /satisfied \+ \(join\.totalDependencies - terminal\) < join\.quorum/);
  assert.match(join, /pending\.push\(dependent\.id\)/, "skip disposition must propagate");
  assert.match(failure, /propagateRosterTerminalDisposition/);
});

test("accepted outcome, artifact, usage, completion, and dependent readiness commit together", async () => {
  const moduleSource = await read("spacetimedb/src/index.ts");
  const accepted = section(
    moduleSource,
    "export const acceptRosterTaskOutcome",
    "export const failRosterTask"
  );

  for (const exactField of [
    "definitionHash",
    "inputVersions",
    "frontierVersion",
    "topologyVersion",
    "catalogVersion",
    "acceptancePolicyId",
    "acceptancePolicyVersion",
  ]) assert.match(accepted, new RegExp(exactField));
  assert.match(accepted, /ctx\.db\.rosterTaskOutcome\.insert/);
  assert.match(accepted, /ctx\.db\.rosterTaskOutputReference\.insert/);
  assert.match(accepted, /appendAcceptedPeerConversation\(ctx, runId, leasedTask, \{/);
  assert.match(accepted, /const presentationText = optionalRecordString\(artifact, "presentationText", 1_600\)/);
  assert.match(accepted, /dataReferencesJson/);
  assert.match(
    accepted,
    /appendRoomTimelineEntry[\s\S]+outputKeys:/,
    "caller-visible artifact timelines must carry accepted output-key metadata",
  );
  assert.match(accepted, /outcomeId !== expectedOutcomeId/);
  assert.match(accepted, /must publish exactly one/);
  assert.match(accepted, /accepted artifacts exceed maxContextBytes/);
  assert.match(moduleSource, /const appendAcceptedPeerConversation =/);
  assert.match(moduleSource, /return "investigation-report"/);
  assert.match(moduleSource, /return "investigation-synthesis"/);
  assert.match(moduleSource, /return "announcement"/);
  assert.match(moduleSource, /return "final-result"/);
  assert.match(moduleSource, /outputKey === "implementation_report"/);
  assert.match(moduleSource, /task\.capability === "implement"/);
  assert.match(moduleSource, /\^review_\.\+_report\$/);
  assert.match(moduleSource, /task\.capability === "remediate"[\s\S]+outputKey === "final_report"/);
  assert.match(moduleSource, /task\.taskId === "coding-finalize"[\s\S]+outputKey === "final_report"/);
  assert.match(moduleSource, /const siblingInvestigators = turnKind === "investigation-report"/);
  assert.match(moduleSource, /presentationText/);
  assert.match(moduleSource, /optionalRecordString\(artifact, "presentationText", 1_600\)/);
  assert.match(moduleSource, /presentationText: optionalRecordString\(entry, "presentationText", 1_600\)/);
  assert.match(moduleSource, /protocol:agent-turn/);
  assert.match(moduleSource, /turn:\$\{turnKind\}/);
  assert.match(moduleSource, /turnKind === "response" \|\| turnKind === "investigation-synthesis" \|\| finalResult/);
  assert.match(
    moduleSource,
    /mentions: finalResult \|\| turnKind === "announcement" \|\| turnKind === "investigation-synthesis"[\s\S]+\? \["You"\][\s\S]+: recipientNodeIds\.map\(nameFor\)/,
  );
  assert.match(moduleSource, /kind: finalResult \? "system" : "agent"/);
  assert.match(accepted, /status: "accepted"/);
  assert.match(accepted, /artifactsJson:/);
  assert.match(accepted, /usageJson:/);
  assert.match(accepted, /spentCostMicros/);
  assert.match(accepted, /cachedInputTokens/);
  assert.match(accepted, /budgetTokens/);
  assert.match(accepted, /usedTokens = execution\.usedTokens \+ budgetTokens/);
  assert.match(accepted, /propagateRosterTerminalDisposition/);
  assert.match(accepted, /promoteEligibleBlockedRosterTasks/);
  assert.match(accepted, /budgetExceeded \? "budget_exhausted"/);
  assert.match(accepted, /status: "canceled"/, "budget exhaustion must disposition remaining work");
});

test("capability mutation and normalized graph projections remain caller scoped", async () => {
  const moduleSource = await read("spacetimedb/src/index.ts");
  const capabilities = section(
    moduleSource,
    "export const setRosterWorkerCapabilities",
    "export const createViewerCapability"
  );
  const normalized = section(
    moduleSource,
    "export const myRosterExecutionSummaries",
    "export const myReceipts"
  );
  const taskEdges = section(
    moduleSource,
    "export const myRosterTaskEdges",
    "export const myRosterTaskOutcomes"
  );

  assert.match(capabilities, /requireRosterCoordinator\(ctx, execution\)/);
  assert.match(capabilities, /rosterWorkspaceMember/);
  assert.doesNotMatch(capabilities, /runMember/);
  assert.doesNotMatch(moduleSource, /name: "roster_execution_snapshot"/);
  assert.match(normalized, /rosterWorkspaceMember\.member\.filter\(ctx\.sender\)/);
  for (const projection of [
    "my_roster_execution_summaries",
    "my_roster_task_edges",
    "my_roster_task_outcomes",
    "my_roster_task_expansions",
    "my_roster_task_output_references",
    "my_roster_collaboration_summaries",
  ]) {
    assert.match(normalized, new RegExp(projection));
  }
  assert.doesNotMatch(
    taskEdges,
    /membership\.role === "viewer"/,
    "viewer capabilities need the non-secret edge relation to render the read-only live DAG",
  );
});

test("Coding public task progress excludes coordinator mechanics and classifies failures safely", async () => {
  const moduleSource = await read("spacetimedb/src/index.ts");
  const publicTaskContract = section(
    moduleSource,
    "type CodingPublicTaskState",
    "const workerCapabilityProjection",
  );
  const executionWindow = section(
    moduleSource,
    "export const myCodingExecutionSummariesWindow",
    "export const myRosterControlIntents",
  );
  const taskWindow = section(
    moduleSource,
    "export const myCodingRunTasksWindow",
    "export const myCodingRunTaskEdgesWindow",
  );

  assert.match(publicTaskContract, /task\.nodeId !== "coordinator"[\s\S]+task\.capability !== "coordinate"[\s\S]+task\.capability !== "room"/);
  assert.match(publicTaskContract, /worker lease expired\|lease expired/);
  assert.match(publicTaskContract, /"worker-timeout"/);
  assert.match(publicTaskContract, /CODING_PUBLIC_FAILURE_REASONS\[category\]/);
  assert.doesNotMatch(publicTaskContract, /reason:\s*task\.lastError/);
  assert.match(executionWindow, /const publicCounts = codingUserVisibleExecutionCounts/);
  assert.match(executionWindow, /\.\.\.publicCounts/);
  assert.match(taskWindow, /const failure = codingPublicTaskFailure\(task\)/);
  assert.match(taskWindow, /failureCategory: failure\.category/);
  assert.match(taskWindow, /failureReason: failure\.reason/);
  assert.doesNotMatch(taskWindow, /lastError:/);
});

test("provider-neutral adapters expose only Roster v3 graph operations", async () => {
  const [control, bindings] = await Promise.all([
    read("src/adapters/spacetimedb-control.ts"),
    read("src/spacetimedb-bindings/index.ts"),
  ]);
  for (const operation of [
    "ensureRosterExecution",
    "enqueueRosterTask",
    "expandAndDelegateRosterTask",
    "claimRosterTask",
    "startRosterTask",
    "heartbeatRosterTask",
    "acceptRosterTaskOutcome",
    "failRosterTask",
    "cancelRosterTask",
    "cancelRosterExecution",
    "rosterSnapshot",
  ]) assert.match(control, new RegExp(operation));

  assert.doesNotMatch(`${control}\n${bindings}`, /backfillCodingRooms|backfill_coding_rooms/);
  assert.match(bindings, /EnsureRosterExecutionReducer/);
  assert.match(bindings, /ExpandAndDelegateRosterTaskReducer/);
  assert.match(bindings, /CancelRosterTaskReducer/);
  assert.match(bindings, /myRosterExecutionSummaries/);
  assert.match(bindings, /myRosterTaskOutcomes/);
  assert.match(bindings, /myRosterTaskExpansions/);
  assert.match(bindings, /myRosterTaskOutputReferences/);
});

test("Spacetime exposes a replay-complete TaskGraphControl adapter", async () => {
  const adapter = await read("src/adapters/spacetimedb-task-graph-control.ts");
  assert.match(adapter, /implements TaskGraphControl/);
  for (const operation of [
    "initialize",
    "snapshot",
    "enqueue",
    "claim",
    "start",
    "heartbeat",
    "expand",
    "accept",
    "fail",
    "cancel",
  ]) {
    assert.match(adapter, new RegExp(`async ${operation}\\(`));
  }
  assert.match(adapter, /projection\.outcomes/);
  assert.match(adapter, /projection\.expansions/);
  assert.match(adapter, /projection\.outputReferences/);
  assert.doesNotMatch(adapter, /outcomeCache|expansionCache|dataReferenceCache/);
});
