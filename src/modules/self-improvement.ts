import type { Decide, Reducer } from "../core/types.js";
import type { DataReference } from "../engine/platform/protocol.js";
import {
  projectRuntimeExtensionRollout,
  validateRuntimeExtensionRolloutRecord,
  type RuntimeExtensionRolloutRecord,
  type RuntimeExtensionRolloutStatus,
} from "../engine/runtime/runtime-extension-rollout.js";

export const IMPROVEMENT_ARTIFACT_VERSION = "roster.improvement-artifact.v1" as const;

export type ImprovementArtifactType = "prompt_patch" | "policy_patch" | "harness_patch";

export type ImprovementProposalSource =
  | { readonly kind: "operator"; readonly actorId: string }
  | {
      readonly kind: "coding-certified-output";
      readonly actorId: string;
      readonly runId: string;
      readonly taskId: string;
      readonly nodeId: string;
      readonly outcomeId: string;
      readonly artifactId: string;
      readonly contentHash: string;
    };

export type ImprovementArtifactReference = {
  readonly schemaVersion: typeof IMPROVEMENT_ARTIFACT_VERSION;
  readonly artifactType: ImprovementArtifactType;
  readonly target: string;
  readonly contentHash: string;
  readonly reference: DataReference;
};

export type ImprovementValidation = {
  readonly status: "passed" | "failed";
  readonly evidenceHash: string;
  readonly report: string;
  readonly validatedBy: string;
};

export type ImprovementDeploymentObservation = {
  readonly observationId: string;
  readonly runId: string;
  readonly verdict: "passed" | "failed";
  readonly evidenceHash: string;
  readonly observedAt: number;
};

export type ImprovementDeployment = {
  readonly proposalId: string;
  readonly artifact: ImprovementArtifactReference;
  readonly manifestHash: string;
  readonly epoch: number;
  readonly generationId: string;
};

export type SelfImprovementEvent =
  | {
      readonly type: "proposal.created";
      readonly proposalId: string;
      readonly source: ImprovementProposalSource;
      readonly artifact: ImprovementArtifactReference;
      readonly baseline?: ImprovementDeployment;
      readonly rolloutRecord: RuntimeExtensionRolloutRecord;
    }
  | {
      readonly type: "proposal.transitioned";
      readonly proposalId: string;
      readonly rolloutRecord: RuntimeExtensionRolloutRecord;
      readonly validation?: ImprovementValidation;
      readonly generationId?: string;
    }
  | {
      readonly type: "deployment.observed";
      readonly proposalId: string;
      readonly observation: ImprovementDeploymentObservation;
    };

export type SelfImprovementCmd = {
  readonly type: "emit";
  readonly event: SelfImprovementEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type ProposalRecord = {
  readonly id: string;
  readonly source: ImprovementProposalSource;
  readonly artifact: ImprovementArtifactReference;
  readonly baseline?: ImprovementDeployment;
  readonly status: RuntimeExtensionRolloutStatus;
  readonly rolloutHistory: ReadonlyArray<RuntimeExtensionRolloutRecord>;
  readonly validation?: ImprovementValidation;
  readonly observations: ReadonlyArray<ImprovementDeploymentObservation>;
  readonly generationId?: string;
  readonly updatedAt: number;
};

export type SelfImprovementState = {
  readonly proposals: Readonly<Record<string, ProposalRecord>>;
  readonly activeByTarget: Readonly<Record<string, ImprovementDeployment>>;
};

export const initial: SelfImprovementState = { proposals: {}, activeByTarget: {} };
export const decide: Decide<SelfImprovementCmd, SelfImprovementEvent> = (cmd) => [cmd.event];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;

const assertId = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized)) throw new Error(`${label} must be a bounded identifier`);
  return normalized;
};

const assertArtifact = (artifact: ImprovementArtifactReference): void => {
  if (artifact.schemaVersion !== IMPROVEMENT_ARTIFACT_VERSION) {
    throw new Error("Improvement artifact reference has an unsupported schemaVersion");
  }
  if (!["prompt_patch", "policy_patch", "harness_patch"].includes(artifact.artifactType)) {
    throw new Error("Improvement artifact type is unsupported");
  }
  if (!artifact.target.trim() || artifact.target.length > 500 || artifact.target.includes("\0")) {
    throw new Error("Improvement target must be non-empty and bounded");
  }
  if (!/^[a-f0-9]{64}$/u.test(artifact.contentHash)) {
    throw new Error("Improvement artifact contentHash must be SHA-256");
  }
  if (artifact.reference.contentHash !== artifact.contentHash || artifact.reference.storage === "ephemeral") {
    throw new Error("Improvement artifact must use an exact durable content reference");
  }
};

const assertSource = (source: ImprovementProposalSource): void => {
  assertId(source.actorId, "Improvement source actorId");
  if (source.kind === "coding-certified-output") {
    for (const [label, value] of Object.entries({
      runId: source.runId,
      taskId: source.taskId,
      nodeId: source.nodeId,
      outcomeId: source.outcomeId,
      artifactId: source.artifactId,
    })) assertId(value, `Improvement Coding source ${label}`);
    if (!/^[a-f0-9]{64}$/u.test(source.contentHash)) {
      throw new Error("Improvement Coding source contentHash must be SHA-256");
    }
  }
};

const assertDeployment = (deployment: ImprovementDeployment): void => {
  assertId(deployment.proposalId, "Improvement deployment proposalId");
  assertArtifact(deployment.artifact);
  if (!deployment.manifestHash.trim() || !deployment.generationId.trim()) {
    throw new Error("Improvement deployment identities must be non-empty");
  }
  if (!Number.isSafeInteger(deployment.epoch) || deployment.epoch < 0) {
    throw new Error("Improvement deployment epoch must be a non-negative safe integer");
  }
};

const nextState = (
  state: SelfImprovementState,
  proposal: ProposalRecord,
  activeByTarget = state.activeByTarget,
): SelfImprovementState => ({
  proposals: { ...state.proposals, [proposal.id]: proposal },
  activeByTarget,
});

export const reduce: Reducer<SelfImprovementState, SelfImprovementEvent> = (state, event, ts) => {
  assertId(event.proposalId, "Improvement proposalId");
  if (event.type === "proposal.created") {
    if (state.proposals[event.proposalId]) {
      throw new Error(`Invariant: improvement proposal ${event.proposalId} already exists`);
    }
    assertSource(event.source);
    assertArtifact(event.artifact);
    if (event.baseline) {
      assertDeployment(event.baseline);
      if (event.baseline.artifact.target !== event.artifact.target) {
        throw new Error("Improvement baseline target does not match its candidate");
      }
    }
    const root = validateRuntimeExtensionRolloutRecord(event.rolloutRecord);
    if (root.body.type !== "proposed") throw new Error("Improvement proposal requires a rollout root");
    const proposal = root.body.proposal;
    if (
      proposal.artifactHash !== event.artifact.contentHash
      || proposal.proposerId !== event.source.actorId
      || proposal.baselineEpoch !== (event.baseline?.epoch ?? 1)
      || proposal.lastKnownGoodArtifactHash !== (event.baseline?.artifact.contentHash ?? "none")
      || proposal.lastKnownGoodManifestHash !== (event.baseline?.manifestHash ?? "none")
    ) {
      throw new Error("Improvement rollout root changed its artifact, source, or baseline identity");
    }
    return nextState(state, {
      id: event.proposalId,
      source: event.source,
      artifact: event.artifact,
      ...(event.baseline ? { baseline: event.baseline } : {}),
      status: "proposed",
      rolloutHistory: Object.freeze([root]),
      observations: Object.freeze([]),
      updatedAt: ts,
    });
  }

  const previous = state.proposals[event.proposalId];
  if (!previous) throw new Error(`Invariant: no improvement proposal ${event.proposalId}`);
  if (event.type === "deployment.observed") {
    if (previous.status !== "promoted") {
      throw new Error("Improvement deployment observations require a promoted proposal");
    }
    const observation = event.observation;
    assertId(observation.observationId, "Improvement observationId");
    assertId(observation.runId, "Improvement observation runId");
    if (observation.verdict !== "passed" && observation.verdict !== "failed") {
      throw new Error("Improvement observation verdict must be passed or failed");
    }
    if (!observation.evidenceHash.trim()) {
      throw new Error("Improvement observation evidenceHash must be non-empty");
    }
    if (!Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0) {
      throw new Error("Improvement observation observedAt must be a non-negative safe integer");
    }
    const observations = new Map(previous.observations.map((candidate) => [candidate.observationId, candidate]));
    const duplicate = observations.get(observation.observationId);
    if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(observation)) {
      throw new Error("Improvement observation identity has conflicting contents");
    }
    observations.set(observation.observationId, Object.freeze({ ...observation }));
    return nextState(state, {
      ...previous,
      observations: Object.freeze([...observations.values()]
        .sort((left, right) => left.observationId.localeCompare(right.observationId))
        .slice(0, 32)),
      updatedAt: ts,
    });
  }
  const root = previous.rolloutHistory[0]!;
  if (root.body.type !== "proposed") throw new Error("Invariant: improvement rollout root is malformed");
  const record = validateRuntimeExtensionRolloutRecord(event.rolloutRecord, root.body.proposal);
  const priorRecord = previous.rolloutHistory.at(-1)!;
  if (
    record.sequence !== priorRecord.sequence + 1
    || record.previousRecordId !== priorRecord.recordId
    || record.rolloutId !== priorRecord.rolloutId
  ) {
    throw new Error("Improvement rollout transition is not the next hash-linked record");
  }
  const history = Object.freeze([...previous.rolloutHistory, record]);
  const projection = projectRuntimeExtensionRollout(history);
  if (record.body.type === "verified") {
    if (!event.validation || event.validation.status !== "passed") {
      throw new Error("Verified improvement requires passing validation evidence");
    }
    if (event.validation.evidenceHash !== record.body.evidenceHash
      || event.validation.validatedBy !== record.body.authority.authorityId) {
      throw new Error("Improvement validation authority or evidence changed at the receipt boundary");
    }
  }
  if (record.body.type === "rejected" && event.validation?.status === "passed") {
    throw new Error("Rejected improvement cannot contain passing validation evidence");
  }
  if (
    (record.body.type === "warming" || record.body.type === "promoted" || record.body.type === "rollback-forward")
    && !event.generationId?.trim()
  ) throw new Error(`${record.body.type} improvement requires a runtime generation identity`);

  let activeByTarget: Readonly<Record<string, ImprovementDeployment>> = state.activeByTarget;
  if (record.body.type === "promoted") {
    activeByTarget = {
      ...activeByTarget,
      [previous.artifact.target]: {
        proposalId: previous.id,
        artifact: previous.artifact,
        manifestHash: projection.currentManifestHash,
        epoch: projection.currentEpoch,
        generationId: event.generationId!,
      },
    };
  } else if (record.body.type === "rollback-forward") {
    const restored: Record<string, ImprovementDeployment> = { ...activeByTarget };
    if (previous.baseline) {
      restored[previous.artifact.target] = {
        ...previous.baseline,
        epoch: projection.currentEpoch,
        generationId: event.generationId!,
      };
    } else delete restored[previous.artifact.target];
    activeByTarget = restored;
  }

  return nextState(state, {
    ...previous,
    status: projection.status,
    rolloutHistory: history,
    ...(event.validation ? { validation: event.validation } : {}),
    ...(event.generationId ? { generationId: event.generationId } : {}),
    updatedAt: ts,
  }, activeByTarget);
};
