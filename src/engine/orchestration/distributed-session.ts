import { bytesToBase64 } from "../../core/base64.js";
import { hashCanonical } from "../../core/canonical.js";
import {
  createDistributedControlProjector,
  createDistributedControlUpdate,
  DistributedControlLedger,
  type DistributedControlEvent,
  type DistributedControlPayload,
  type DistributedControlPolicy,
  type DistributedControlProjection,
} from "./distributed-control.js";
import type { ArtifactProjection } from "../artifact/shared-crdt.js";

export type DistributedControlSessionOptions = {
  readonly runId: string;
  readonly artifactId: string;
  readonly frontierVersion: string;
  readonly topologyVersion: string;
  readonly inputVersions: Readonly<Record<string, string>>;
  readonly nodeRoles: Readonly<Record<string, string>>;
  readonly policy?: Partial<DistributedControlPolicy>;
  readonly canPropose?: Parameters<typeof createDistributedControlProjector>[0]["canPropose"];
  readonly emit: (event: DistributedControlEvent) => Promise<void>;
};

/**
 * One convergent decision frontier. Every caller publishes its own signed
 * logical update; the session only projects and records the deterministic
 * result. It never authors a proposal or chooses a winner for the members.
 */
export class DistributedControlSession {
  private readonly ledger = new DistributedControlLedger();
  private readonly projector;

  constructor(private readonly options: DistributedControlSessionOptions) {
    this.projector = createDistributedControlProjector({
      nodeRoles: options.nodeRoles,
      policy: options.policy,
      canPropose: options.canPropose,
    });
  }

  async publish(input: {
    readonly nodeId: string;
    readonly taskId: string;
    readonly payload: DistributedControlPayload;
  }): Promise<string> {
    const update = createDistributedControlUpdate({
      artifactId: this.options.artifactId,
      runId: this.options.runId,
      taskId: input.taskId,
      nodeId: input.nodeId,
      frontierVersion: this.options.frontierVersion,
      topologyVersion: this.options.topologyVersion,
      inputVersions: this.options.inputVersions,
      payload: input.payload,
    });
    const encoded = this.ledger.add(update);
    await this.options.emit({
      type: "control.update.published",
      runId: this.options.runId,
      artifactId: this.options.artifactId,
      updateId: update.updateId,
      nodeId: input.nodeId,
      taskId: input.taskId,
      frontierVersion: this.options.frontierVersion,
      topologyVersion: this.options.topologyVersion,
      payload: input.payload,
      crdtUpdateBase64: bytesToBase64(encoded),
    });
    return update.updateId;
  }

  project(): ArtifactProjection<DistributedControlProjection> {
    return this.ledger.project(this.options.artifactId, {
      frontierVersion: this.options.frontierVersion,
      topologyVersion: this.options.topologyVersion,
    }, this.projector);
  }

  async projectAndCertify(): Promise<ArtifactProjection<DistributedControlProjection>> {
    const projection = this.project();
    const acceptedProposalIds = projection.value.acceptedActions.map((action) => action.proposalId).sort();
    await this.options.emit({
      type: "control.frontier.projected",
      runId: this.options.runId,
      artifactId: this.options.artifactId,
      frontierVersion: this.options.frontierVersion,
      topologyVersion: this.options.topologyVersion,
      versionHash: projection.versionHash,
      acceptedProposalIds,
      conflictCount: projection.conflicts.length,
      proposalStatuses: projection.value.proposals.map((proposal) => ({
        proposalId: proposal.proposal.proposalId,
        status: proposal.status,
        reason: proposal.reason,
      })),
    });
    if (projection.conflicts.length > 0) return projection;
    if (acceptedProposalIds.length === 0) return projection;
    await this.options.emit({
      type: "control.frontier.certified",
      runId: this.options.runId,
      artifactId: this.options.artifactId,
      frontierVersion: this.options.frontierVersion,
      topologyVersion: this.options.topologyVersion,
      certificationId: `control_cert_${hashCanonical({
        artifactId: this.options.artifactId,
        frontierVersion: this.options.frontierVersion,
        topologyVersion: this.options.topologyVersion,
        versionHash: projection.versionHash,
        acceptedProposalIds,
      }).slice(0, 28)}`,
      versionHash: projection.versionHash,
      acceptedProposalIds,
    });
    return projection;
  }

  destroy(): void {
    this.ledger.destroy();
  }
}
