import type {
  ActionKind,
  AgentAction,
} from "../core/agent-contracts.js";

export type {
  ActionKind,
  ActionRunContext,
  AgentAction,
} from "../core/agent-contracts.js";

const mkAction = <View, EmitFn>(kind: ActionKind, id: string, spec: Omit<AgentAction<View, EmitFn>, "id" | "kind">): AgentAction<View, EmitFn> => ({
  id,
  kind,
  ...spec,
});

export const action = <View, EmitFn = (type: string, body: Record<string, unknown>) => void>(
  id: string,
  spec: Omit<AgentAction<View, EmitFn>, "id" | "kind">
): AgentAction<View, EmitFn> => mkAction("action", id, spec);

export const assistant = <View, EmitFn = (type: string, body: Record<string, unknown>) => void>(
  id: string,
  spec: Omit<AgentAction<View, EmitFn>, "id" | "kind">
): AgentAction<View, EmitFn> => mkAction("assistant", id, spec);

export const tool = <View, EmitFn = (type: string, body: Record<string, unknown>) => void>(
  id: string,
  spec: Omit<AgentAction<View, EmitFn>, "id" | "kind">
): AgentAction<View, EmitFn> => mkAction("tool", id, spec);

export const human = <View, EmitFn = (type: string, body: Record<string, unknown>) => void>(
  id: string,
  spec: Omit<AgentAction<View, EmitFn>, "id" | "kind">
): AgentAction<View, EmitFn> => mkAction("human", id, spec);
