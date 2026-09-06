import type {
  TaskBinding,
  WorkspaceNode,
  WorkspaceNodeRuntime,
  WorkspaceNodeRuntimeBinding,
  WorkspaceNodeRuntimePlacement,
} from "../orchestration/types.js";
import {
  createWorkspaceNodeRuntimeBinding,
  normalizeWorkspaceNode,
  normalizeWorkspaceNodeRuntime,
} from "../workspace/node.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type NodeRuntimeAccess = "none" | "read-only" | "workspace-write";

export type RuntimePlacementContext = {
  readonly rosterId: string;
  readonly rosterVersion: string;
  readonly runId: string;
  readonly node: WorkspaceNode;
  readonly capability: string;
  readonly task?: TaskBinding;
  readonly role?: string;
  readonly access: NodeRuntimeAccess;
  readonly workingDirectory?: string;
  readonly preferredProfileId?: string;
};

export type NodeRuntimeProfile = {
  readonly id: string;
  readonly label: string;
  readonly access: ReadonlyArray<NodeRuntimeAccess>;
  readonly runtime:
    | WorkspaceNodeRuntime
    | ((context: RuntimePlacementContext) => WorkspaceNodeRuntime);
  /** Enqueue/UI hint only. A run executes its already-resolved placement. */
  readonly available?: () => Promise<{
    readonly available: boolean;
    readonly reason?: string;
  }>;
};

export type RuntimePlacementSelection = {
  readonly profileId: string;
  readonly reason: string;
};

export type RuntimePlacementPolicy = {
  readonly version: string;
  readonly profiles: ReadonlyArray<NodeRuntimeProfile>;
  readonly select: (
    context: RuntimePlacementContext,
  ) => RuntimePlacementSelection | undefined;
};

export type ResolvedRuntimePlacement = {
  readonly rosterId: string;
  readonly rosterVersion: string;
  readonly policyVersion: string;
  readonly profileId: string;
  readonly runtime: WorkspaceNodeRuntime;
  readonly reason: string;
};

export const defineRuntimePlacementPolicy = (
  input: RuntimePlacementPolicy,
): RuntimePlacementPolicy => {
  const version = input.version.trim();
  if (!version) throw new Error("Runtime placement policy requires a version");
  const ids = new Set<string>();
  const profiles = input.profiles.map((profile) => {
    const id = profile.id.trim();
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid runtime profile id "${profile.id}"`);
    if (ids.has(id)) throw new Error(`Duplicate runtime profile ${id}`);
    ids.add(id);
    const label = profile.label.trim();
    if (!label) throw new Error(`Runtime profile ${id} requires a label`);
    const access = [...new Set(profile.access)];
    if (access.length === 0) throw new Error(`Runtime profile ${id} must allow at least one access level`);
    return { ...profile, id, label, access };
  });
  return {
    version,
    profiles,
    select: input.select,
  };
};

export const resolveRuntimePlacement = (
  policy: RuntimePlacementPolicy,
  context: RuntimePlacementContext,
): ResolvedRuntimePlacement => {
  const selection = policy.select(context);
  if (!selection) {
    throw new Error(`Runtime placement policy ${policy.version} did not select a profile for ${context.node.id}`);
  }
  const profile = policy.profiles.find((candidate) => candidate.id === selection.profileId);
  if (!profile) {
    throw new Error(`Runtime placement policy ${policy.version} selected unknown profile ${selection.profileId}`);
  }
  if (!profile.access.includes(context.access)) {
    throw new Error(`Runtime profile ${profile.id} does not allow ${context.access} access`);
  }
  const reason = selection.reason.trim();
  if (!reason) throw new Error(`Runtime placement for ${context.node.id} requires a reason`);
  const runtime = normalizeWorkspaceNodeRuntime(
    typeof profile.runtime === "function" ? profile.runtime(context) : profile.runtime,
  );
  return {
    rosterId: context.rosterId,
    rosterVersion: context.rosterVersion,
    policyVersion: policy.version,
    profileId: profile.id,
    runtime,
    reason,
  };
};

/** Apply a resolved placement without changing the logical member identity. */
export const attachRuntimePlacement = (
  node: WorkspaceNode,
  placement: ResolvedRuntimePlacement,
): WorkspaceNode => normalizeWorkspaceNode({
  ...node,
  runtime: placement.runtime,
});

export const runtimePlacementProvenance = (
  placement: ResolvedRuntimePlacement,
): WorkspaceNodeRuntimePlacement => ({
  rosterId: placement.rosterId,
  rosterVersion: placement.rosterVersion,
  policyVersion: placement.policyVersion,
  profileId: placement.profileId,
  reason: placement.reason,
});

/**
 * Persist the already-resolved profile on a runtime binding. Resumed runs use
 * this binding rather than consulting a newer placement policy.
 */
export const createRuntimePlacementBinding = (input: {
  readonly node: WorkspaceNode;
  readonly placement: ResolvedRuntimePlacement;
  readonly epoch: number;
  readonly topologyVersion: string;
  readonly sandboxId?: string;
  readonly sessionId?: string;
}): WorkspaceNodeRuntimeBinding => createWorkspaceNodeRuntimeBinding({
  nodeId: input.node.id,
  runtime: input.placement.runtime,
  epoch: input.epoch,
  topologyVersion: input.topologyVersion,
  ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}),
  ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  placement: runtimePlacementProvenance(input.placement),
});
