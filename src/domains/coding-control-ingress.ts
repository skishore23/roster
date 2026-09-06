import { z } from "zod";

import { hashCanonical } from "../core/canonical.js";
import { inlineArtifactPublishedEvent, type OrchestrationEvent } from "../modules/orchestration.js";
import { codingAgentTurnSchema } from "./coding-agent-turn.js";
import { codingControlIngressAuthorizationSchema } from "./coding-control-authorization.js";
import type { CodingConversationMessage } from "./coding-conversation.js";

export {
  CODING_CONTROL_INGRESS_SCHEMA_VERSION,
  codingControlIngressAuthorizationSchema,
  createCodingControlIngressAuthorization,
} from "./coding-control-authorization.js";
export type { CodingControlIngressAuthorization } from "./coding-control-authorization.js";

export const CODING_CONTROL_DELIVERY_SCHEMA_VERSION = "coding-control-delivery/v1" as const;
export const CODING_CONTROL_DELIVERY_KIND = "coding.control-ingress.delivery.v1";
export const CODING_CONTROL_CONTEXT_KEY = "coding_control_ingress";

export const CODING_CONTROL_DELIVERY_STATES = ["queued", "consumed", "superseded"] as const;
export type CodingControlDeliveryState = typeof CODING_CONTROL_DELIVERY_STATES[number];

const codingControlDeliveryBase = z.object({
  schema: z.literal(CODING_CONTROL_DELIVERY_SCHEMA_VERSION),
  authorization: codingControlIngressAuthorizationSchema,
});

export const codingControlDeliverySchema = z.discriminatedUnion("state", [
  codingControlDeliveryBase.extend({ state: z.literal("queued") }).strict(),
  codingControlDeliveryBase.extend({
    state: z.literal("consumed"),
    turn: z.lazy(() => codingAgentTurnSchema),
  }).strict(),
  codingControlDeliveryBase.extend({
    state: z.literal("superseded"),
    reason: z.string().trim().min(1).max(500),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.state === "consumed" && value.turn.turnId !== value.authorization.turnId) {
    ctx.addIssue({ code: "custom", path: ["turn", "turnId"], message: "turn does not match the authorized content" });
  }
});

export type CodingControlDelivery = z.infer<typeof codingControlDeliverySchema>;

export const codingControlDeliveryEvent = (
  runId: string,
  nodeId: string,
  delivery: CodingControlDelivery,
): OrchestrationEvent => {
  const parsed = codingControlDeliverySchema.parse(delivery);
  if (parsed.authorization.runId !== runId || parsed.authorization.authorNodeId !== nodeId) {
    throw new Error("Control delivery outer scope does not match its authorization");
  }
  const transitionId = hashCanonical(parsed);
  return inlineArtifactPublishedEvent({
    runId,
    artifactId: `coding_delivery_${transitionId.slice(0, 28)}`,
    origin: "input",
    outputKey: `coding_delivery_${parsed.authorization.deliveryAttemptId}`,
    nodeId,
    kind: CODING_CONTROL_DELIVERY_KIND,
    inputVersions: {
      message: parsed.authorization.messageId,
      topology: parsed.authorization.topologyVersion,
      task: parsed.authorization.recipientTaskId,
    },
  }, JSON.stringify(parsed));
};

export const isCodingControlDeliveryEvent = (event: OrchestrationEvent): boolean =>
  event.type === "artifact.published" && event.kind === CODING_CONTROL_DELIVERY_KIND;

const parseDelivery = (event: OrchestrationEvent): CodingControlDelivery | undefined => {
  if (!isCodingControlDeliveryEvent(event) || event.type !== "artifact.published" || event.payload.storage !== "inline") {
    return undefined;
  }
  try {
    return codingControlDeliverySchema.parse(JSON.parse(event.payload.value));
  } catch {
    return undefined;
  }
};

export type CodingMessageDeliveryProjection = {
  readonly messageId: string;
  readonly state: CodingControlDeliveryState;
  readonly runId?: string;
  readonly recipientNodeId?: string;
  readonly recipientTaskId?: string;
  readonly deliveryAttemptId?: string;
  readonly jobId?: string;
  readonly jobAttempt?: number;
  readonly turnId?: string;
};

const projectDelivery = (delivery: CodingControlDelivery): CodingMessageDeliveryProjection => ({
  messageId: delivery.authorization.messageId,
  state: delivery.state,
  runId: delivery.authorization.runId,
  recipientNodeId: delivery.authorization.recipientNodeId,
  recipientTaskId: delivery.authorization.recipientTaskId,
  deliveryAttemptId: delivery.authorization.deliveryAttemptId,
  jobId: delivery.authorization.jobId,
  jobAttempt: delivery.authorization.jobAttempt,
  turnId: delivery.authorization.turnId,
});

/** Projects one converged state per immutable delivery-attempt identity. */
export const codingControlDeliveryAttemptsFromEvents = (
  events: ReadonlyArray<OrchestrationEvent>,
): ReadonlyMap<string, ReadonlyArray<CodingMessageDeliveryProjection>> => {
  const attempts = new Map<string, CodingControlDelivery[]>();
  for (const event of events) {
    const delivery = parseDelivery(event);
    if (!delivery) continue;
    const id = delivery.authorization.deliveryAttemptId;
    const values = attempts.get(id) ?? [];
    if (!values.some((value) => hashCanonical(value) === hashCanonical(delivery))) values.push(delivery);
    attempts.set(id, values);
  }
  const byMessage = new Map<string, CodingMessageDeliveryProjection[]>();
  for (const [, values] of [...attempts].sort(([left], [right]) => left.localeCompare(right))) {
    const authorizationHashes = new Set(values.map((value) => hashCanonical(value.authorization)));
    if (authorizationHashes.size !== 1) continue;
    const byState = (state: CodingControlDeliveryState): CodingControlDelivery | undefined => {
      const candidates = values
        .filter((value) => value.state === state)
        .sort((left, right) => hashCanonical(left).localeCompare(hashCanonical(right)));
      return candidates.length === 1 ? candidates[0] : undefined;
    };
    const consumed = byState("consumed");
    const superseded = byState("superseded");
    const queued = byState("queued");
    const selected = consumed ?? superseded ?? queued;
    if (!selected) continue;
    const messageValues = byMessage.get(selected.authorization.messageId) ?? [];
    messageValues.push(projectDelivery(selected));
    byMessage.set(selected.authorization.messageId, messageValues);
  }
  return new Map([...byMessage]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([messageId, values]) => [messageId, [...values].sort((left, right) =>
      (left.deliveryAttemptId ?? "").localeCompare(right.deliveryAttemptId ?? ""))]));
};

/**
 * Projects a compact display state without using receipt arrival order. A
 * consumed attempt wins for its message. Otherwise an open queued attempt wins
 * over exhausted attempts. Delivery/retry decisions use the full attempt map
 * above so an older failed consumption cannot hide a later successful one.
 */
export const codingControlDeliveriesFromEvents = (
  events: ReadonlyArray<OrchestrationEvent>,
): ReadonlyMap<string, CodingMessageDeliveryProjection> => {
  const projected = new Map<string, CodingMessageDeliveryProjection>();
  for (const [messageId, attempts] of codingControlDeliveryAttemptsFromEvents(events)) {
    const selected = attempts.find((value) => value.state === "consumed")
      ?? attempts.find((value) => value.state === "queued")
      ?? attempts.find((value) => value.state === "superseded");
    if (!selected) continue;
    projected.set(messageId, selected);
  }
  return projected;
};

/**
 * Selects logical conversation messages that still need a delivery attempt.
 * Completion must be resolved against the execution that consumed the
 * message, not whichever continuation happens to be selected now.
 */
export const pendingCodingControlMessages = (input: {
  readonly messages: ReadonlyArray<CodingConversationMessage>;
  readonly deliveryAttempts: ReadonlyMap<string, ReadonlyArray<CodingMessageDeliveryProjection>>;
  readonly currentJobId: string;
  readonly currentJobAttempt: number;
  readonly recipientTaskCompleted: (delivery: CodingMessageDeliveryProjection) => boolean;
}): ReadonlyArray<CodingConversationMessage> => input.messages.filter((message) => {
  if (message.author.kind !== "user" || !message.tags.includes("delivery:queued")) return false;
  const consumed = (input.deliveryAttempts.get(message.messageId) ?? [])
    .filter((delivery) => delivery.state === "consumed");
  if (consumed.some((delivery) =>
    delivery.jobId === input.currentJobId && delivery.jobAttempt === input.currentJobAttempt)) return false;
  return !consumed.some(input.recipientTaskCompleted);
});
