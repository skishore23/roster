import { z } from "zod";

import { hashCanonical } from "../core/canonical.js";

export const CODING_CONTROL_INGRESS_SCHEMA_VERSION = "coding-control-ingress/v1" as const;

const boundedId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const authorizationIdentitySchema = z.object({
  schema: z.literal(CODING_CONTROL_INGRESS_SCHEMA_VERSION),
  workspaceId: boundedId,
  conversationId: boundedId,
  runId: boundedId,
  messageId: boundedId,
  turnId: z.string().regex(/^coding_turn_[a-f0-9]{28}$/),
  jobId: boundedId,
  jobAttempt: z.number().int().nonnegative(),
  topologyVersion: boundedId,
  authorNodeId: boundedId,
  recipientTaskId: boundedId,
  recipientNodeId: boundedId,
}).strict();

const deriveAttemptId = (identity: z.infer<typeof authorizationIdentitySchema>): string =>
  `coding_ingress_${hashCanonical(identity).slice(0, 28)}`;

export const codingControlIngressAuthorizationSchema = authorizationIdentitySchema.extend({
  deliveryAttemptId: z.string().regex(/^coding_ingress_[a-f0-9]{28}$/),
}).strict().superRefine((value, ctx) => {
  const { deliveryAttemptId: _deliveryAttemptId, ...identity } = value;
  if (value.deliveryAttemptId !== deriveAttemptId(identity)) {
    ctx.addIssue({ code: "custom", path: ["deliveryAttemptId"], message: "deliveryAttemptId does not match its scoped identity" });
  }
});

export type CodingControlIngressAuthorization = z.infer<typeof codingControlIngressAuthorizationSchema>;

export const createCodingControlIngressAuthorization = (
  input: Omit<z.input<typeof authorizationIdentitySchema>, "schema">,
): CodingControlIngressAuthorization => {
  const identity = authorizationIdentitySchema.parse({
    schema: CODING_CONTROL_INGRESS_SCHEMA_VERSION,
    ...input,
  });
  return codingControlIngressAuthorizationSchema.parse({
    ...identity,
    deliveryAttemptId: deriveAttemptId(identity),
  });
};
