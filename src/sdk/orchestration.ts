/** Stable task-graph and Roster orchestration surface. */
export {
  createRosterRootTask,
  defineRosterPlatform,
  MAX_ROSTER_CONSULTATION_RECIPIENTS,
  preserveRosterTaskContextDurability,
  ROSTER_CONSULT_FUNCTION_ID,
  ROSTER_EXPAND_FUNCTION_ID,
  ROSTER_FUNCTION_TASK_HANDLER,
  ROSTER_NODE_CONSULTATION_SCHEMA_VERSION,
  ROSTER_NODE_TASK_HANDLER,
  ROSTER_WORKSPACE_PUBLISH_FUNCTION_ID,
  ROSTER_WORKSPACE_READ_FUNCTION_ID,
  RosterPlatform,
  RosterPlatformExecution,
} from "../engine/platform/roster-platform.js";
export type {
  RosterExpansionProposal,
  RosterExpansionTaskProposal,
  RosterNodeConsultation,
  RosterNodeConsultationPolicy,
  RosterNodeConsultationRecipient,
  RosterPlatformDefinition,
  RosterPlatformExecutionOptions,
  RosterTaskContextFactory,
  RosterWorkerRegistration,
} from "../engine/platform/roster-platform.js";

export {
  createAcceptedTaskOutcome,
  createDefaultDynamicTaskAcceptanceRegistry,
  createDynamicTaskDefinition,
  defaultTaskResultContract,
  DynamicTaskAcceptanceRegistry,
  DynamicTaskDispatcher,
  DynamicTaskHandlerRegistry,
  DynamicTaskSchedulingError,
  evaluateTaskJoin,
  validateDynamicTaskDefinition,
} from "../engine/orchestration/task-graph.js";
export type {
  DynamicTaskAcceptance,
  DynamicTaskDispatcherOptions,
  DynamicTaskHandler,
  DynamicTaskHandlerContext,
  DynamicTaskReadyBatchEntry,
  DynamicTaskReadyBatchRunner,
  DynamicTaskTransitionCheckpoint,
  DynamicTaskTransitionPhase,
  TaskGraphExpansion,
  TaskGraphExpansionInput,
  TaskGraphLease,
  TaskGraphQuiescence,
  TaskGraphSnapshot,
  TaskGraphTaskRecord,
  TaskGraphTaskStatus,
} from "../engine/orchestration/task-graph.js";

export {
  InMemoryTaskGraphControl,
  taskGraphDependencyDataReferences,
  taskGraphQuiescence,
  taskGraphReady,
  taskGraphTask,
} from "../engine/orchestration/task-graph-control.js";
export type {
  TaskGraphAcceptInput,
  TaskGraphCancelInput,
  TaskGraphClaimInput,
  TaskGraphControl,
  TaskGraphControlInitialization,
  TaskGraphControlSnapshot,
  TaskGraphFailInput,
  TaskGraphOutcomeDataReference,
  TaskGraphProviderCallDispatch,
} from "../engine/orchestration/task-graph-control.js";

export { materializeNodeDemand, reflectOnOrchestration } from "../engine/orchestration/adaptive.js";
export type {
  AdaptationAction,
  AdaptiveReflectionInput,
  NodeDemand,
  ReflectionDecision,
  ReflectionObservation,
} from "../engine/orchestration/adaptive.js";

export type {
  AcceptedArtifactReference,
  AcceptedTaskOutcome,
  DataReference,
  DynamicTaskDefinition,
  ExecutionTraceContext,
  RunExecutionPolicy,
  TaskAcceptanceReference,
  TaskDependency,
  TaskHandlerReference,
  TaskInputManifest,
  TaskJoinPolicy,
  TaskResultContract,
  TaskRetryPolicy,
} from "../engine/platform/protocol.js";

export {
  assertTaskExecutionGrant,
  assertTaskExecutionGrantTool,
  assertTaskExecutionGrantWorkspaceOperation,
  createTaskExecutionGrant,
  ROSTER_TASK_ADMISSION_DECISION_VERSION,
  ROSTER_TASK_EXECUTION_GRANT_VERSION,
  ROSTER_TASK_RISK_ASSESSMENT_VERSION,
  validateTaskExecutionGrant,
} from "../engine/platform/execution-grant.js";
export type {
  CreateTaskExecutionGrantInput,
  TaskAdmissionDecision,
  TaskExecutionGrant,
  TaskExecutionGrantCodeMode,
  TaskExecutionGrantSkill,
  TaskExecutionGrantTool,
  TaskExecutionRiskClass,
  TaskRiskAssessment,
} from "../engine/platform/execution-grant.js";
