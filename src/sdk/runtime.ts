/** Stable runtime attachment, placement, and execution surface. */
export {
  createDefaultNodeRuntimeRegistry,
  createNodeExecutionCodeMode,
  createNodeExecutionImageAttachment,
  createNodeExecutionSkill,
  createNodeExecutionSurface,
  MAX_NODE_EXECUTION_IMAGE_ATTACHMENTS,
  MAX_NODE_EXECUTION_IMAGE_BYTES,
  MAX_NODE_EXECUTION_IMAGE_BYTES_TOTAL,
  MAX_NODE_EXECUTION_SKILLS,
  NODE_EXECUTION_CODE_MODE_SCHEMA_VERSION,
  NODE_EXECUTION_SCHEMA_VERSION,
  NODE_EXECUTION_SURFACE_SCHEMA_VERSION,
  NodeRuntimeRegistry,
  rosterNativeNodeRuntime,
} from "../engine/runtime/node-runtime.js";
export type {
  NodeExecutionAcceptedArtifactDescriptor,
  NodeExecutionArtifactReference,
  NodeExecutionAttachment,
  NodeExecutionAttachmentInput,
  NodeExecutionCodeMode,
  NodeExecutionCodeModeOptions,
  NodeExecutionEnvelope,
  NodeExecutionInputManifest,
  NodeExecutionInputReferenceDescriptor,
  NodeExecutionRequest,
  NodeExecutionResolvedDataReference,
  NodeExecutionResult,
  NodeExecutionSkill,
  NodeExecutionSurface,
  NodeExecutionSurfaceInput,
  NodeExecutionUsage,
  NodeRuntimeAdapter,
  NodeRuntimeAdapterView,
  NodeRuntimeExecutionControl,
} from "../engine/runtime/node-runtime.js";

export { createCommandNodeRuntimeAdapter } from "../engine/runtime/command-node-runtime.js";
export type {
  CommandExecution,
  CommandExecutionResult,
  CommandNodeRuntimeOptions,
  CommandRunner,
} from "../engine/runtime/command-node-runtime.js";

export {
  createClaudeCodeNodeRuntimeAdapter,
  createCodexCliNodeRuntimeAdapter,
  createHermesAgentNodeRuntimeAdapter,
  createPiAgentNodeRuntimeAdapter,
} from "../engine/runtime/agent-cli-node-runtime.js";
export type {
  AgentCliRuntimeOptions,
  AgentCliTrajectoryLocator,
  AgentCliTrajectoryOptions,
  PiProjectTrust,
} from "../engine/runtime/agent-cli-node-runtime.js";

export { createA2ANodeRuntimeAdapter } from "../engine/runtime/a2a-node-runtime.js";
export type { A2AFetch, A2ANodeRuntimeOptions } from "../engine/runtime/a2a-node-runtime.js";

export {
  createRosterFunctionExecutionPlane,
  ROSTER_CATALOG_INVOKE_FUNCTION_ID,
  ROSTER_CATALOG_SEARCH_FUNCTION_ID,
} from "../engine/runtime/node-function-plane.js";
export type { RosterFunctionExecutionPlane } from "../engine/runtime/node-function-plane.js";

export {
  bindRosterMemoryFunctionProviders,
  createCompositeRosterMemoryRepository,
  createDocumentRosterMemoryRepository,
  createRosterMemoryFunctionDescriptors,
  rosterMemoryDocument,
  ROSTER_MEMORY_DIFF_FUNCTION_ID,
  ROSTER_MEMORY_OPEN_FUNCTION_ID,
  ROSTER_MEMORY_PROPOSE_FUNCTION_ID,
  ROSTER_MEMORY_SCOPE_FUNCTION_ID,
  ROSTER_MEMORY_SEARCH_FUNCTION_ID,
} from "../engine/runtime/node-memory-plane.js";
export type {
  RosterMemoryDocument,
  RosterMemoryProposalInput,
  RosterMemoryProposalResult,
  RosterMemoryRepository,
  RosterMemoryRepositoryControl,
  RosterMemoryScope,
  RosterMemoryScopeKind,
} from "../engine/runtime/node-memory-plane.js";

export {
  buildTrajectoryRollupIndex,
  createTrajectoryRollupMemoryRepository,
  trajectoryRollupStaircase,
  TRAJECTORY_ROLLUP_INDEX_SCHEMA_VERSION,
  TRAJECTORY_ROLLUP_SCHEMA_VERSION,
} from "../engine/runtime/trajectory-rollup-memory.js";
export type {
  TrajectoryRollupBlock,
  TrajectoryRollupIndex,
  TrajectoryRollupStaircaseEntry,
  TrajectoryRollupSummarizer,
  TrajectoryRollupSummarizerInput,
  TrajectoryRollupSummary,
  TrajectoryRollupSummaryChild,
} from "../engine/runtime/trajectory-rollup-memory.js";

export {
  createExtractiveTrajectoryRollupSummarizer,
  createNodeTrajectoryRollupCollector,
  EXTRACTIVE_TRAJECTORY_ROLLUP_SUMMARIZER_ID,
  EXTRACTIVE_TRAJECTORY_ROLLUP_SUMMARIZER_VERSION,
} from "../engine/runtime/node-trajectory-rollup.js";
export type {
  CreateNodeTrajectoryRollupCollectorInput,
  NodeTrajectoryRollupCollector,
} from "../engine/runtime/node-trajectory-rollup.js";

export {
  attachA2A,
  attachClaude,
  attachCodex,
  attachCommand,
  attachCustomRuntime,
  attachHermes,
  attachNative,
  attachPi,
  defineRosterMember,
  rosterAgentRuntime,
} from "../engine/runtime/agent-attachment.js";
export type {
  A2AAgentAttachment,
  ClaudeAgentAttachment,
  CodexAgentAttachment,
  CommandAgentAttachment,
  CustomAgentAttachment,
  HermesAgentAttachment,
  NativeAgentAttachment,
  PiAgentAttachment,
  RosterAgentAttachment,
  RosterMemberInput,
} from "../engine/runtime/agent-attachment.js";

export {
  attachRuntimePlacement,
  createRuntimePlacementBinding,
  defineRuntimePlacementPolicy,
  resolveRuntimePlacement,
  runtimePlacementProvenance,
} from "../engine/runtime/runtime-placement.js";
export type {
  NodeRuntimeAccess,
  NodeRuntimeProfile,
  ResolvedRuntimePlacement,
  RuntimePlacementContext,
  RuntimePlacementPolicy,
  RuntimePlacementSelection,
} from "../engine/runtime/runtime-placement.js";
