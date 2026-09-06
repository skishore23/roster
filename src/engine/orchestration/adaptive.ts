import { hashCanonical } from "../../core/canonical.js";
import type { JsonValue, WorkspaceNode } from "./types.js";
import {
  rosterNativeRuntime,
  resolveWorkspaceNodeName,
  type WorkspaceNodeNameSource,
} from "../workspace/node.js";
import {
  compositionBracket,
  selectTamariRotation,
  type CompositionTree,
  type TopologySelection,
} from "./topology.js";

export type NodeDemand = {
  readonly capability: string;
  readonly objective: string;
  readonly name?: string;
  readonly nameSource?: Exclude<WorkspaceNodeNameSource, "generated">;
  readonly focus?: string;
  readonly promptProfile?: string;
  readonly group?: string;
  readonly parentId?: string;
  readonly additionalCapabilities?: ReadonlyArray<string>;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export type ReflectionObservation = {
  readonly activeNodes: number;
  readonly pendingTasks: number;
  readonly runningTasks: number;
  readonly failedTasks: number;
  readonly conflicts: number;
  readonly evidenceGaps: number;
  readonly stagnationRounds: number;
  readonly goalSatisfied: boolean;
  readonly confidence?: number;
  readonly note?: string;
};

export type AdaptationAction =
  | { readonly type: "continue" }
  | { readonly type: "stop" }
  | { readonly type: "replan"; readonly reason: string }
  | { readonly type: "spawn"; readonly demand: NodeDemand }
  | { readonly type: "retire"; readonly nodeId: string }
  | {
      readonly type: "rebracket";
      readonly previousBracket: string;
      readonly bracket: string;
      readonly direction: "up" | "down";
      readonly score: number;
      readonly gain: number;
    };

export type ReflectionDecision = {
  readonly reflectionId: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly iteration: number;
  readonly observation: ReflectionObservation;
  readonly actions: ReadonlyArray<AdaptationAction>;
  readonly reason: string;
};

export type AdaptiveReflectionInput = {
  readonly runId: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly iteration: number;
  readonly observation: ReflectionObservation;
  readonly maxNodes: number;
  readonly unmetDemands?: ReadonlyArray<NodeDemand>;
  readonly retirableNodeIds?: ReadonlyArray<string>;
  readonly topology?: CompositionTree;
  readonly affinities?: ReadonlyMap<string, number>;
  readonly topologyHysteresis?: number;
};

const stableTopology = (topology?: CompositionTree): TopologySelection | undefined => topology
  ? {
      tree: topology,
      bracket: compositionBracket(topology),
      previousBracket: compositionBracket(topology),
      direction: "stable",
      score: 0,
      gain: 0,
      reason: "topology unchanged",
    }
  : undefined;

export const reflectOnOrchestration = (input: AdaptiveReflectionInput): ReflectionDecision => {
  const actions: AdaptationAction[] = [];
  const observation = input.observation;
  const availableSlots = Math.max(0, Math.floor(input.maxNodes) - observation.activeNodes);
  const demands = [...(input.unmetDemands ?? [])].slice(0, availableSlots);
  const frontierQuiescent = observation.pendingTasks === 0 && observation.runningTasks === 0;
  const acceptanceClear = observation.failedTasks === 0
    && observation.conflicts === 0
    && observation.evidenceGaps === 0;
  const shouldInspectTopology = Boolean(input.topology)
    && (observation.conflicts > 0 || observation.stagnationRounds > 0 || observation.evidenceGaps > 0);
  const topology = shouldInspectTopology && input.topology
    ? selectTamariRotation({
        tree: input.topology,
        affinities: input.affinities ?? new Map(),
        minGain: input.topologyHysteresis ?? 0.1,
      })
    : stableTopology(input.topology);

  if (observation.goalSatisfied && frontierQuiescent && acceptanceClear) {
    actions.push({ type: "stop" });
  } else {
    for (const demand of demands) actions.push({ type: "spawn", demand });

    if (topology && topology.direction !== "stable") {
      actions.push({
        type: "rebracket",
        previousBracket: topology.previousBracket,
        bracket: topology.bracket,
        direction: topology.direction,
        score: topology.score,
        gain: topology.gain,
      });
    }

    if (observation.failedTasks > 0 || observation.evidenceGaps > 0) {
      actions.push({
        type: "replan",
        reason: observation.failedTasks > 0
          ? `${observation.failedTasks} failed task(s) require a new frontier`
          : `${observation.evidenceGaps} evidence gap(s) remain`,
      });
    }

    if (
      frontierQuiescent
      && acceptanceClear
      && demands.length === 0
      && (input.retirableNodeIds?.length ?? 0) > 0
    ) {
      for (const nodeId of input.retirableNodeIds ?? []) actions.push({ type: "retire", nodeId });
    }

    if (actions.length === 0) actions.push({ type: "continue" });
  }

  const reason = actions.map((action) => {
    switch (action.type) {
      case "spawn": return `spawn ${action.demand.capability}`;
      case "retire": return `retire ${action.nodeId}`;
      case "rebracket": return `${action.direction} associator gain ${action.gain.toFixed(3)}`;
      case "replan": return action.reason;
      case "stop": return "goal and evidence policy satisfied";
      case "continue": return "current population and topology remain adequate";
    }
  }).join("; ");

  return {
    reflectionId: `reflection_${hashCanonical({
      runId: input.runId,
      policyId: input.policyId,
      policyVersion: input.policyVersion,
      iteration: input.iteration,
      observation,
      actions,
    }).slice(0, 24)}`,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    iteration: input.iteration,
    observation,
    actions,
    reason,
  };
};

export const materializeNodeDemand = (input: {
  readonly runId: string;
  readonly reflectionId: string;
  readonly index: number;
  readonly coordinatorId: string;
  readonly demand: NodeDemand;
}): WorkspaceNode => {
  const capability = input.demand.capability.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  const { name: _displayName, nameSource: _nameSource, ...identityDemand } = input.demand;
  const suffix = hashCanonical({
    runId: input.runId,
    reflectionId: input.reflectionId,
    index: input.index,
    demand: identityDemand,
  }).slice(0, 10);
  const id = `${capability || "worker"}_${suffix}`;
  const role = typeof input.demand.metadata?.role === "string"
    ? input.demand.metadata.role
    : undefined;
  const resolvedName = resolveWorkspaceNodeName({
    name: input.demand.name,
    nameSource: input.demand.nameSource,
    capability: input.demand.capability,
    role,
    index: input.index,
  });
  return {
    id,
    name: resolvedName.name,
    capabilities: [...new Set([
      input.demand.capability,
      ...(input.demand.additionalCapabilities ?? []),
    ])],
    parentId: input.demand.parentId ?? input.coordinatorId,
    promptProfile: input.demand.promptProfile,
    runtime: rosterNativeRuntime(input.demand.promptProfile),
    metadata: {
      group: input.demand.group ?? "Adaptive workers",
      objective: input.demand.objective,
      ...(input.demand.focus ? { focus: input.demand.focus } : {}),
      spawnedByReflection: input.reflectionId,
      ...(input.demand.metadata ?? {}),
      displayNameSource: resolvedName.source,
    },
  };
};
