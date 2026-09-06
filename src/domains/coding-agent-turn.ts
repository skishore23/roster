import { z } from "zod";

import { hashCanonical } from "../core/canonical.js";
import type { OrchestrationLimits, WorkspaceNode } from "../engine/orchestration/types.js";
import type { CodingWorkspaceDependency } from "./coding-workspace.js";
import {
  codingControlIngressAuthorizationSchema,
  type CodingControlIngressAuthorization,
} from "./coding-control-authorization.js";

/**
 * Phase 1: a pure, provider-neutral agent-turn protocol and deterministic
 * bounded follow-up planner. This module never executes or persists a task —
 * it only validates saved topology and projects bounded obligations. See
 * docs/workspace-nodes.md for the Phase 1/Phase 2 boundary.
 */
export const CODING_AGENT_TURN_SCHEMA_VERSION = "coding-agent-turn/v1" as const;
export const CODING_AGENT_TURN_POLICY_VERSION = "coding-agent-turn-policy/v1" as const;

const boundedId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const boundedText = (max: number) => z.string().trim().min(1).max(max);
const normalizedTurnText = (max: number) => z.string().trim().min(1).transform((value) => value.slice(0, max));
const turnEvidenceSchema = z.array(normalizedTurnText(500)).max(12).default([]);
const turnIdPattern = /^coding_turn_[a-f0-9]{28}$/;

export const CODING_AGENT_TURN_KINDS = [
  "question", "answer", "objection", "evidence", "handoff", "clarification", "escalation",
] as const;
export type CodingAgentTurnKind = typeof CODING_AGENT_TURN_KINDS[number];

export const CODING_AGENT_TURN_RESPONSE_REQUIREMENTS = ["none", "any", "all"] as const;
export type CodingAgentTurnResponseRequirement = typeof CODING_AGENT_TURN_RESPONSE_REQUIREMENTS[number];

/** The semantic fields turnId is derived from; excludes turnId itself. */
type CodingAgentTurnIdentityFields = {
  readonly schema: typeof CODING_AGENT_TURN_SCHEMA_VERSION;
  readonly kind: CodingAgentTurnKind;
  readonly authorNodeId: string;
  readonly recipients: ReadonlyArray<string>;
  readonly subjectId: string;
  readonly replyToTurnId?: string;
  readonly originatingTaskId: string;
  readonly responseRequirement: CodingAgentTurnResponseRequirement;
  readonly body: string;
  readonly evidence: ReadonlyArray<string>;
  readonly policyVersion: string;
};

const codingAgentTurnIdentityPayload = (turn: CodingAgentTurnIdentityFields): Record<string, unknown> => ({
  schema: turn.schema,
  kind: turn.kind,
  authorNodeId: turn.authorNodeId,
  recipients: turn.recipients,
  subjectId: turn.subjectId,
  ...(turn.replyToTurnId ? { replyToTurnId: turn.replyToTurnId } : {}),
  originatingTaskId: turn.originatingTaskId,
  responseRequirement: turn.responseRequirement,
  body: turn.body,
  evidence: turn.evidence,
  policyVersion: turn.policyVersion,
});

/** The single source of truth for turnId derivation, shared by construction and validation. */
const deriveCodingAgentTurnId = (turn: CodingAgentTurnIdentityFields): string =>
  `coding_turn_${hashCanonical(codingAgentTurnIdentityPayload(turn)).slice(0, 28)}`;

export const codingAgentTurnSchema = z.object({
  schema: z.literal(CODING_AGENT_TURN_SCHEMA_VERSION),
  turnId: z.string().regex(turnIdPattern),
  kind: z.enum(CODING_AGENT_TURN_KINDS),
  authorNodeId: boundedId,
  recipients: z.array(boundedId).min(1).max(3),
  subjectId: boundedId,
  replyToTurnId: z.string().regex(turnIdPattern).optional(),
  originatingTaskId: boundedId,
  responseRequirement: z.enum(CODING_AGENT_TURN_RESPONSE_REQUIREMENTS),
  body: normalizedTurnText(1_600),
  evidence: turnEvidenceSchema,
  policyVersion: boundedText(80),
}).strict().superRefine((turn, ctx) => {
  const sortedRecipients = [...new Set(turn.recipients)].sort();
  if (
    sortedRecipients.length !== turn.recipients.length
    || sortedRecipients.some((id, index) => id !== turn.recipients[index])
  ) {
    ctx.addIssue({ code: "custom", message: "recipients must be sorted and unique", path: ["recipients"] });
  }
  if (turn.recipients.includes(turn.authorNodeId)) {
    ctx.addIssue({ code: "custom", message: "author cannot address itself", path: ["recipients"] });
  }
  const sortedEvidence = [...new Set(turn.evidence)].sort();
  if (
    sortedEvidence.length !== turn.evidence.length
    || sortedEvidence.some((item, index) => item !== turn.evidence[index])
  ) {
    ctx.addIssue({ code: "custom", message: "evidence must be sorted and unique", path: ["evidence"] });
  }
  // Recompute turnId from normalized content so a forged or stale ID can never parse: this is
  // what makes content-derived identity a validated invariant instead of an unchecked convention.
  if (turn.turnId !== deriveCodingAgentTurnId(turn)) {
    ctx.addIssue({ code: "custom", message: "turnId does not match its normalized semantic content", path: ["turnId"] });
  }
});

export type CodingAgentTurn = z.infer<typeof codingAgentTurnSchema>;

/**
 * Canonical descriptive tags for projecting a durable peer turn into room
 * timelines, search, and diagnostics. These tags are derived from the validated
 * turn and never participate in recipient authorization or topology selection.
 */
export const codingAgentTurnTags = (
  turn: Pick<CodingAgentTurn, "kind" | "replyToTurnId" | "responseRequirement" | "evidence">,
): ReadonlyArray<string> => Object.freeze([
  "protocol:agent-turn",
  `turn:${turn.kind}`,
  "routing:node",
  `response:${turn.responseRequirement}`,
  ...(turn.replyToTurnId ? ["thread:reply"] : []),
  ...(turn.evidence.length > 0 ? ["content:evidence"] : []),
]);

/** Derives turnId from every semantic field so identical content always converges. */
export const createCodingAgentTurn = (input: {
  readonly kind: CodingAgentTurnKind;
  readonly authorNodeId: string;
  readonly recipients: ReadonlyArray<string>;
  readonly subjectId: string;
  readonly replyToTurnId?: string;
  readonly originatingTaskId: string;
  readonly responseRequirement: CodingAgentTurnResponseRequirement;
  readonly body: string;
  readonly evidence?: ReadonlyArray<string>;
  readonly policyVersion?: string;
}): CodingAgentTurn => {
  const recipients = [...new Set(input.recipients.map((id) => id.trim()).filter(Boolean))].sort();
  // Truncate before deduplicating/sorting so two distinct references that collapse to the same
  // 500-character prefix are treated as one canonical entry, not two silently divergent ones.
  const evidence = [...new Set(
    (input.evidence ?? []).map((item) => item.trim()).filter(Boolean).map((item) => item.slice(0, 500)),
  )].sort().slice(0, 12);
  const identity: CodingAgentTurnIdentityFields = {
    schema: CODING_AGENT_TURN_SCHEMA_VERSION,
    kind: input.kind,
    authorNodeId: input.authorNodeId.trim(),
    recipients,
    subjectId: input.subjectId.trim(),
    ...(input.replyToTurnId ? { replyToTurnId: input.replyToTurnId } : {}),
    originatingTaskId: input.originatingTaskId.trim(),
    responseRequirement: input.responseRequirement,
    body: input.body.trim().slice(0, 1_600),
    evidence,
    policyVersion: input.policyVersion ?? CODING_AGENT_TURN_POLICY_VERSION,
  };
  return codingAgentTurnSchema.parse({
    ...identity,
    turnId: deriveCodingAgentTurnId(identity),
  });
};

export const parseCodingAgentTurn = (value: string): CodingAgentTurn | undefined => {
  try {
    const parsed = codingAgentTurnSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

// --- Policy: five immutable hard ceilings, clamped (never raised) by the caller's budget. ---

export type CodingAgentTurnPolicy = {
  readonly recipientsPerTurn: number;
  readonly turnsPerOriginatingTask: number;
  readonly followUpRounds: number;
  readonly generatedResponseTasks: number;
  readonly unresolvedObligations: number;
};

export const CODING_AGENT_TURN_HARD_POLICY: CodingAgentTurnPolicy = Object.freeze({
  recipientsPerTurn: 3,
  turnsPerOriginatingTask: 12,
  followUpRounds: 2,
  generatedResponseTasks: 6,
  unresolvedObligations: 6,
});

const clampedCeiling = (override: number | undefined, hardCeiling: number, limit: number): number => {
  const requested = override === undefined
    ? hardCeiling
    : Number.isInteger(override) && override >= 0
      ? override
      : 0;
  return Math.min(requested, hardCeiling, Math.max(0, limit));
};

/** Callers may lower a ceiling via `overrides`; no override can ever raise it above the hard policy. */
export const clampCodingAgentTurnPolicy = (
  limits: OrchestrationLimits,
  overrides: Partial<CodingAgentTurnPolicy> = {},
): CodingAgentTurnPolicy => Object.freeze({
  recipientsPerTurn: clampedCeiling(
    overrides.recipientsPerTurn, CODING_AGENT_TURN_HARD_POLICY.recipientsPerTurn, limits.maxParallel,
  ),
  turnsPerOriginatingTask: clampedCeiling(
    overrides.turnsPerOriginatingTask, CODING_AGENT_TURN_HARD_POLICY.turnsPerOriginatingTask, limits.maxTasks,
  ),
  followUpRounds: clampedCeiling(
    overrides.followUpRounds, CODING_AGENT_TURN_HARD_POLICY.followUpRounds, limits.maxDepth,
  ),
  generatedResponseTasks: clampedCeiling(
    overrides.generatedResponseTasks, CODING_AGENT_TURN_HARD_POLICY.generatedResponseTasks, limits.maxTasks,
  ),
  unresolvedObligations: clampedCeiling(
    overrides.unresolvedObligations, CODING_AGENT_TURN_HARD_POLICY.unresolvedObligations, limits.maxTasks,
  ),
});

/**
 * Defense in depth: `planCodingAgentTurns` takes a `CodingAgentTurnPolicy` value directly, and
 * nothing in the type system stops a caller from constructing one without going through
 * `clampCodingAgentTurnPolicy`. Re-clamping every field to the hard ceiling here means the
 * planner itself can never honor a policy that exceeds `CODING_AGENT_TURN_HARD_POLICY`,
 * regardless of what a caller passes in.
 */
const enforceHardPolicyCeiling = (policy: CodingAgentTurnPolicy): CodingAgentTurnPolicy => Object.freeze({
  recipientsPerTurn: clampedCeiling(
    policy.recipientsPerTurn, CODING_AGENT_TURN_HARD_POLICY.recipientsPerTurn, Number.POSITIVE_INFINITY,
  ),
  turnsPerOriginatingTask: clampedCeiling(
    policy.turnsPerOriginatingTask, CODING_AGENT_TURN_HARD_POLICY.turnsPerOriginatingTask, Number.POSITIVE_INFINITY,
  ),
  followUpRounds: clampedCeiling(
    policy.followUpRounds, CODING_AGENT_TURN_HARD_POLICY.followUpRounds, Number.POSITIVE_INFINITY,
  ),
  generatedResponseTasks: clampedCeiling(
    policy.generatedResponseTasks, CODING_AGENT_TURN_HARD_POLICY.generatedResponseTasks, Number.POSITIVE_INFINITY,
  ),
  unresolvedObligations: clampedCeiling(
    policy.unresolvedObligations, CODING_AGENT_TURN_HARD_POLICY.unresolvedObligations, Number.POSITIVE_INFINITY,
  ),
});

// --- Deterministic bounded planner. ---

export type CodingAgentTurnRejectionReason =
  | "cross-task-turn"
  | "reply-cycle"
  | "stale-reply"
  | "cross-subject-reply"
  | "exceeds-follow-up-rounds"
  | "turns-per-task-exceeded"
  | "excess-fanout"
  | "self-routing"
  | "unknown-author"
  | "invalid-recipient";

export type CodingAgentTurnRejection = {
  readonly turnId: string;
  readonly reason: CodingAgentTurnRejectionReason;
};

export const codingAgentTurnObligationKey = (
  originatingTaskId: string, turnId: string, recipientNodeId: string, round: number,
): string => `coding_turn_obligation_${hashCanonical({
  schema: CODING_AGENT_TURN_SCHEMA_VERSION,
  originatingTaskId,
  turnId,
  recipientNodeId,
  round,
}).slice(0, 28)}`;

export type CodingAgentTurnObligation = {
  readonly key: string;
  readonly originatingTaskId: string;
  readonly turnId: string;
  readonly recipientNodeId: string;
  readonly round: number;
  readonly settledByTurnId?: string;
};

export type CodingAgentResponseTaskDescriptor = {
  readonly key: string;
  readonly originatingTaskId: string;
  readonly turnId: string;
  readonly recipientNodeId: string;
  readonly round: number;
};

export type CodingAgentHumanEscalation = {
  readonly originatingTaskId: string;
  readonly turnIds: ReadonlyArray<string>;
  readonly reason: "no-eligible-peer" | "bounded-path-exhausted";
};

export type CodingAgentTurnPlan = {
  readonly originatingTaskId: string;
  readonly acceptedTurnIds: ReadonlyArray<string>;
  readonly rejected: ReadonlyArray<CodingAgentTurnRejection>;
  readonly settledObligations: ReadonlyArray<CodingAgentTurnObligation>;
  readonly unresolvedObligations: ReadonlyArray<CodingAgentTurnObligation>;
  readonly responseTasks: ReadonlyArray<CodingAgentResponseTaskDescriptor>;
  readonly continuationId?: string;
  readonly humanEscalation?: CodingAgentHumanEscalation;
};

export type CodingAgentTurnPlannerInput = {
  readonly originatingTaskId: string;
  readonly nodes: ReadonlyArray<WorkspaceNode>;
  readonly dependencies: ReadonlyArray<CodingWorkspaceDependency>;
  readonly turns: ReadonlyArray<CodingAgentTurn>;
  readonly policy: CodingAgentTurnPolicy;
  /** Explicit topology-owned routes for non-executing human participants. */
  readonly ingressAuthorizations?: ReadonlyArray<CodingControlIngressAuthorization>;
  /** Exact execution scope against which ingress authorizations are validated. */
  readonly ingressScope?: Pick<CodingControlIngressAuthorization,
    "workspaceId" | "conversationId" | "runId" | "jobId" | "jobAttempt" | "topologyVersion">;
  /** Receipt-derived terminal task boundaries; ingress cannot authorize them. */
  readonly settledTaskIds?: ReadonlyArray<string>;
};

const authorizedHumanIngress = (
  turn: CodingAgentTurn,
  nodes: ReadonlyArray<WorkspaceNode>,
  authorizations: ReadonlyArray<CodingControlIngressAuthorization>,
  settledTaskIds: ReadonlySet<string>,
  scope: CodingAgentTurnPlannerInput["ingressScope"],
): boolean => {
  if (turn.replyToTurnId || (turn.kind !== "clarification" && turn.kind !== "evidence")) return false;
  if (!scope) return false;
  const author = nodes.find((node) => node.id === turn.authorNodeId);
  if (author?.metadata?.participantKind !== "human") return false;
  return authorizations.some((candidate) => {
    const authorization = codingControlIngressAuthorizationSchema.safeParse(candidate);
    if (!authorization.success) return false;
    const value = authorization.data;
    return !settledTaskIds.has(value.recipientTaskId)
      && value.turnId === turn.turnId
      && value.workspaceId === scope.workspaceId
      && value.conversationId === scope.conversationId
      && value.runId === scope.runId
      && value.jobId === scope.jobId
      && value.jobAttempt === scope.jobAttempt
      && value.topologyVersion === scope.topologyVersion
      && value.authorNodeId === turn.authorNodeId
      && value.recipientTaskId === turn.originatingTaskId
      && value.recipientNodeId === turn.recipients[0]
      && turn.recipients.length === 1;
  });
};

/**
 * A fresh turn is routed forward along a saved edge: the author depends on the recipient
 * (`edge.nodeId === author && edge.dependsOnNodeId === recipient`). Replies are authorized by
 * the exact obligation created from an already-accepted parent turn. That keeps alternating
 * follow-up rounds on the invited peer path without pretending every reply has the same edge
 * direction as the first response.
 */
const forwardRoutedEdge = (
  dependencies: ReadonlyArray<CodingWorkspaceDependency>, author: string, recipient: string,
): boolean => dependencies.some((edge) => edge.nodeId === author && edge.dependsOnNodeId === recipient);

/**
 * Detects cycles in the replyToTurnId chain restricted to the scoped turn set
 * and returns the set of turnIds that participate in one.
 */
const cyclicReplyTurnIds = (scoped: ReadonlyMap<string, CodingAgentTurn>): ReadonlySet<string> => {
  const cyclic = new Set<string>();
  const status = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const visit = (turnId: string): void => {
    if (!scoped.has(turnId)) return;
    const current = status.get(turnId) ?? 0;
    if (current === 1) {
      const start = path.indexOf(turnId);
      for (const id of path.slice(start)) cyclic.add(id);
      return;
    }
    if (current === 2) return;
    status.set(turnId, 1);
    path.push(turnId);
    const parentId = scoped.get(turnId)?.replyToTurnId;
    if (parentId) visit(parentId);
    path.pop();
    status.set(turnId, 2);
  };
  for (const turnId of scoped.keys()) visit(turnId);
  return cyclic;
};

/**
 * Resolves each turn's round (0 for a fresh turn, parent round + 1 for a
 * reply) topologically. A reply whose parent is missing, out of scope, or
 * addresses a different subject is rejected as a stale reply.
 */
const resolveRounds = (
  ordered: ReadonlyArray<CodingAgentTurn>,
  reject: (turn: CodingAgentTurn, reason: CodingAgentTurnRejectionReason) => void,
): ReadonlyMap<string, number> => {
  const byId = new Map(ordered.map((turn) => [turn.turnId, turn]));
  const rounds = new Map<string, number>();
  const pending = new Set(byId.keys());
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const turnId of [...pending]) {
      const turn = byId.get(turnId)!;
      if (!turn.replyToTurnId) {
        rounds.set(turnId, 0);
        pending.delete(turnId);
        progressed = true;
        continue;
      }
      const parent = byId.get(turn.replyToTurnId);
      if (!parent) {
        reject(turn, "stale-reply");
        pending.delete(turnId);
        progressed = true;
        continue;
      }
      if (!rounds.has(parent.turnId)) continue;
      if (parent.subjectId !== turn.subjectId) {
        reject(turn, "cross-subject-reply");
      } else {
        rounds.set(turnId, rounds.get(parent.turnId)! + 1);
      }
      pending.delete(turnId);
      progressed = true;
    }
  }
  for (const turnId of pending) reject(byId.get(turnId)!, "stale-reply");
  return rounds;
};

/**
 * Pure, deterministic follow-up planner for one originating task. Duplicate
 * or reordered input converges to the same projection because acceptance,
 * obligations, and continuation identity are derived from sorted content —
 * never from arrival order.
 */
export const planCodingAgentTurns = (input: CodingAgentTurnPlannerInput): CodingAgentTurnPlan => {
  const { originatingTaskId, nodes, dependencies, turns } = input;
  const ingressAuthorizations = input.ingressAuthorizations ?? [];
  const settledTaskIds = new Set(input.settledTaskIds ?? []);
  // Re-clamped defensively: the hard ceiling must hold even if a caller bypasses
  // `clampCodingAgentTurnPolicy` and constructs a policy object directly.
  const policy = enforceHardPolicyCeiling(input.policy);
  const validNodeIds = new Set(nodes.map((node) => node.id));
  const respondCapable = new Set(nodes.filter((node) => node.capabilities.includes("respond")).map((node) => node.id));

  const escalationReasons = new Set<CodingAgentHumanEscalation["reason"]>();
  const escalationTurnIds = new Set<string>();
  // A turn rejected purely for exhausting a bound (not for being malformed or misdirected) still
  // owes a response if it required one: silently dropping it would let the plan report full
  // settlement and a continuation identity even though its required response was never produced.
  const BOUND_EXHAUSTION_REASONS = new Set<CodingAgentTurnRejectionReason>([
    "turns-per-task-exceeded", "excess-fanout", "exceeds-follow-up-rounds",
  ]);
  const rejected: CodingAgentTurnRejection[] = [];
  const reject = (turn: CodingAgentTurn, reason: CodingAgentTurnRejectionReason): void => {
    rejected.push({ turnId: turn.turnId, reason });
    if (BOUND_EXHAUSTION_REASONS.has(reason) && turn.responseRequirement !== "none") {
      escalationReasons.add("bounded-path-exhausted");
      escalationTurnIds.add(turn.turnId);
    }
  };

  const deduped = new Map<string, CodingAgentTurn>();
  for (const turn of turns) if (!deduped.has(turn.turnId)) deduped.set(turn.turnId, turn);

  const scoped = new Map<string, CodingAgentTurn>();
  for (const turn of deduped.values()) {
    if (turn.originatingTaskId !== originatingTaskId) {
      reject(turn, "cross-task-turn");
      continue;
    }
    scoped.set(turn.turnId, turn);
  }

  const cyclic = cyclicReplyTurnIds(scoped);
  for (const turnId of cyclic) {
    reject(scoped.get(turnId)!, "reply-cycle");
    scoped.delete(turnId);
  }

  const ordered = [...scoped.values()].sort((left, right) => left.turnId.localeCompare(right.turnId));
  const rounds = resolveRounds(ordered, (turn, reason) => {
    reject(turn, reason);
    scoped.delete(turn.turnId);
  });

  const processingOrder = [...scoped.values()]
    .filter((turn) => rounds.has(turn.turnId))
    .sort((left, right) => rounds.get(left.turnId)! - rounds.get(right.turnId)!
      || left.turnId.localeCompare(right.turnId));

  const accepted: string[] = [];
  const obligations = new Map<string, CodingAgentTurnObligation>();
  const responseTasks: CodingAgentResponseTaskDescriptor[] = [];
  let unresolvedObligationCount = 0;

  for (const turn of processingOrder) {
    const round = rounds.get(turn.turnId)!;
    if (round > policy.followUpRounds) { reject(turn, "exceeds-follow-up-rounds"); continue; }
    if (accepted.length >= policy.turnsPerOriginatingTask) { reject(turn, "turns-per-task-exceeded"); continue; }
    if (turn.recipients.length > policy.recipientsPerTurn) { reject(turn, "excess-fanout"); continue; }
    if (turn.recipients.includes(turn.authorNodeId)) { reject(turn, "self-routing"); continue; }
    if (!validNodeIds.has(turn.authorNodeId)) { reject(turn, "unknown-author"); continue; }
    const ingressAuthorized = authorizedHumanIngress(
      turn, nodes, ingressAuthorizations, settledTaskIds, input.ingressScope,
    );
    const invalidRecipient = turn.recipients.find((recipientId) => !validNodeIds.has(recipientId)
      || (!turn.replyToTurnId && !ingressAuthorized
        && !forwardRoutedEdge(dependencies, turn.authorNodeId, recipientId)));
    if (invalidRecipient) { reject(turn, "invalid-recipient"); continue; }

    if (turn.replyToTurnId) {
      const parent = scoped.get(turn.replyToTurnId);
      // A settling reply must address the parent turn's author, not merely arrive from an
      // obligated recipient — otherwise a reply routed to an unrelated connected peer could
      // still settle someone else's obligation.
      if (!parent || !turn.recipients.includes(parent.authorNodeId)) { reject(turn, "stale-reply"); continue; }
      const key = codingAgentTurnObligationKey(turn.originatingTaskId, turn.replyToTurnId, turn.authorNodeId, round - 1);
      const obligation = obligations.get(key);
      if (!obligation || obligation.settledByTurnId) { reject(turn, "stale-reply"); continue; }
      obligations.set(key, { ...obligation, settledByTurnId: turn.turnId });
      unresolvedObligationCount -= 1;
    }

    accepted.push(turn.turnId);

    if (turn.responseRequirement === "none") continue;
    const eligible = turn.recipients.filter((recipientId) => respondCapable.has(recipientId));
    if (eligible.length === 0
      || (turn.responseRequirement === "all" && eligible.length !== turn.recipients.length)) {
      escalationReasons.add("no-eligible-peer");
      escalationTurnIds.add(turn.turnId);
      continue;
    }
    const responders = turn.responseRequirement === "any" ? [[...eligible].sort()[0]!] : [...eligible].sort();
    for (const recipientId of responders) {
      if (
        round >= policy.followUpRounds
        || responseTasks.length >= policy.generatedResponseTasks
        || unresolvedObligationCount >= policy.unresolvedObligations
      ) {
        escalationReasons.add("bounded-path-exhausted");
        escalationTurnIds.add(turn.turnId);
        continue;
      }
      const key = codingAgentTurnObligationKey(turn.originatingTaskId, turn.turnId, recipientId, round);
      obligations.set(key, { key, originatingTaskId: turn.originatingTaskId, turnId: turn.turnId, recipientNodeId: recipientId, round });
      responseTasks.push({ key, originatingTaskId: turn.originatingTaskId, turnId: turn.turnId, recipientNodeId: recipientId, round });
      unresolvedObligationCount += 1;
    }
  }

  const byKey = (left: { readonly key: string }, right: { readonly key: string }): number => left.key.localeCompare(right.key);
  const settledObligations = [...obligations.values()].filter((o) => o.settledByTurnId).sort(byKey);
  const unresolvedObligations = [...obligations.values()].filter((o) => !o.settledByTurnId).sort(byKey);
  const unresolvedKeys = new Set(unresolvedObligations.map((obligation) => obligation.key));
  const pendingResponseTasks = responseTasks.filter((task) => unresolvedKeys.has(task.key)).sort(byKey);

  const fullySettled = unresolvedObligations.length === 0 && escalationReasons.size === 0;
  const continuationId = fullySettled
    ? `coding_turn_continuation_${hashCanonical({
        schema: CODING_AGENT_TURN_SCHEMA_VERSION,
        originatingTaskId,
        policy,
        settled: settledObligations.map((o) => o.key),
      }).slice(0, 28)}`
    : undefined;
  const humanEscalation: CodingAgentHumanEscalation | undefined = escalationReasons.size > 0
    ? {
        originatingTaskId,
        turnIds: [...escalationTurnIds].sort(),
        reason: escalationReasons.has("no-eligible-peer") ? "no-eligible-peer" : "bounded-path-exhausted",
      }
    : undefined;

  return {
    originatingTaskId,
    acceptedTurnIds: accepted.sort(),
    rejected: rejected.sort((left, right) => left.turnId.localeCompare(right.turnId)),
    settledObligations,
    unresolvedObligations,
    responseTasks: pendingResponseTasks,
    ...(continuationId ? { continuationId } : {}),
    ...(humanEscalation ? { humanEscalation } : {}),
  };
};
