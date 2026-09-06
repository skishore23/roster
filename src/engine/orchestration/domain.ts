import type {
  DomainCapability,
  DomainPack,
  DomainRegistry,
  OrchestrationLimits,
  WorkspaceNode,
} from "./types.js";
import { normalizeWorkspaceNode } from "../workspace/node.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const assertId = (kind: string, value: string): void => {
  if (!ID_PATTERN.test(value)) throw new Error(`Invalid ${kind} id "${value}"`);
};

const normalizeLimit = (name: keyof OrchestrationLimits, value: number): number => {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`Domain limit ${name} must be a positive finite number`);
  }
  return Math.floor(value);
};

const cloneNode = (node: WorkspaceNode): WorkspaceNode => normalizeWorkspaceNode(node);

const clonePack = (pack: DomainPack): DomainPack => ({
  ...pack,
  capabilities: pack.capabilities.map((capability) => ({ ...capability })),
  nodes: pack.nodes.map(cloneNode),
  limits: {
    maxNodes: normalizeLimit("maxNodes", pack.limits.maxNodes),
    maxTasks: normalizeLimit("maxTasks", pack.limits.maxTasks),
    maxParallel: normalizeLimit("maxParallel", pack.limits.maxParallel),
    maxDepth: normalizeLimit("maxDepth", pack.limits.maxDepth),
  },
});

const validatePack = (pack: DomainPack): void => {
  assertId("domain", pack.id);
  assertId("coordinator", pack.coordinatorId);
  if (!pack.version.trim()) throw new Error(`Domain ${pack.id} requires a version`);
  if (!pack.policyVersion.trim()) throw new Error(`Domain ${pack.id} requires a policy version`);
  if (pack.nodes.length > pack.limits.maxNodes) {
    throw new Error(`Domain ${pack.id} configures ${pack.nodes.length} nodes above maxNodes=${pack.limits.maxNodes}`);
  }

  const capabilityIds = new Set<string>();
  for (const capability of pack.capabilities) {
    assertId("capability", capability.id);
    if (!capability.description.trim()) throw new Error(`Capability ${capability.id} requires a description`);
    if (capabilityIds.has(capability.id)) throw new Error(`Duplicate capability id "${capability.id}"`);
    capabilityIds.add(capability.id);
  }

  const byNode = new Map<string, WorkspaceNode>();
  for (const node of pack.nodes) {
    assertId("workspace node", node.id);
    if (!node.name.trim()) throw new Error(`Workspace node ${node.id} requires a name`);
    if (byNode.has(node.id)) throw new Error(`Duplicate workspace node id "${node.id}"`);
    if (node.capabilities.length === 0) {
      throw new Error(`Workspace node ${node.id} requires at least one capability`);
    }
    for (const capabilityId of node.capabilities) {
      if (!capabilityIds.has(capabilityId)) {
        throw new Error(`Workspace node ${node.id} references unknown capability "${capabilityId}"`);
      }
    }
    byNode.set(node.id, node);
  }

  if (!byNode.has(pack.coordinatorId)) {
    throw new Error(`Domain ${pack.id} coordinator ${pack.coordinatorId} is not configured`);
  }

  for (const node of pack.nodes) {
    if (node.parentId && !byNode.has(node.parentId)) {
      throw new Error(`Workspace node ${node.id} references unknown parent ${node.parentId}`);
    }
    const visited = new Set<string>([node.id]);
    let parentId = node.parentId;
    let depth = 0;
    while (parentId) {
      depth += 1;
      if (depth > pack.limits.maxDepth) {
        throw new Error(`Workspace node ${node.id} exceeds maxDepth=${pack.limits.maxDepth}`);
      }
      if (visited.has(parentId)) throw new Error(`Workspace node hierarchy contains a cycle at ${parentId}`);
      visited.add(parentId);
      parentId = byNode.get(parentId)?.parentId;
    }
  }
};

export const createDomainRegistry = (input: DomainPack): DomainRegistry => {
  const pack = clonePack(input);
  validatePack(pack);
  const nodes = new Map(pack.nodes.map((node) => [node.id, node] as const));
  const capabilities = new Map(pack.capabilities.map((capability) => [capability.id, capability] as const));

  const node = (nodeId: string): WorkspaceNode => {
    const found = nodes.get(nodeId);
    if (!found) throw new Error(`Domain ${pack.id} has no workspace node "${nodeId}"`);
    return found;
  };

  const capability = (capabilityId: string): DomainCapability => {
    const found = capabilities.get(capabilityId);
    if (!found) throw new Error(`Domain ${pack.id} has no capability "${capabilityId}"`);
    return found;
  };

  const nodesFor = (capabilityId: string) => {
    capability(capabilityId);
    return pack.nodes.filter((candidate) => candidate.capabilities.includes(capabilityId));
  };
  const assertNodeAssignment = (nodeId: string, capabilityId: string) => {
    capability(capabilityId);
    const assigned = node(nodeId);
    if (!assigned.capabilities.includes(capabilityId)) {
      throw new Error(`Workspace node ${nodeId} is not authorized for capability ${capabilityId}`);
    }
    return assigned;
  };
  const extendNodes = (additionalNodes: ReadonlyArray<WorkspaceNode>) => createDomainRegistry({
    ...pack,
    nodes: [...pack.nodes, ...additionalNodes],
  });

  return {
    pack,
    node,
    nodesFor,
    assertNodeAssignment,
    extendNodes,
    capability,
  };
};
