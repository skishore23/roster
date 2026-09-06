import { hashCanonical } from "../../core/canonical.js";
import type { DataReferenceStore } from "../dataflow/data-reference-store.js";
import type { JsonValue } from "../orchestration/types.js";
import {
  IMPROVEMENT_ARTIFACT_VERSION,
  type ImprovementArtifactReference,
  type ImprovementArtifactType,
  type ImprovementDeployment,
  type ImprovementProposalSource,
  type ProposalRecord,
  type SelfImprovementEvent,
  type SelfImprovementState,
} from "../../modules/self-improvement.js";
import {
  createRuntimeEmissionClassification,
} from "./runtime-emission.js";
import {
  compileRuntimeExtensionPlan,
  defineRuntimeService,
  type RuntimeExtensionDefinition,
} from "./runtime-extension.js";
import { RuntimeExtensionHost } from "./runtime-extension-host.js";
import {
  createRuntimeExtensionRolloutProposal,
  promoteRuntimeExtensionRollout,
  projectRuntimeExtensionRollout,
  recordRuntimeExtensionCanary,
  rejectRuntimeExtensionRollout,
  rollbackRuntimeExtensionRolloutForward,
  verifyRuntimeExtensionRollout,
  warmRuntimeExtensionRollout,
  type RuntimeExtensionCanaryEvidence,
  type RuntimeExtensionRolloutAuthority,
} from "./runtime-extension-rollout.js";

export const ACTIVE_IMPROVEMENT_SNAPSHOT_VERSION =
  "roster.active-improvement-snapshot.v1" as const;

export type ImprovementArtifactDocument = {
  readonly schemaVersion: typeof IMPROVEMENT_ARTIFACT_VERSION;
  readonly artifactType: ImprovementArtifactType;
  readonly target: string;
  readonly patch: JsonValue;
};

export type ActiveImprovement = {
  readonly proposalId: string;
  readonly artifactType: ImprovementArtifactType;
  readonly target: string;
  readonly artifactHash: string;
  readonly manifestHash: string;
  readonly epoch: number;
  readonly patch: JsonValue;
};

export type ActiveImprovementSnapshot = {
  readonly schemaVersion: typeof ACTIVE_IMPROVEMENT_SNAPSHOT_VERSION;
  readonly snapshotHash: string;
  readonly improvements: ReadonlyArray<ActiveImprovement>;
};

type ImprovementTransitionEvent = Extract<
  SelfImprovementEvent,
  { readonly type: "proposal.transitioned" }
>;

export const ACTIVE_IMPROVEMENT_SERVICE = defineRuntimeService<ActiveImprovementSnapshot>(
  "roster.self-improvement.active",
  "1",
);

const EMPTY_AUTHORITY = Object.freeze({
  functionGrants: Object.freeze([]),
  scopes: Object.freeze(["self-improvement"]),
  allowedEffects: Object.freeze(["read"] as const),
  workspaceOperations: Object.freeze(["read"] as const),
  allowGraphExpansion: false,
});

const DEFAULT_BUDGET = Object.freeze({
  maxCanaryRuns: 4,
  maxTasks: 16,
  maxTokens: 0,
  maxCostMicros: 0,
  maxWallTimeMs: 15 * 60_000,
});

const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/u;

export const normalizeImprovementTarget = (target: string): string => {
  const normalized = target.trim();
  if (
    !TARGET_PATTERN.test(normalized)
    || normalized.startsWith("/")
    || normalized.split("/").some((part) => part === "..")
  ) throw new Error("Improvement target must be a bounded relative path or logical target");
  return normalized;
};

const parsePatch = (patch: string): JsonValue => {
  if (Buffer.byteLength(patch, "utf8") > 512 * 1024) {
    throw new Error("Improvement patch exceeds 524288 bytes");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(patch);
  } catch {
    throw new Error("Improvement patches must be canonical JSON merge-patch values");
  }
  if (parsed === undefined) throw new Error("Improvement patch is not JSON");
  return parsed as JsonValue;
};

const artifactDocument = (input: {
  readonly artifactType: ImprovementArtifactType;
  readonly target: string;
  readonly patch: string;
}): ImprovementArtifactDocument => Object.freeze({
  schemaVersion: IMPROVEMENT_ARTIFACT_VERSION,
  artifactType: input.artifactType,
  target: normalizeImprovementTarget(input.target),
  patch: parsePatch(input.patch),
});

const readArtifactDocument = async (
  store: DataReferenceStore,
  artifact: ImprovementArtifactReference,
): Promise<ImprovementArtifactDocument> => {
  const value = await store.read(artifact.reference);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Improvement artifact body must be an object");
  }
  const candidate = value as Readonly<Record<string, JsonValue>>;
  if (
    candidate.schemaVersion !== IMPROVEMENT_ARTIFACT_VERSION
    || candidate.artifactType !== artifact.artifactType
    || candidate.target !== artifact.target
    || hashCanonical(candidate) !== artifact.contentHash
    || !("patch" in candidate)
  ) throw new Error("Improvement artifact body changed after publication");
  return candidate as ImprovementArtifactDocument;
};

const manifestHash = (artifact: ImprovementArtifactReference): string => hashCanonical({
  schemaVersion: "roster.self-improvement-manifest.v1",
  extensionId: `self-improvement:${artifact.artifactType}`,
  artifactHash: artifact.contentHash,
  target: artifact.target,
  provides: [ACTIVE_IMPROVEMENT_SERVICE],
});

const authority = (
  authorityId: string,
  authorizationHash: string,
  kind: RuntimeExtensionRolloutAuthority["kind"] = "human",
): RuntimeExtensionRolloutAuthority => ({
  authorityId,
  kind,
  authorizationHash,
});

const assertExpectedRecord = (proposal: ProposalRecord, expectedRecordId: string): void => {
  const currentRecordId = proposal.rolloutHistory.at(-1)?.recordId;
  if (!expectedRecordId.trim() || currentRecordId !== expectedRecordId) {
    throw new Error(
      `Improvement rollout head is stale; expected ${expectedRecordId || "<missing>"}, current is ${currentRecordId ?? "<none>"}`,
    );
  }
};

const sameDeployment = (
  left: ImprovementDeployment | undefined,
  right: ImprovementDeployment | undefined,
): boolean => left === undefined
  ? right === undefined
  : right !== undefined && hashCanonical(left) === hashCanonical(right);

export const assertImprovementTargetBaseline = (
  state: SelfImprovementState,
  proposal: ProposalRecord,
): void => {
  const current = state.activeByTarget[proposal.artifact.target];
  if (!sameDeployment(current, proposal.baseline)) {
    throw new Error("Improvement target baseline is stale; create a proposal from the current deployment");
  }
};

export class SelfImprovementFramework {
  readonly #store: DataReferenceStore;
  readonly #host: RuntimeExtensionHost;

  constructor(input: {
    readonly artifacts: DataReferenceStore;
    readonly host?: RuntimeExtensionHost;
  }) {
    if (input.artifacts.durability !== "durable") {
      throw new Error("Self-improvement requires a durable immutable artifact store");
    }
    this.#store = input.artifacts;
    this.#host = input.host ?? new RuntimeExtensionHost({ limits: { maxModules: 1 } });
  }

  async createProposalEvent(input: {
    readonly state: SelfImprovementState;
    readonly proposalId: string;
    readonly artifactType: ImprovementArtifactType;
    readonly target: string;
    readonly patch: string;
    readonly source: ImprovementProposalSource;
  }): Promise<Extract<SelfImprovementEvent, { readonly type: "proposal.created" }>> {
    const document = artifactDocument(input);
    const reference = await this.#store.put({
      value: document,
      mediaType: "application/vnd.roster.improvement+json",
      storage: "artifact",
      artifactId: `improvement_${hashCanonical(document).slice(0, 40)}`,
      metadata: { artifactType: document.artifactType, target: document.target },
    });
    const artifact: ImprovementArtifactReference = Object.freeze({
      schemaVersion: IMPROVEMENT_ARTIFACT_VERSION,
      artifactType: document.artifactType,
      target: document.target,
      contentHash: reference.contentHash,
      reference,
    });
    const baseline = input.state.activeByTarget[document.target];
    const baselineEpoch = baseline?.epoch ?? 1;
    const rolloutRecord = createRuntimeExtensionRolloutProposal({
      extensionId: `self-improvement:${document.artifactType}`,
      artifactHash: artifact.contentHash,
      manifestHash: manifestHash(artifact),
      proposerId: input.source.actorId,
      baselineEpoch,
      targetEpoch: baselineEpoch + 1,
      lastKnownGoodArtifactHash: baseline?.artifact.contentHash ?? "none",
      lastKnownGoodManifestHash: baseline?.manifestHash ?? "none",
      baselineAuthority: EMPTY_AUTHORITY,
      candidateAuthority: EMPTY_AUTHORITY,
      baselineBudget: DEFAULT_BUDGET,
      candidateBudget: DEFAULT_BUDGET,
      emission: createRuntimeEmissionClassification({ kind: "no-emission" }),
    });
    return {
      type: "proposal.created",
      proposalId: input.proposalId,
      source: input.source,
      artifact,
      ...(baseline ? { baseline } : {}),
      rolloutRecord,
    };
  }

  async artifact(proposal: ProposalRecord): Promise<ImprovementArtifactDocument> {
    return readArtifactDocument(this.#store, proposal.artifact);
  }

  verificationEvent(input: {
    readonly proposal: ProposalRecord;
    readonly expectedRecordId: string;
    readonly validatorId: string;
    readonly authorizationHash: string;
    readonly status: "passed" | "failed";
    readonly report: string;
    readonly evidenceHash: string;
    readonly authorityKind?: RuntimeExtensionRolloutAuthority["kind"];
  }): ImprovementTransitionEvent {
    assertExpectedRecord(input.proposal, input.expectedRecordId);
    const rolloutAuthority = authority(input.validatorId, input.authorizationHash, input.authorityKind);
    if (input.status === "passed") {
      return {
        type: "proposal.transitioned",
        proposalId: input.proposal.id,
        rolloutRecord: verifyRuntimeExtensionRollout(input.proposal.rolloutHistory, {
          authority: rolloutAuthority,
          evidenceHash: input.evidenceHash,
        }),
        validation: {
          status: input.status,
          evidenceHash: input.evidenceHash,
          report: input.report,
          validatedBy: input.validatorId,
        },
      };
    }
    return {
      type: "proposal.transitioned",
      proposalId: input.proposal.id,
      rolloutRecord: rejectRuntimeExtensionRollout(input.proposal.rolloutHistory, {
        authority: rolloutAuthority,
        reason: "isolated verification failed",
        evidenceHash: input.evidenceHash,
      }),
      validation: {
        status: input.status,
        evidenceHash: input.evidenceHash,
        report: input.report,
        validatedBy: input.validatorId,
      },
    };
  }

  rejectionEvent(input: {
    readonly proposal: ProposalRecord;
    readonly expectedRecordId: string;
    readonly rejectedBy: string;
    readonly authorizationHash: string;
    readonly reason: string;
    readonly evidenceHash: string;
    readonly authorityKind?: RuntimeExtensionRolloutAuthority["kind"];
  }): ImprovementTransitionEvent {
    assertExpectedRecord(input.proposal, input.expectedRecordId);
    return {
      type: "proposal.transitioned",
      proposalId: input.proposal.id,
      rolloutRecord: rejectRuntimeExtensionRollout(input.proposal.rolloutHistory, {
        authority: authority(input.rejectedBy, input.authorizationHash, input.authorityKind),
        reason: input.reason,
        evidenceHash: input.evidenceHash,
      }),
    };
  }

  async warmingEvent(
    proposal: ProposalRecord,
    expectedRecordId: string,
  ): Promise<ImprovementTransitionEvent> {
    assertExpectedRecord(proposal, expectedRecordId);
    const document = await this.artifact(proposal);
    const candidate = await this.#snapshotFromDeployments([{
      proposalId: proposal.id,
      artifact: proposal.artifact,
      manifestHash: manifestHash(proposal.artifact),
      epoch: projectRuntimeExtensionRollout(proposal.rolloutHistory).proposal.targetEpoch,
      generationId: "warming",
    }]);
    const plan = compileRuntimeExtensionPlan([this.#definition(candidate)]);
    return {
      type: "proposal.transitioned",
      proposalId: proposal.id,
      rolloutRecord: warmRuntimeExtensionRollout(proposal.rolloutHistory, {
        evidenceHash: hashCanonical({ document, generationId: plan.manifest.generationId }),
      }),
      generationId: plan.manifest.generationId,
    };
  }

  canaryEvent(input: {
    readonly proposal: ProposalRecord;
    readonly expectedRecordId: string;
    readonly canaryBy: string;
    readonly authorizationHash: string;
    readonly evidence: ReadonlyArray<RuntimeExtensionCanaryEvidence>;
    readonly authorityKind?: RuntimeExtensionRolloutAuthority["kind"];
  }): ImprovementTransitionEvent {
    assertExpectedRecord(input.proposal, input.expectedRecordId);
    return {
      type: "proposal.transitioned",
      proposalId: input.proposal.id,
      rolloutRecord: recordRuntimeExtensionCanary(input.proposal.rolloutHistory, {
        authority: authority(input.canaryBy, input.authorizationHash, input.authorityKind),
        evidence: input.evidence,
      }),
    };
  }

  async promotionEvent(input: {
    readonly state: SelfImprovementState;
    readonly proposal: ProposalRecord;
    readonly expectedRecordId: string;
    readonly promoterId: string;
    readonly authorizationHash: string;
    readonly evidenceHash: string;
    readonly authorityKind?: RuntimeExtensionRolloutAuthority["kind"];
  }): Promise<ImprovementTransitionEvent> {
    assertExpectedRecord(input.proposal, input.expectedRecordId);
    assertImprovementTargetBaseline(input.state, input.proposal);
    const projection = projectRuntimeExtensionRollout(input.proposal.rolloutHistory);
    const deployment: ImprovementDeployment = {
      proposalId: input.proposal.id,
      artifact: input.proposal.artifact,
      manifestHash: projection.proposal.manifestHash,
      epoch: projection.proposal.targetEpoch,
      generationId: "pending",
    };
    const generationId = await this.generationId({
      ...input.state.activeByTarget,
      [input.proposal.artifact.target]: deployment,
    });
    return {
      type: "proposal.transitioned",
      proposalId: input.proposal.id,
      rolloutRecord: promoteRuntimeExtensionRollout(input.proposal.rolloutHistory, {
        authority: authority(input.promoterId, input.authorizationHash, input.authorityKind),
        evidenceHash: input.evidenceHash,
      }),
      generationId,
    };
  }

  async rollbackEvent(input: {
    readonly state: SelfImprovementState;
    readonly proposal: ProposalRecord;
    readonly expectedRecordId: string;
    readonly authorityId: string;
    readonly authorizationHash: string;
    readonly reason: string;
    readonly evidenceHash: string;
    readonly authorityKind?: RuntimeExtensionRolloutAuthority["kind"];
  }): Promise<ImprovementTransitionEvent> {
    assertExpectedRecord(input.proposal, input.expectedRecordId);
    const projection = projectRuntimeExtensionRollout(input.proposal.rolloutHistory);
    const deployments = { ...input.state.activeByTarget };
    if (input.proposal.baseline) deployments[input.proposal.artifact.target] = input.proposal.baseline;
    else delete deployments[input.proposal.artifact.target];
    return {
      type: "proposal.transitioned",
      proposalId: input.proposal.id,
      rolloutRecord: rollbackRuntimeExtensionRolloutForward(input.proposal.rolloutHistory, {
        authority: authority(input.authorityId, input.authorizationHash, input.authorityKind),
        epoch: projection.currentEpoch + 1,
        reason: input.reason,
        evidenceHash: input.evidenceHash,
      }),
      generationId: await this.generationId(deployments),
    };
  }

  async reconcile(state: SelfImprovementState): Promise<ActiveImprovementSnapshot> {
    const snapshot = await this.#snapshotFromDeployments(Object.values(state.activeByTarget));
    await this.#host.reconcile(snapshot.improvements.length > 0 ? [this.#definition(snapshot)] : []);
    return snapshot;
  }

  snapshot(): ActiveImprovementSnapshot {
    const generation = this.#host.generation();
    if (generation.modules.length === 0) return emptySnapshot();
    return this.#host.view({ scopeId: "self-improvement" }).get(ACTIVE_IMPROVEMENT_SERVICE);
  }

  runtimeGenerationId(): string {
    return this.#host.generation().generationId;
  }

  async close(): Promise<void> {
    await this.#host.close();
  }

  private async generationId(
    deployments: Readonly<Record<string, ImprovementDeployment>>,
  ): Promise<string> {
    const snapshot = await this.#snapshotFromDeployments(Object.values(deployments));
    return compileRuntimeExtensionPlan(
      snapshot.improvements.length > 0 ? [this.#definition(snapshot)] : [],
    ).manifest.generationId;
  }

  #definition(snapshot: ActiveImprovementSnapshot): RuntimeExtensionDefinition {
    return {
      id: "self-improvement-runtime",
      version: "1",
      artifactHash: snapshot.snapshotHash,
      configurationHash: snapshot.snapshotHash,
      provides: [ACTIVE_IMPROVEMENT_SERVICE],
      activate: (context) => {
        context.provide(ACTIVE_IMPROVEMENT_SERVICE, snapshot);
      },
    };
  }

  async #snapshotFromDeployments(
    deployments: ReadonlyArray<ImprovementDeployment>,
  ): Promise<ActiveImprovementSnapshot> {
    const improvements = await Promise.all([...deployments]
      .sort((left, right) => left.artifact.target.localeCompare(right.artifact.target))
      .map(async (deployment): Promise<ActiveImprovement> => {
        const document = await readArtifactDocument(this.#store, deployment.artifact);
        return Object.freeze({
          proposalId: deployment.proposalId,
          artifactType: document.artifactType,
          target: document.target,
          artifactHash: deployment.artifact.contentHash,
          manifestHash: deployment.manifestHash,
          epoch: deployment.epoch,
          patch: document.patch,
        });
      }));
    const content = Object.freeze({
      schemaVersion: ACTIVE_IMPROVEMENT_SNAPSHOT_VERSION,
      improvements: Object.freeze(improvements),
    });
    return Object.freeze({ ...content, snapshotHash: hashCanonical(content) });
  }
}

const emptySnapshot = (): ActiveImprovementSnapshot => {
  const content = Object.freeze({
    schemaVersion: ACTIVE_IMPROVEMENT_SNAPSHOT_VERSION,
    improvements: Object.freeze([]),
  });
  return Object.freeze({ ...content, snapshotHash: hashCanonical(content) });
};
