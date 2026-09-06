import { hashCanonical } from "../../core/canonical.js";
import type {
  WorkspaceNode,
  WorkspaceNodeRuntime,
  WorkspaceNodeRuntimeBinding,
} from "../orchestration/types.js";
import { normalizeWorkspaceNodeContinuityPolicy } from "./node-continuity.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const MAX_WORKSPACE_NODE_NAME_LENGTH = 80;

export type WorkspaceNodeNameSource = "planner" | "profile" | "generated";

export type WorkspaceNodeSocialParticipant = {
  readonly nodeId: string;
  readonly displayName: string;
  readonly fullName: string;
  readonly handle: string;
  readonly role: string;
  readonly kind: "human" | "agent" | "system";
  readonly group?: string;
  readonly summary?: string;
  readonly persistent: boolean;
};

const nodeMetadataString = (node: WorkspaceNode, key: string): string | undefined => {
  const value = node.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const socialHandle = (value: string, fallback: string): string => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `@${normalized || fallback.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
};

/**
 * Projects a durable WorkspaceNode into its conversational identity. This is a
 * read model: nodeId remains the continuity key, while runtime bindings,
 * leases, sessions, and room presence may change independently.
 */
export const workspaceNodeSocialParticipant = (
  node: WorkspaceNode,
): WorkspaceNodeSocialParticipant => {
  const displayName = nodeMetadataString(node, "givenName") ?? node.name.split(",", 1)[0]?.trim() ?? node.name;
  const role = nodeMetadataString(node, "displayRole")
    ?? titleCaseNodeRole(nodeMetadataString(node, "role") ?? node.capabilities[0] ?? "participant");
  const declaredKind = nodeMetadataString(node, "participantKind");
  const kind = declaredKind === "human"
    ? "human" as const
    : declaredKind === "system" || nodeMetadataString(node, "role") === "coordinator"
      ? "system" as const
      : "agent" as const;
  return {
    nodeId: node.id,
    displayName,
    fullName: node.name,
    handle: socialHandle(displayName, node.id),
    role,
    kind,
    ...(nodeMetadataString(node, "group") ? { group: nodeMetadataString(node, "group") } : {}),
    ...(nodeMetadataString(node, "repositoryReason") ? { summary: nodeMetadataString(node, "repositoryReason") } : {}),
    persistent: node.metadata?.persistent === true,
  };
};

export const normalizeWorkspaceNodeName = (name: string): string => {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Workspace node name must not be blank");
  if (normalized.length > MAX_WORKSPACE_NODE_NAME_LENGTH) {
    throw new Error(`Workspace node name must not exceed ${MAX_WORKSPACE_NODE_NAME_LENGTH} characters`);
  }
  return normalized;
};

const titleCaseNodeRole = (value: string): string => value
  .replace(/[^A-Za-z0-9]+/g, " ")
  .trim()
  .replace(/\b\w/g, (character) => character.toUpperCase());

export const resolveWorkspaceNodeName = (input: {
  readonly name?: string;
  readonly nameSource?: Exclude<WorkspaceNodeNameSource, "generated">;
  readonly capability: string;
  readonly role?: string;
  readonly index?: number;
}): { readonly name: string; readonly source: WorkspaceNodeNameSource } => {
  if (input.name?.trim()) {
    return {
      name: normalizeWorkspaceNodeName(input.name),
      source: input.nameSource ?? "profile",
    };
  }
  const role = titleCaseNodeRole(input.role ?? input.capability) || "Worker";
  const ordinal = input.index === undefined ? "" : ` ${input.index + 1}`;
  return {
    name: normalizeWorkspaceNodeName(`${role}${role.endsWith("Agent") ? "" : " Agent"}${ordinal}`),
    source: "generated",
  };
};

export const rosterNativeRuntime = (profile?: string): WorkspaceNodeRuntime => ({
  kind: "roster-native",
  ...(profile ? { profile } : {}),
});

export const normalizeWorkspaceNodeRuntime = (
  runtime: WorkspaceNodeRuntime,
): WorkspaceNodeRuntime => {
  if (!runtime) throw new Error("Workspace node runtime must be declared explicitly");
  const normalized = runtime;
  const kind = normalized.kind.trim();
  if (!kind) throw new Error("Workspace node runtime kind must not be blank");
  if (normalized.command && normalized.command.length === 0) {
    throw new Error(`Workspace node runtime ${normalized.kind} has an empty command`);
  }
  if (normalized.kind === "shell" && !normalized.command?.length) {
    throw new Error("Shell workspace nodes require a command");
  }
  if (normalized.kind === "a2a" && !normalized.endpoint?.trim()) {
    throw new Error("A2A workspace nodes require an endpoint");
  }
  if (normalized.endpoint !== undefined && !normalized.endpoint.trim()) {
    throw new Error(`Workspace node runtime ${normalized.kind} has a blank endpoint`);
  }
  return {
    ...normalized,
    kind,
    ...(normalized.command ? { command: [...normalized.command] } : {}),
    ...(normalized.endpoint ? { endpoint: normalized.endpoint.trim() } : {}),
    ...(normalized.metadata ? { metadata: { ...normalized.metadata } } : {}),
  };
};

export const normalizeWorkspaceNode = (node: WorkspaceNode): WorkspaceNode => ({
  ...node,
  name: normalizeWorkspaceNodeName(node.name),
  capabilities: [...new Set(node.capabilities)],
  runtime: normalizeWorkspaceNodeRuntime(node.runtime),
  ...(node.continuity ? { continuity: normalizeWorkspaceNodeContinuityPolicy(node.continuity) } : {}),
  ...(node.metadata ? { metadata: { ...node.metadata } } : {}),
});

type NormalizedWorkspaceNode = Omit<WorkspaceNode, "runtime"> & {
  readonly runtime: WorkspaceNodeRuntime;
};

const normalizedWorkspaceNode = (node: WorkspaceNode): NormalizedWorkspaceNode => ({
  ...normalizeWorkspaceNode(node),
  runtime: normalizeWorkspaceNodeRuntime(node.runtime),
});

export const createWorkspaceNodeRuntimeBinding = (input: Omit<
  WorkspaceNodeRuntimeBinding,
  "bindingId"
>): WorkspaceNodeRuntimeBinding => {
  if (!ID_PATTERN.test(input.nodeId)) throw new Error(`Invalid workspace node id "${input.nodeId}"`);
  if (!Number.isInteger(input.epoch) || input.epoch < 1) {
    throw new Error(`Workspace node ${input.nodeId} runtime epoch must be a positive integer`);
  }
  if (!input.topologyVersion.trim()) {
    throw new Error(`Workspace node ${input.nodeId} runtime binding requires a topology version`);
  }
  if (input.placement) {
    if (!ID_PATTERN.test(input.placement.rosterId)) {
      throw new Error(`Invalid runtime placement roster id "${input.placement.rosterId}"`);
    }
    if (!ID_PATTERN.test(input.placement.profileId)) {
      throw new Error(`Invalid runtime placement profile id "${input.placement.profileId}"`);
    }
    if (!input.placement.rosterVersion.trim()
      || !input.placement.policyVersion.trim()
      || !input.placement.reason.trim()) {
      throw new Error(`Workspace node ${input.nodeId} runtime placement requires versions and a reason`);
    }
  }
  const normalized = {
    ...input,
    runtime: normalizeWorkspaceNodeRuntime(input.runtime),
    ...(input.placement ? {
      placement: {
        ...input.placement,
        rosterVersion: input.placement.rosterVersion.trim(),
        policyVersion: input.placement.policyVersion.trim(),
        reason: input.placement.reason.trim(),
      },
    } : {}),
  };
  return {
    ...normalized,
    bindingId: `node_binding_${hashCanonical(normalized).slice(0, 28)}`,
  };
};

export type WorkspaceNodeProjection = WorkspaceNode & {
  readonly runtime: WorkspaceNodeRuntime;
  readonly lifecycle: "active" | "retired";
  readonly binding?: WorkspaceNodeRuntimeBinding;
  readonly taskIds: ReadonlyArray<string>;
  readonly topologyId?: string;
  readonly updatedAt: number;
};

export const projectWorkspaceNodes = (input: {
  readonly nodes: Readonly<Record<string, WorkspaceNode & {
    readonly status: "active" | "retired";
    readonly updatedAt: number;
  }>>;
  readonly bindings?: Readonly<Record<string, WorkspaceNodeRuntimeBinding & { readonly updatedAt: number }>>;
  readonly tasks?: Readonly<Record<string, { readonly taskId: string; readonly nodeId: string }>>;
  readonly topologyId?: string;
}): Readonly<Record<string, WorkspaceNodeProjection>> => {
  const taskIdsByNode = new Map<string, string[]>();
  for (const task of Object.values(input.tasks ?? {})) {
    const taskIds = taskIdsByNode.get(task.nodeId) ?? [];
    taskIds.push(task.taskId);
    taskIdsByNode.set(task.nodeId, taskIds);
  }
  return Object.fromEntries(Object.values(input.nodes).map((stored) => {
    const { status, updatedAt, ...node } = stored;
    const binding = input.bindings?.[node.id];
    return [node.id, {
      ...normalizedWorkspaceNode(node),
      lifecycle: status,
      ...(binding ? { binding } : {}),
      taskIds: [...(taskIdsByNode.get(node.id) ?? [])].sort(),
      ...(input.topologyId ? { topologyId: input.topologyId } : {}),
      updatedAt: Math.max(updatedAt, binding?.updatedAt ?? 0),
    }];
  }));
};
