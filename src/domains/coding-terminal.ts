import type { JobStatus } from "../modules/job.js";

export type CodingDeliveryJob = {
  readonly status: JobStatus;
  /** Durable lease deadline used to bound active delivery projections. */
  readonly leaseUntil?: number;
  readonly runKind?: "coding" | "investigation" | "workspace-rescan";
  readonly noChanges?: boolean;
  readonly commit?: string;
  readonly integration?: {
    readonly integrated: boolean;
    readonly canIntegrate: boolean;
    readonly reason?: string;
  };
  readonly deliveryDisposition?: {
    readonly action: "keep-branch";
    readonly commit: string;
  };
};

export type CodingDeliveryState =
  | "working"
  | "finalizing"
  | "ready"
  | "integrated"
  | "no-changes"
  | "kept-branch"
  | "blocked"
  | "unavailable";

export const codingDeliveryState = (job?: CodingDeliveryJob, now?: number): CodingDeliveryState => {
  if (!job) return "working";
  if (["leased", "running"].includes(job.status)
    && now !== undefined
    && job.leaseUntil !== undefined
    && job.leaseUntil <= now) return "blocked";
  if (["queued", "leased", "running"].includes(job.status)) return "working";
  // The queue terminal status is authoritative. Stale success metadata must
  // never make a failed or canceled execution look complete.
  if (job.status === "failed" || job.status === "canceled") return "blocked";
  const noChanges = job.noChanges === true;
  const integrated = job.integration?.integrated === true;
  const keptBranch = job.deliveryDisposition?.action === "keep-branch";
  const ready = Boolean(job.commit && job.integration?.canIntegrate);
  const contradictory = (noChanges && Boolean(job.commit || job.integration || job.deliveryDisposition))
    || (integrated && (!job.commit || job.integration?.canIntegrate))
    || (keptBranch && (!job.commit || job.deliveryDisposition?.commit !== job.commit))
    || (ready && (integrated || keptBranch))
    || Boolean(job.integration?.canIntegrate && !job.commit)
    || Boolean(job.integration?.reason && (noChanges || integrated || ready));
  // Preserve semantic conflicts instead of choosing whichever success field
  // happens to be checked first.
  if (contradictory) return "unavailable";
  if (job.noChanges) return "no-changes";
  if (job.integration?.integrated) return "integrated";
  if (job.deliveryDisposition?.action === "keep-branch") return "kept-branch";
  if (job.commit && job.integration?.canIntegrate) return "ready";
  if (job.integration?.reason) return "blocked";
  if (job.status === "completed") return "unavailable";
  return "finalizing";
};

/** A settled graph without its queue/delivery record is a projection fault, not live work. */
export const codingRunDeliveryState = (
  graphComplete: boolean,
  job?: CodingDeliveryJob,
  readOnlyComplete = false,
  now?: number,
): CodingDeliveryState => readOnlyComplete && job?.status === "completed"
  ? "no-changes"
  : !job && graphComplete
  ? readOnlyComplete ? "no-changes" : "unavailable"
  : codingDeliveryState(job, now);

export type CodingTerminalOutcome = {
  readonly state: "working" | "waiting" | "completed" | "failed";
  readonly label: string;
  readonly handoff: string;
  readonly delivery: CodingDeliveryState;
};

export const codingTerminalOutcome = (input: {
  readonly graphComplete: boolean;
  readonly graphFailed: boolean;
  readonly certified: boolean;
  readonly readOnlyComplete?: boolean;
  readonly job?: CodingDeliveryJob;
  readonly now?: number;
  /** Ordered projections must surface an unresolved same-version disagreement. */
  readonly evidenceConflict?: boolean;
}): CodingTerminalOutcome | undefined => {
  const delivery = codingRunDeliveryState(input.graphComplete, input.job, input.readOnlyComplete, input.now);
  if (input.evidenceConflict) {
    return {
      state: "failed",
      label: "Needs attention",
      handoff: "projection conflict",
      delivery: "unavailable",
    };
  }
  const jobWorking = Boolean(input.job
    && ["queued", "leased", "running"].includes(input.job.status)
    && delivery === "working");
  if (input.certified && !(input.job?.runKind === "workspace-rescan" && input.job.status !== "completed")) {
    if (input.job?.runKind === "workspace-rescan") {
      return { state: "completed", label: "Team updated", handoff: "team updated", delivery };
    }
    if (delivery === "integrated") {
      return { state: "completed", label: "Merged", handoff: "integrated", delivery };
    }
    if (delivery === "no-changes") {
      return { state: "completed", label: "Completed", handoff: "no changes", delivery };
    }
    if (delivery === "kept-branch") {
      return { state: "completed", label: "Closed · branch kept", handoff: "closed · branch kept", delivery };
    }
    if (delivery === "ready") {
      return { state: "waiting", label: "Ready to merge", handoff: "ready to merge", delivery };
    }
    if (delivery === "blocked") {
      return { state: "failed", label: "Needs attention", handoff: "merge blocked", delivery };
    }
    if (delivery === "unavailable") {
      return { state: "failed", label: "Needs attention", handoff: "merge unavailable", delivery };
    }
    return { state: "working", label: "Finalizing delivery", handoff: "finalizing delivery", delivery };
  }
  if (!jobWorking && (input.graphFailed
    || input.job?.status === "failed"
    || input.job?.status === "canceled")) {
    return { state: "failed", label: "Failed", handoff: "run failed", delivery };
  }
  return undefined;
};
