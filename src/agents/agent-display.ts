import {
  COMMAND_RUN_AGENT_IDS,
  COMMAND_WORKER_AGENT_IDS,
  getCoordinationAgentDefinition,
  getCoordinationArchitecture,
  type CommandRunAgentId,
  type CoordinationArchitectureDefinition,
} from "../engine/orchestration/architecture-catalog.js";

export { COMMAND_RUN_AGENT_IDS, COMMAND_WORKER_AGENT_IDS };

export const isCommandRunAgentId = (value: string): value is CommandRunAgentId =>
  (COMMAND_RUN_AGENT_IDS as readonly string[]).includes(value);

export const getCommandRunAgentSpec = (agentId: CommandRunAgentId): {
  readonly kind: string;
  readonly defaultStream: string;
  readonly routePath?: string;
} => {
  const definition = getCoordinationAgentDefinition(agentId);
  if (!definition?.command) throw new Error(`Agent ${agentId} is not dispatchable`);
  return { ...definition.command, routePath: definition.routePath };
};

const titleCaseWord = (value: string): string =>
  value.length <= 1 ? value.toUpperCase() : `${value[0]?.toUpperCase() ?? ""}${value.slice(1).toLowerCase()}`;

const prettifyAgentId = (agentId: string): string =>
  agentId
    .split(/[._-]+/g)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(" ");

export const getAgentDisplayName = (agentId?: string, agentName?: string): string => {
  const explicit = typeof agentName === "string" ? agentName.trim() : "";
  if (explicit) return explicit;
  const id = typeof agentId === "string" ? agentId.trim() : "";
  if (!id) return "Unknown Agent";
  if (id === "receipt-inspector") return getCoordinationAgentDefinition("inspector")?.name ?? "Replay Analyst";
  return getCoordinationAgentDefinition(id)?.name ?? prettifyAgentId(id);
};

export const getAgentCoordinationPattern = (agentId?: string): string => {
  const id = typeof agentId === "string" ? agentId.trim() : "";
  return getCoordinationAgentDefinition(id)?.coordinationLabel ?? "Custom coordination";
};

export const getAgentDescription = (agentId?: string): string => {
  const id = typeof agentId === "string" ? agentId.trim() : "";
  return getCoordinationAgentDefinition(id)?.description
    ?? "Custom Roster agent with project-defined coordination, worker behavior, and acceptance policy.";
};

export const getAgentArchitecture = (agentId: string): CoordinationArchitectureDefinition | undefined => {
  const definition = getCoordinationAgentDefinition(agentId);
  return definition ? getCoordinationArchitecture(definition.architectureId) : undefined;
};

export const getAgentDisplayMeta = (agentId?: string, agentName?: string): {
  readonly label: string;
  readonly rawId?: string;
} => {
  const rawId = typeof agentId === "string" && agentId.trim().length > 0 ? agentId.trim() : undefined;
  const label = getAgentDisplayName(rawId, agentName);
  return {
    label,
    ...(rawId && rawId !== label ? { rawId } : {}),
  };
};
