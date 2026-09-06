import { hashCanonical } from "../core/canonical.js";
import { base64ToBytes, bytesToBase64 } from "../core/base64.js";
import { createDomainRegistry } from "../engine/orchestration/domain.js";
import type {
  CompiledPrompt,
  DomainCapability,
  DomainPack,
  OrchestrationLimits,
  WorkspaceNode,
  WorkspaceNodeRuntimeBinding,
} from "../engine/orchestration/types.js";
import {
  createWorkspaceNodeRuntimeBinding,
  normalizeWorkspaceNode,
  projectWorkspaceNodes,
  type WorkspaceNodeProjection,
} from "../engine/workspace/node.js";
import type { ReflectionDecision } from "../engine/orchestration/adaptive.js";
import {
  compositionBracket,
  compositionLeaves,
  isCompositionContraction,
  isCompositionGraft,
  parseCompositionBracket,
  tamariNeighbors,
} from "../engine/orchestration/topology.js";
import type {
  CertifiedComposition,
  CompositionEvidence,
  CompositionProposal,
  CompositionRejectionReason,
} from "../engine/orchestration/composition.js";
import type { DistributedControlEvent } from "../engine/orchestration/distributed-control.js";
import {
  createSharedArtifactUpdate,
  SharedArtifactLedger,
} from "../engine/artifact/shared-crdt.js";
import type { RosterFunctionActivity } from "../engine/runtime/node-function-plane.js";
import type { TaskGraphTaskStatus } from "../engine/orchestration/task-graph.js";
import type { TaskGraphControlSnapshot } from "../engine/orchestration/task-graph-control.js";

export type OrchestrationTaskGraphProjection = {
  readonly runId: string;
  readonly projectionVersion: string;
  readonly tasks: ReadonlyArray<{
    readonly taskId: string;
    readonly nodeId: string;
    readonly capability: string;
    readonly objective: string;
    readonly parentTaskId?: string;
    readonly status: TaskGraphTaskStatus;
    readonly attempt: number;
    readonly dependencies: ReadonlyArray<{
      readonly taskId: string;
      readonly condition: "accepted" | "terminal";
    }>;
    readonly continuationTaskId?: string;
    readonly error?: string;
  }>;
  readonly expansions: ReadonlyArray<{
    readonly parentTaskId: string;
    readonly childTaskIds: ReadonlyArray<string>;
    readonly continuationTaskId: string;
  }>;
  readonly acceptedCostMicros: number;
  readonly acceptedTokens: number;
};

export type ArtifactPayload =
  | { readonly storage: "inline"; readonly value: string }
  | { readonly storage: "external"; readonly uri: string };

export type OrchestrationEvent =
  | DistributedControlEvent
  | {
      readonly type: "orchestration.configured";
      readonly runId: string;
      readonly domainId: string;
      readonly domainVersion: string;
      readonly policyVersion: string;
      readonly coordinatorId: string;
      readonly capabilities: ReadonlyArray<DomainCapability>;
      readonly limits: OrchestrationLimits;
      readonly nodes: ReadonlyArray<WorkspaceNode>;
    }
  | {
      readonly type: "task.graph.projected";
      readonly runId: string;
      readonly graph: OrchestrationTaskGraphProjection;
    }
  | {
      readonly type: "function.activity.recorded";
      readonly runId: string;
      readonly activity: RosterFunctionActivity;
    }
  | {
      readonly type: "node.spawned";
      readonly runId: string;
      readonly node: WorkspaceNode;
      readonly reason?: string;
    }
  | {
      readonly type: "node.retired";
      readonly runId: string;
      readonly nodeId: string;
      readonly reason: string;
    }
  | {
      readonly type: "node.runtime.bound";
      readonly runId: string;
      readonly binding: WorkspaceNodeRuntimeBinding;
    }
  | ({ readonly type: "reflection.recorded"; readonly runId: string } & ReflectionDecision)
  | {
      readonly type: "topology.selected";
      readonly runId: string;
      readonly topologyId: string;
      readonly previousTopologyId?: string;
      readonly operation: "initialize" | "graft" | "contract" | "rotate";
      readonly bracket: string;
      readonly previousBracket?: string;
      readonly leaves: ReadonlyArray<string>;
      readonly direction?: "up" | "down";
      readonly score?: number;
      readonly reason: string;
    }
  | ({ readonly type: "prompt.compiled" } & Omit<CompiledPrompt, "system" | "user">)
  | {
      readonly type: "artifact.published";
      readonly runId: string;
      readonly artifactId: string;
      readonly origin: "input" | "task";
      readonly outputKey: string;
      readonly taskId?: string;
      readonly nodeId: string;
      readonly kind: string;
      readonly contentHash: string;
      readonly inputVersions: Readonly<Record<string, string>>;
      readonly payload: ArtifactPayload;
      readonly sharedArtifactId: string;
      readonly updateId: string;
      readonly frontierVersion: string;
      readonly topologyVersion: string;
      readonly crdtUpdateBase64: string;
    }
  | {
      readonly type: "evidence.recorded";
      readonly runId: string;
      readonly taskId: string;
      readonly artifactId: string;
      readonly evidence: CompositionEvidence;
      readonly nodeId?: string;
    }
  | ({ readonly type: "composition.proposed"; readonly runId: string } & Omit<CompositionProposal, "content">)
  | ({ readonly type: "composition.certified"; readonly runId: string } & Omit<CertifiedComposition, "content">)
  | {
      readonly type: "composition.rejected";
      readonly runId: string;
      readonly compositionId: string;
      readonly proposalId?: string;
      readonly reason: CompositionRejectionReason;
      readonly detail: string;
    };

export type OrchestrationArtifactRecord = Extract<OrchestrationEvent, {
  readonly type: "artifact.published";
}> & { readonly updatedAt: number };

export type OrchestrationOutputBinding = {
  readonly outputKey: string;
  readonly artifactId: string;
  readonly contentHash: string;
  readonly origin: "input" | "task";
  readonly taskId?: string;
  readonly updatedAt: number;
};

export type OrchestrationState = {
  readonly domain?: {
    readonly id: string;
    readonly version: string;
    readonly policyVersion: string;
    readonly coordinatorId: string;
    readonly capabilities: ReadonlyArray<DomainCapability>;
    readonly limits: OrchestrationLimits;
  };
  readonly taskGraph?: OrchestrationTaskGraphProjection & { readonly updatedAt: number };
  readonly functionActivities: ReadonlyArray<RosterFunctionActivity & { readonly updatedAt: number }>;
  readonly nodes: Readonly<Record<string, WorkspaceNode & { readonly status: "active" | "retired"; readonly updatedAt: number }>>;
  readonly nodeBindings: Readonly<Record<string, WorkspaceNodeRuntimeBinding & { readonly updatedAt: number }>>;
  readonly reflections: ReadonlyArray<Extract<OrchestrationEvent, { readonly type: "reflection.recorded" }> & { readonly updatedAt: number }>;
  readonly topologies: Readonly<Record<string, Extract<OrchestrationEvent, { readonly type: "topology.selected" }> & { readonly updatedAt: number }>>;
  readonly topologyId?: string;
  readonly prompts: Readonly<Record<string, Omit<CompiledPrompt, "system" | "user"> & { readonly updatedAt: number }>>;
  readonly artifacts: Readonly<Record<string, OrchestrationArtifactRecord>>;
  readonly outputs: Readonly<Record<string, OrchestrationOutputBinding>>;
  readonly evidence: Readonly<Record<string, Extract<OrchestrationEvent, { readonly type: "evidence.recorded" }> & { readonly updatedAt: number }>>;
  readonly proposals: Readonly<Record<string, Omit<CompositionProposal, "content"> & { readonly updatedAt: number }>>;
  readonly compositions: Readonly<Record<string, Omit<CertifiedComposition, "content"> & { readonly updatedAt: number }>>;
  readonly conflicts: ReadonlyArray<Extract<OrchestrationEvent, { readonly type: "composition.rejected" }> & { readonly updatedAt: number }>;
};

export const initialOrchestrationState: OrchestrationState = {
  functionActivities: [],
  nodes: {},
  nodeBindings: {},
  reflections: [],
  topologies: {},
  prompts: {},
  artifacts: {},
  outputs: {},
  evidence: {},
  proposals: {},
  compositions: {},
  conflicts: [],
};

const EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "orchestration.configured",
  "task.graph.projected",
  "function.activity.recorded",
  "node.spawned",
  "node.retired",
  "node.runtime.bound",
  "reflection.recorded",
  "topology.selected",
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

export const isOrchestrationEvent = (event: { readonly type: string }): event is OrchestrationEvent =>
  EVENT_TYPES.has(event.type as OrchestrationEvent["type"]);

const validateReflection = (
  state: OrchestrationState,
  event: Extract<OrchestrationEvent, { readonly type: "reflection.recorded" }>
): void => {
  if (!state.domain) throw new Error(`Reflection ${event.reflectionId} requires an orchestration domain`);
  const expectedId = `reflection_${hashCanonical({
    runId: event.runId,
    policyId: event.policyId,
    policyVersion: event.policyVersion,
    iteration: event.iteration,
    observation: event.observation,
    actions: event.actions,
  }).slice(0, 24)}`;
  if (event.reflectionId !== expectedId) throw new Error(`Reflection ${event.reflectionId} has an invalid identity`);
  if (!Number.isInteger(event.iteration) || event.iteration < 1) {
    throw new Error(`Reflection ${event.reflectionId} has an invalid iteration`);
  }
  const counts = [
    event.observation.activeNodes,
    event.observation.pendingTasks,
    event.observation.runningTasks,
    event.observation.failedTasks,
    event.observation.conflicts,
    event.observation.evidenceGaps,
    event.observation.stagnationRounds,
  ];
  if (counts.some((count) => !Number.isInteger(count) || count < 0)) {
    throw new Error(`Reflection ${event.reflectionId} has invalid observation counts`);
  }
  if (
    event.observation.confidence !== undefined
    && (!Number.isFinite(event.observation.confidence)
      || event.observation.confidence < 0
      || event.observation.confidence > 1)
  ) {
    throw new Error(`Reflection ${event.reflectionId} has invalid confidence`);
  }
  const activeNodes = Object.values(state.nodes).filter((node) => node.status === "active").length;
  if (event.observation.activeNodes !== activeNodes) {
    throw new Error(`Reflection ${event.reflectionId} observed ${event.observation.activeNodes} active nodes, expected ${activeNodes}`);
  }
  if (event.actions.length === 0) throw new Error(`Reflection ${event.reflectionId} has no action`);
  const terminalActions = event.actions.filter((action) => action.type === "stop" || action.type === "continue");
  if (terminalActions.length > 0 && event.actions.length !== 1) {
    throw new Error(`Reflection ${event.reflectionId} mixes a terminal action with adaptation`);
  }
  if (event.actions[0]?.type === "stop" && (
    !event.observation.goalSatisfied
    || event.observation.pendingTasks !== 0
    || event.observation.runningTasks !== 0
    || event.observation.failedTasks !== 0
    || event.observation.conflicts !== 0
    || event.observation.evidenceGaps !== 0
  )) {
    throw new Error(`Reflection ${event.reflectionId} cannot stop before acceptance`);
  }
  const capabilities = new Set(state.domain.capabilities.map((capability) => capability.id));
  const spawnActions = event.actions.filter((action) => action.type === "spawn");
  if (activeNodes + spawnActions.length > state.domain.limits.maxNodes) {
    throw new Error(`Reflection ${event.reflectionId} exceeds maxNodes=${state.domain.limits.maxNodes}`);
  }
  let rebrackets = 0;
  for (const action of event.actions) {
    if (action.type === "spawn") {
      const requested = [action.demand.capability, ...(action.demand.additionalCapabilities ?? [])];
      if (!action.demand.objective.trim() || requested.some((capability) => !capabilities.has(capability))) {
        throw new Error(`Reflection ${event.reflectionId} contains an invalid capability demand`);
      }
    }
    if (action.type === "retire") {
      const node = state.nodes[action.nodeId];
      if (!node || node.status !== "active" || action.nodeId === state.domain.coordinatorId) {
        throw new Error(`Reflection ${event.reflectionId} cannot retire ${action.nodeId}`);
      }
      if (
        event.observation.failedTasks !== 0
        || event.observation.conflicts !== 0
        || event.observation.evidenceGaps !== 0
      ) {
        throw new Error(`Reflection ${event.reflectionId} cannot retire work before consolidation`);
      }
    }
    if (action.type === "rebracket") {
      rebrackets += 1;
      const previousTree = parseCompositionBracket(action.previousBracket);
      const activeTopology = state.topologyId ? state.topologies[state.topologyId] : undefined;
      const valid = previousTree
        && activeTopology?.bracket === action.previousBracket
        && tamariNeighbors(previousTree, action.direction)
          .some((neighbor) => compositionBracket(neighbor.tree) === action.bracket);
      if (!valid || !Number.isFinite(action.score) || !Number.isFinite(action.gain) || action.gain <= 0) {
        throw new Error(`Reflection ${event.reflectionId} contains an invalid local rebracket`);
      }
    }
  }
  if (rebrackets > 1) throw new Error(`Reflection ${event.reflectionId} contains multiple rebrackets`);
};

export const reduceOrchestration = (
  state: OrchestrationState,
  event: OrchestrationEvent,
  ts: number
): OrchestrationState => {
  switch (event.type) {
    case "control.update.published":
    case "control.frontier.projected":
    case "control.frontier.certified":
      return state;
    case "orchestration.configured": {
      const pack = createDomainRegistry({
        id: event.domainId,
        version: event.domainVersion,
        policyVersion: event.policyVersion,
        coordinatorId: event.coordinatorId,
        capabilities: event.capabilities,
        limits: event.limits,
        nodes: event.nodes,
      }).pack;
      return {
        ...initialOrchestrationState,
        domain: {
          id: pack.id,
          version: pack.version,
          policyVersion: pack.policyVersion,
          coordinatorId: pack.coordinatorId,
          capabilities: pack.capabilities,
          limits: { ...pack.limits },
        },
        nodes: Object.fromEntries(pack.nodes.map((node) => [node.id, {
          ...node,
          capabilities: [...node.capabilities],
          status: "active" as const,
          updatedAt: ts,
        }])),
      };
    }
    case "task.graph.projected": {
      if (event.runId !== event.graph.runId) {
        throw new Error("Task graph projection run does not match its orchestration event");
      }
      const { projectionVersion, ...projectionBody } = event.graph;
      const expectedVersion = `task_graph_${hashCanonical(projectionBody).slice(0, 32)}`;
      if (projectionVersion !== expectedVersion) {
        throw new Error(`Task graph projection ${projectionVersion} has an invalid identity`);
      }
      if (event.graph.tasks.length > 512 || event.graph.expansions.length > 512) {
        throw new Error("Task graph projection exceeds the bounded read-model size");
      }
      if (new Set(event.graph.tasks.map((task) => task.taskId)).size !== event.graph.tasks.length) {
        throw new Error("Task graph projection repeats a task identity");
      }
      if (state.taskGraph?.projectionVersion === projectionVersion) return state;
      return {
        ...state,
        taskGraph: {
          ...event.graph,
          tasks: event.graph.tasks.map((task) => ({
            ...task,
            dependencies: task.dependencies.map((dependency) => ({ ...dependency })),
          })),
          expansions: event.graph.expansions.map((expansion) => ({
            ...expansion,
            childTaskIds: [...expansion.childTaskIds],
          })),
          updatedAt: ts,
        },
      };
    }
    case "function.activity.recorded": {
      const expectedId = `function_activity_${hashCanonical(
        (({ activityId: _activityId, ...activity }) => activity)(event.activity),
      ).slice(0, 32)}`;
      if (event.activity.activityId !== expectedId) {
        throw new Error(`Function activity ${event.activity.activityId} has an invalid identity`);
      }
      const existing = state.functionActivities.find((activity) =>
        activity.activityId === event.activity.activityId);
      if (existing) return state;
      return {
        ...state,
        functionActivities: [
          ...state.functionActivities,
          { ...event.activity, updatedAt: ts },
        ].slice(-500),
      };
    }
    case "node.spawned": {
      const limit = state.domain?.limits.maxNodes;
      const active = Object.values(state.nodes).filter((node) => node.status === "active").length;
      const existing = state.nodes[event.node.id];
      const addsActiveNode = !existing || existing.status !== "active";
      if (limit !== undefined && active >= limit && addsActiveNode) {
        throw new Error(`Cannot spawn ${event.node.id}: maxNodes=${limit}`);
      }
      let validatedNode = normalizeWorkspaceNode(event.node);
      if (state.domain) {
        if (existing) {
          const { status: _status, updatedAt: _updatedAt, ...existingNode } = existing;
          if (hashCanonical(existingNode) !== hashCanonical(validatedNode)) {
            throw new Error(`Workspace node ${event.node.id} changed while being reactivated`);
          }
        }
        const configuredNodes = Object.values(state.nodes)
          .filter((node) => node.id !== event.node.id)
          .map(({ status: _status, updatedAt: _updatedAt, ...node }) => node);
        const registry = createDomainRegistry({
          id: state.domain.id,
          version: state.domain.version,
          policyVersion: state.domain.policyVersion,
          coordinatorId: state.domain.coordinatorId,
          capabilities: state.domain.capabilities,
          nodes: [...configuredNodes, validatedNode],
          limits: {
            ...state.domain.limits,
            maxNodes: Math.max(state.domain.limits.maxNodes, configuredNodes.length + 1),
          },
        });
        validatedNode = registry.node(event.node.id);
      }
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [event.node.id]: { ...validatedNode, capabilities: [...validatedNode.capabilities], status: "active", updatedAt: ts },
        },
      };
    }
    case "node.retired": {
      const current = state.nodes[event.nodeId];
      if (!current) throw new Error(`Cannot retire unknown workspace node ${event.nodeId}`);
      if (state.domain?.coordinatorId === event.nodeId) {
        throw new Error(`Cannot retire domain coordinator ${event.nodeId}`);
      }
      return {
        ...state,
        nodes: { ...state.nodes, [event.nodeId]: { ...current, status: "retired", updatedAt: ts } },
      };
    }
    case "node.runtime.bound": {
      const current = state.nodes[event.binding.nodeId];
      if (!current || current.status !== "active") {
        throw new Error(`Cannot bind runtime for inactive or unknown workspace node ${event.binding.nodeId}`);
      }
      const { bindingId, ...bindingInput } = event.binding;
      const expected = createWorkspaceNodeRuntimeBinding(bindingInput);
      if (expected.bindingId !== bindingId) {
        throw new Error(`Workspace node ${event.binding.nodeId} has an invalid runtime binding identity`);
      }
      const existing = state.nodeBindings[event.binding.nodeId];
      if (existing?.bindingId === event.binding.bindingId) return state;
      if (existing && event.binding.epoch <= existing.epoch) {
        throw new Error(`Workspace node ${event.binding.nodeId} runtime epoch must advance beyond ${existing.epoch}`);
      }
      return {
        ...state,
        nodeBindings: {
          ...state.nodeBindings,
          [event.binding.nodeId]: { ...event.binding, updatedAt: ts },
        },
      };
    }
    case "reflection.recorded": {
      const existing = state.reflections.find((reflection) => reflection.reflectionId === event.reflectionId);
      if (existing) {
        const { updatedAt: _updatedAt, ...existingEvent } = existing;
        if (hashCanonical(existingEvent) !== hashCanonical(event)) {
          throw new Error(`Reflection ${event.reflectionId} changed after publication`);
        }
        return state;
      }
      validateReflection(state, event);
      const previous = state.reflections.at(-1);
      if (previous && event.iteration !== previous.iteration + 1) {
        throw new Error(`Reflection iteration jumped from ${previous.iteration} to ${event.iteration}`);
      }
      if (!previous && event.iteration !== 1) {
        throw new Error(`First reflection iteration must be 1, received ${event.iteration}`);
      }
      return {
        ...state,
        reflections: [...state.reflections, { ...event, updatedAt: ts }].slice(-200),
      };
    }
    case "topology.selected": {
      const { type: _type, topologyId: _topologyId, ...topologyInput } = event;
      const expectedTopologyId = `topology_${hashCanonical(topologyInput).slice(0, 24)}`;
      if (event.topologyId !== expectedTopologyId) {
        throw new Error(`Topology ${event.topologyId} has an invalid identity`);
      }
      const parsed = parseCompositionBracket(event.bracket);
      if (!parsed || compositionBracket(parsed) !== event.bracket) {
        throw new Error(`Topology ${event.topologyId} has an invalid bracket`);
      }
      const parsedLeaves = compositionLeaves(parsed);
      if (hashCanonical(parsedLeaves) !== hashCanonical(event.leaves) || new Set(event.leaves).size !== event.leaves.length) {
        throw new Error(`Topology ${event.topologyId} leaves do not match its bracket`);
      }
      const existing = state.topologies[event.topologyId];
      if (existing) {
        const { updatedAt: _updatedAt, ...existingEvent } = existing;
        if (hashCanonical(existingEvent) !== hashCanonical(event)) {
          throw new Error(`Topology ${event.topologyId} changed after publication`);
        }
        return state;
      }
      const previous = state.topologyId ? state.topologies[state.topologyId] : undefined;
      if (event.operation === "initialize") {
        if (previous || event.previousTopologyId || event.previousBracket) {
          throw new Error(`Topology ${event.topologyId} cannot initialize after another topology`);
        }
      } else {
        if (!previous || event.previousTopologyId !== previous.topologyId || event.previousBracket !== previous.bracket) {
          throw new Error(`Topology ${event.topologyId} does not extend the active topology`);
        }
        if (event.operation === "rotate") {
          const previousTree = parseCompositionBracket(previous.bracket);
          if (!previousTree || !event.direction) throw new Error(`Topology ${event.topologyId} rotation is incomplete`);
          const valid = tamariNeighbors(previousTree, event.direction)
            .some((neighbor) => compositionBracket(neighbor.tree) === event.bracket);
          if (!valid) throw new Error(`Topology ${event.topologyId} is not a valid Tamari rotation`);
          if (hashCanonical(previous.leaves) !== hashCanonical(event.leaves)) {
            throw new Error(`Topology rotation ${event.topologyId} changed the leaf frontier`);
          }
        }
        if (event.operation === "graft") {
          const previousTree = parseCompositionBracket(previous.bracket);
          if (!previousTree || !isCompositionGraft(previousTree, parsed)) {
            throw new Error(`Topology graft ${event.topologyId} must add exactly one local leaf`);
          }
        }
        if (event.operation === "contract") {
          const previousTree = parseCompositionBracket(previous.bracket);
          if (!previousTree || !isCompositionContraction(previousTree, parsed)) {
            throw new Error(`Topology contraction ${event.topologyId} must remove exactly one local leaf`);
          }
        }
      }
      return {
        ...state,
        topologies: {
          ...state.topologies,
          [event.topologyId]: { ...event, leaves: [...event.leaves], updatedAt: ts },
        },
        topologyId: event.topologyId,
      };
    }
    case "prompt.compiled": {
      const { type: _type, ...prompt } = event;
      return { ...state, prompts: { ...state.prompts, [event.promptId]: { ...prompt, updatedAt: ts } } };
    }
    case "artifact.published": {
      if (event.payload.storage === "inline" && hashCanonical(event.payload.value) !== event.contentHash) {
        throw new Error(`Artifact ${event.artifactId} content hash does not match its payload`);
      }
      const ledger = new SharedArtifactLedger<{ readonly outputKey: string; readonly value: string }>({
        update: base64ToBytes(event.crdtUpdateBase64),
      });
      try {
        const update = ledger.updates(event.sharedArtifactId).find((candidate) => candidate.updateId === event.updateId);
        const expectedTaskId = event.taskId ?? "input";
        const expectedValue = event.payload.storage === "inline" ? event.payload.value : event.payload.uri;
        const matchesReceipt = update
          && update.artifactId === event.sharedArtifactId
          && update.artifactKind === event.kind
          && update.schemaVersion === "orchestration-artifact/v1"
          && update.frontierVersion === event.frontierVersion
          && update.topologyVersion === event.topologyVersion
          && update.runId === event.runId
          && update.taskId === expectedTaskId
          && update.nodeId === event.nodeId
          && hashCanonical(update.inputVersions) === hashCanonical(event.inputVersions)
          && update.payload.outputKey === event.outputKey
          && update.payload.value === expectedValue;
        if (!matchesReceipt) {
          throw new Error(`Artifact ${event.artifactId} CRDT update does not match its receipt`);
        }
      } finally {
        ledger.destroy();
      }
      const existing = state.artifacts[event.artifactId];
      if (existing) {
        const { updatedAt: _updatedAt, ...existingEvent } = existing;
        if (hashCanonical(existingEvent) !== hashCanonical(event)) {
          throw new Error(`Artifact ${event.artifactId} changed after publication`);
        }
        return state;
      }
      if (event.origin === "task") {
        if (!event.taskId) throw new Error(`Task artifact ${event.artifactId} has no taskId`);
        const task = state.taskGraph?.tasks.find((candidate) => candidate.taskId === event.taskId);
        if (!task || task.nodeId !== event.nodeId) {
          throw new Error(`Artifact ${event.artifactId} has no producing task in the dynamic graph`);
        }
      } else if (event.taskId) {
        throw new Error(`Input artifact ${event.artifactId} cannot reference a task`);
      }
      const previous = state.outputs[event.outputKey];
      if (previous && previous.artifactId !== event.artifactId) {
        const sameTask = previous.taskId !== undefined && previous.taskId === event.taskId;
        if (previous.origin === "task" && !sameTask) {
          throw new Error(`Output ${event.outputKey} already belongs to task ${previous.taskId}`);
        }
      }
      return {
        ...state,
        artifacts: { ...state.artifacts, [event.artifactId]: { ...event, updatedAt: ts } },
        outputs: {
          ...state.outputs,
          [event.outputKey]: {
            outputKey: event.outputKey,
            artifactId: event.artifactId,
            contentHash: event.contentHash,
            origin: event.origin,
            taskId: event.taskId,
            updatedAt: ts,
          },
        },
      };
    }
    case "evidence.recorded":
      return { ...state, evidence: { ...state.evidence, [event.evidence.id]: { ...event, updatedAt: ts } } };
    case "composition.proposed": {
      const { type: _type, runId: _runId, ...proposal } = event;
      const existing = state.proposals[event.proposalId];
      if (existing && hashCanonical(existing) !== hashCanonical({ ...proposal, updatedAt: existing.updatedAt })) {
        throw new Error(`Proposal ${event.proposalId} changed after publication`);
      }
      return { ...state, proposals: { ...state.proposals, [event.proposalId]: { ...proposal, updatedAt: ts } } };
    }
    case "composition.certified": {
      const proposal = state.proposals[event.proposalId];
      const {
        type: _type,
        runId: _runId,
        certificationId: _certificationId,
        policyVersion: _policyVersion,
        ...eventProposal
      } = event;
      const proposalBody = proposal
        ? (({ updatedAt: _updatedAt, ...body }) => body)(proposal)
        : undefined;
      if (!proposalBody || hashCanonical(proposalBody) !== hashCanonical(eventProposal)) {
        throw new Error(`Composition ${event.compositionId} has no matching proposal`);
      }
      if (state.domain && event.policyVersion !== state.domain.policyVersion) {
        throw new Error(`Composition ${event.compositionId} uses policy ${event.policyVersion}, expected ${state.domain.policyVersion}`);
      }
      const existing = state.compositions[event.compositionId];
      if (existing && existing.certificationId !== event.certificationId) {
        throw new Error(`Composition ${event.compositionId} already has a different certification`);
      }
      const { type: _certType, runId: _certRunId, ...certification } = event;
      return {
        ...state,
        compositions: { ...state.compositions, [event.compositionId]: { ...certification, updatedAt: ts } },
      };
    }
    case "composition.rejected": {
      const duplicate = state.conflicts.some(({ updatedAt: _updatedAt, ...conflict }) =>
        hashCanonical(conflict) === hashCanonical(event)
      );
      return duplicate
        ? state
        : { ...state, conflicts: [...state.conflicts, { ...event, updatedAt: ts }].slice(-200) };
    }
  }
};

export const orchestrationConfiguredEvent = (
  runId: string,
  pack: DomainPack,
  limits: OrchestrationLimits = pack.limits
): Extract<OrchestrationEvent, { readonly type: "orchestration.configured" }> => ({
  type: "orchestration.configured",
  runId,
  domainId: pack.id,
  domainVersion: pack.version,
  policyVersion: pack.policyVersion,
  coordinatorId: pack.coordinatorId,
  capabilities: pack.capabilities.map((capability) => ({ ...capability })),
  limits: { ...limits },
  nodes: pack.nodes.map((node) => ({ ...node, capabilities: [...node.capabilities] })),
});

export const taskGraphProjectedEvent = (
  runId: string,
  snapshot: TaskGraphControlSnapshot,
): Extract<OrchestrationEvent, { readonly type: "task.graph.projected" }> => {
  if (snapshot.runId !== runId) {
    throw new Error(`Task graph snapshot ${snapshot.runId} does not belong to run ${runId}`);
  }
  const projectionBody = {
    runId,
    tasks: snapshot.tasks.map((record) => ({
      taskId: record.definition.taskId,
      nodeId: record.definition.nodeId,
      capability: record.definition.capability,
      objective: record.definition.objective,
      ...(record.definition.parentTaskId
        ? { parentTaskId: record.definition.parentTaskId }
        : {}),
      status: record.status,
      attempt: record.attempt,
      dependencies: record.definition.dependencies.map((dependency) => ({ ...dependency })),
      ...(record.continuationTaskId
        ? { continuationTaskId: record.continuationTaskId }
        : {}),
      ...(record.error ? { error: record.error.slice(0, 2_000) } : {}),
    })).sort((left, right) => left.taskId.localeCompare(right.taskId)),
    expansions: snapshot.expansions.map((expansion) => ({
      parentTaskId: expansion.parentTaskId,
      childTaskIds: [...expansion.childTaskIds].sort(),
      continuationTaskId: expansion.continuationTaskId,
    })).sort((left, right) => left.parentTaskId.localeCompare(right.parentTaskId)),
    acceptedCostMicros: snapshot.acceptedCostMicros,
    acceptedTokens: snapshot.acceptedTokens,
  };
  return {
    type: "task.graph.projected",
    runId,
    graph: {
      ...projectionBody,
      projectionVersion: `task_graph_${hashCanonical(projectionBody).slice(0, 32)}`,
    },
  };
};

export const functionActivityRecordedEvent = (
  runId: string,
  activity: RosterFunctionActivity,
): Extract<OrchestrationEvent, { readonly type: "function.activity.recorded" }> => ({
  type: "function.activity.recorded",
  runId,
  activity: { ...activity },
});

export const nodeRuntimeBoundEvent = (input: Omit<
  WorkspaceNodeRuntimeBinding,
  "bindingId"
> & { readonly runId: string }): Extract<OrchestrationEvent, { readonly type: "node.runtime.bound" }> => {
  const { runId, ...binding } = input;
  return {
    type: "node.runtime.bound",
    runId,
    binding: createWorkspaceNodeRuntimeBinding(binding),
  };
};

export const orchestrationWorkspaceNodes = (
  state: OrchestrationState,
): Readonly<Record<string, WorkspaceNodeProjection>> => projectWorkspaceNodes({
  nodes: state.nodes,
  bindings: state.nodeBindings,
  tasks: Object.fromEntries((state.taskGraph?.tasks ?? []).map((task) => [
    task.taskId,
    { taskId: task.taskId, nodeId: task.nodeId },
  ])),
  topologyId: state.topologyId,
});

export const reflectionRecordedEvent = (
  runId: string,
  decision: ReflectionDecision
): Extract<OrchestrationEvent, { readonly type: "reflection.recorded" }> => ({
  type: "reflection.recorded",
  runId,
  ...decision,
  actions: decision.actions.map((action) => ({ ...action })),
});

export const topologySelectedEvent = (input: Omit<
  Extract<OrchestrationEvent, { readonly type: "topology.selected" }>,
  "type" | "topologyId"
>): Extract<OrchestrationEvent, { readonly type: "topology.selected" }> => {
  const topologyId = `topology_${hashCanonical(input).slice(0, 24)}`;
  return { type: "topology.selected", topologyId, ...input, leaves: [...input.leaves] };
};

export const promptCompiledEvent = (
  compiled: CompiledPrompt
): Extract<OrchestrationEvent, { readonly type: "prompt.compiled" }> => {
  const { system: _system, user: _user, ...receipt } = compiled;
  return { type: "prompt.compiled", ...receipt };
};

type InlineArtifactEventInput = Omit<
  Extract<OrchestrationEvent, { readonly type: "artifact.published" }>,
  | "type"
  | "contentHash"
  | "payload"
  | "sharedArtifactId"
  | "updateId"
  | "frontierVersion"
  | "topologyVersion"
  | "crdtUpdateBase64"
> & {
  readonly sharedArtifactId?: string;
  readonly frontierVersion?: string;
  readonly topologyVersion?: string;
};

export const inlineArtifactPublishedEvent = (
  input: InlineArtifactEventInput,
  value: string
): Extract<OrchestrationEvent, { readonly type: "artifact.published" }> => {
  const sharedArtifactId = input.sharedArtifactId ?? `${input.runId}:${input.outputKey}`;
  const frontierVersion = input.frontierVersion ?? `frontier_${hashCanonical(input.inputVersions).slice(0, 24)}`;
  const topologyVersion = input.topologyVersion ?? "topology_root";
  const update = createSharedArtifactUpdate({
    artifactId: sharedArtifactId,
    artifactKind: input.kind,
    schemaVersion: "orchestration-artifact/v1",
    frontierVersion,
    topologyVersion,
    runId: input.runId,
    taskId: input.taskId ?? "input",
    nodeId: input.nodeId,
    inputVersions: input.inputVersions,
    payload: { outputKey: input.outputKey, value },
  });
  const ledger = new SharedArtifactLedger<{ readonly outputKey: string; readonly value: string }>();
  try {
    const encoded = ledger.add(update);
    return {
      type: "artifact.published",
      ...input,
      sharedArtifactId,
      updateId: update.updateId,
      frontierVersion,
      topologyVersion,
      crdtUpdateBase64: bytesToBase64(encoded),
      contentHash: hashCanonical(value),
      payload: { storage: "inline", value },
    };
  } finally {
    ledger.destroy();
  }
};

export const orchestrationOutputValues = (
  state: OrchestrationState
): Readonly<Record<string, string>> => {
  const outputs: Record<string, string> = {};
  for (const [key, binding] of Object.entries(state.outputs)) {
    const artifact = state.artifacts[binding.artifactId];
    if (artifact?.payload.storage === "inline") outputs[key] = artifact.payload.value;
  }
  return outputs;
};

export const compositionProposedEvent = (
  runId: string,
  proposal: CompositionProposal
): Extract<OrchestrationEvent, { readonly type: "composition.proposed" }> => {
  const { content: _content, ...receipt } = proposal;
  return { type: "composition.proposed", runId, ...receipt };
};

export const compositionCertifiedEvent = (
  runId: string,
  certification: CertifiedComposition
): Extract<OrchestrationEvent, { readonly type: "composition.certified" }> => {
  const { content: _content, ...receipt } = certification;
  return { type: "composition.certified", runId, ...receipt };
};
