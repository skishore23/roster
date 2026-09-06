/** Stable authoring primitives for receipt-driven agents. */
export { receipt } from "./receipt.js";
export type { ReceiptBody, ReceiptDeclaration } from "./receipt.js";

export {
  defineAgent,
  defineWorkflowAgent,
  goal,
  runDefinedAgent,
  runDefinedWorkflowAgent,
} from "./agent.js";
export type {
  AgentSpec,
  RunAgentInput,
  RunWorkflowAgentInput,
  WorkflowAgentSpec,
} from "./agent.js";

export { action, assistant, human, tool } from "./actions.js";
export type { ActionKind, AgentAction } from "./actions.js";

export { merge, rebracket } from "./merge.js";
export type {
  MergeCandidate,
  MergeDecision,
  MergePolicy,
  MergeScoreVector,
} from "./merge.js";
