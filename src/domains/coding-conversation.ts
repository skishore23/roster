import { z } from "zod";

import type { LlmStructured } from "../adapters/openai.js";
import { hashCanonical } from "../core/canonical.js";
import type { JsonValue, WorkspaceNode } from "../engine/orchestration/types.js";
import { CODING_HUMAN_NODE_ID } from "./coding-workspace.js";
import { codingWorkspaceNodeDependencyIds } from "./coding-workspace-enrichment.js";
import { CODING_COORDINATION_SKILL } from "./coding-coordination-skill.js";
import {
  inlineArtifactPublishedEvent,
  type OrchestrationEvent,
} from "../modules/orchestration.js";

export const CODING_CONVERSATION_SCHEMA = "roster.coding-conversation.v1" as const;
export const CODING_CONVERSATION_MESSAGE_KIND = "coding.conversation-message";
export const CODING_CONVERSATION_IMAGE_KIND = "coding.conversation-image";
export const CODING_CONVERSATION_ROUTE_KIND = "coding.conversation-route";

export const MAX_CODING_CONVERSATION_IMAGES = 4;
export const MAX_CODING_CONVERSATION_IMAGE_DATA_URL_CHARS = 120_000;

export type CodingConversationImageAttachment = {
  readonly kind: "image";
  readonly artifactId: string;
  readonly name: string;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  readonly width?: number;
  readonly height?: number;
};

export type CodingConversationImage = CodingConversationImageAttachment & {
  readonly schema: typeof CODING_CONVERSATION_SCHEMA;
  readonly conversationId: string;
  readonly dataUrl: string;
  readonly createdAt: number;
};

export type CodingConversationDisposition =
  | "ready"
  | "investigating"
  | "informational"
  | "operational"
  | "needs_clarification"
  | "escalated"
  | "declined";

export type CodingConversationRepositoryContext = {
  readonly repositoryName: string;
  readonly currentBranch: string;
  readonly headCommit: string;
  readonly workingTree: "clean" | "dirty" | "unknown";
  readonly fileCount?: number;
  readonly filesTruncated?: boolean;
  readonly technologies?: ReadonlyArray<string>;
  readonly toolchains?: ReadonlyArray<string>;
  readonly topLevelAreas?: ReadonlyArray<string>;
};

export type CodingConversationCollaborationContext = {
  readonly stage: "awaiting_human";
  readonly summary: string;
  readonly decisions: ReadonlyArray<{
    readonly subjectId: string;
    readonly resolution: string;
    readonly rationale: string;
    readonly evidence: ReadonlyArray<string>;
  }>;
  readonly unresolved: ReadonlyArray<{
    readonly subjectId: string;
    readonly reason: string;
    readonly candidateSummaries: ReadonlyArray<string>;
  }>;
};

export type CodingConversationProductContext = {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly creator?: {
    readonly label: string;
    readonly url: string;
  };
};

/** Bounded receipt-derived status supplied while a conversation run is active. */
export type CodingConversationActiveRunContext = {
  readonly runId: string;
  readonly jobId: string;
  readonly jobStatus: string;
  readonly attempt: number;
  readonly totalTasks: number;
  readonly readyTasks: number;
  readonly blockedTasks: number;
  readonly inflightTasks: number;
  readonly acceptedTasks: number;
  readonly failedTasks: number;
  readonly activeTasks: ReadonlyArray<{
    readonly taskId: string;
    readonly nodeId: string;
    readonly nodeName: string;
    readonly capability: string;
    readonly status: string;
  }>;
  readonly latestDurableUpdateAt: number;
  readonly instruction: string;
};

export type CodingConversationSource = {
  readonly kind: "ui" | "api" | "pr-comment" | "review-comment" | "agent";
  readonly provider?: string;
  readonly repository?: string;
  readonly externalId?: string;
  readonly revision?: string;
  readonly url?: string;
};

export type CodingConversationMessage = {
  readonly schema: typeof CODING_CONVERSATION_SCHEMA;
  readonly messageId: string;
  readonly conversationId: string;
  /** Stable repository workspace owning the durable parent room. */
  readonly workspaceId?: string;
  readonly author: {
    readonly kind: "user" | "agent" | "system";
    readonly id: string;
    readonly name: string;
  };
  readonly source: CodingConversationSource;
  readonly text: string;
  readonly tags: ReadonlyArray<string>;
  readonly mentions: ReadonlyArray<string>;
  readonly attachments: ReadonlyArray<CodingConversationImageAttachment>;
  readonly replyTo?: string;
  readonly createdAt: number;
};

export type CodingConversationRoute = {
  readonly schema: typeof CODING_CONVERSATION_SCHEMA;
  readonly routeId: string;
  readonly conversationId: string;
  readonly inReplyTo: string;
  readonly disposition: CodingConversationDisposition;
  readonly selectedNodeIds: ReadonlyArray<string>;
  readonly primaryNodeId?: string;
  readonly coordination?: CodingConversationCoordination;
  readonly tags: ReadonlyArray<string>;
  readonly questions: ReadonlyArray<string>;
  readonly answer?: string;
  readonly rationale: string;
  readonly confidence: number;
  readonly createdAt: number;
};

export type CodingConversationCoordination = {
  readonly reviewMode: "fast" | "reviewed";
  readonly validationScope: "focused" | "repository-wide";
};

const codingConversationCoordinationSchema = z.object({
  reviewMode: z.enum(["fast", "reviewed"]),
  validationScope: z.enum(["focused", "repository-wide"]),
});

export const parseCodingConversationCoordination = (
  value: unknown,
): CodingConversationCoordination | undefined => {
  const parsed = codingConversationCoordinationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export type CodingConversationPlannerInput = {
  readonly conversationId: string;
  readonly messages: ReadonlyArray<CodingConversationMessage>;
  readonly images?: ReadonlyArray<CodingConversationImage>;
  readonly routes?: ReadonlyArray<CodingConversationRoute>;
  readonly workspaceNodes: ReadonlyArray<WorkspaceNode>;
  /** Saved participant whose voice must author this bounded informational reply. */
  readonly responder?: WorkspaceNode;
  readonly repositoryContext: CodingConversationRepositoryContext;
  readonly repositoryRoot?: string;
  readonly productContext?: CodingConversationProductContext;
  readonly collaborationContext?: CodingConversationCollaborationContext;
  readonly activeRunContext?: CodingConversationActiveRunContext;
  /** Disposable answer text for the current browser turn; never durable routing state. */
  readonly onDelta?: (delta: string) => void | Promise<void>;
};

export type CodingConversationPlanner = (
  input: CodingConversationPlannerInput,
) => Promise<Omit<CodingConversationRoute, "schema" | "routeId" | "conversationId" | "inReplyTo" | "createdAt">>;

export type CodingConversationAnswerer = (input: {
  readonly messages: ReadonlyArray<CodingConversationMessage>;
  readonly images?: ReadonlyArray<CodingConversationImage>;
  readonly routes?: ReadonlyArray<CodingConversationRoute>;
  readonly workspaceNodes: ReadonlyArray<WorkspaceNode>;
  /** Single saved node directly addressed by the latest informational message. */
  readonly responder?: WorkspaceNode;
  readonly repositoryContext: CodingConversationRepositoryContext;
  readonly productContext?: CodingConversationProductContext;
  readonly activeRunContext?: CodingConversationActiveRunContext;
  readonly onDelta?: (delta: string) => void | Promise<void>;
}) => Promise<string>;

type CodingConversationTextModel = (options: {
  readonly model?: string;
  readonly system?: string;
  readonly user: string;
  readonly onDelta?: (delta: string) => void | Promise<void>;
}) => Promise<string>;

const MAX_MESSAGE_CHARS = 20_000;
const MAX_TAGS = 24;
const MAX_MENTIONS = 12;
const CODING_CONVERSATION_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

const codingConversationImageMediaType = (
  value: string,
): CodingConversationImageAttachment["mediaType"] | undefined =>
  CODING_CONVERSATION_IMAGE_MEDIA_TYPES.find((candidate) => candidate === value);

const normalizedImageDimension = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 16_384
    ? value
    : undefined;

export const createCodingConversationImage = (input: {
  readonly conversationId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly dataUrl: string;
  readonly width?: number;
  readonly height?: number;
  readonly createdAt?: number;
}): CodingConversationImage => {
  const mediaType = codingConversationImageMediaType(input.mediaType.trim().toLowerCase());
  if (!mediaType) throw new Error("Coding conversation images must be PNG, JPEG, WebP, or GIF");
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 200) || "Attached image";
  const dataUrl = input.dataUrl.trim();
  if (dataUrl.length > MAX_CODING_CONVERSATION_IMAGE_DATA_URL_CHARS) {
    throw new Error(
      `Coding conversation image data must not exceed ${MAX_CODING_CONVERSATION_IMAGE_DATA_URL_CHARS} characters`,
    );
  }
  const prefix = `data:${mediaType};base64,`;
  const encoded = dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : "";
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error(`Coding conversation image data must be a base64 ${mediaType} data URL`);
  }
  const width = normalizedImageDimension(input.width);
  const height = normalizedImageDimension(input.height);
  const identity = {
    conversationId: input.conversationId,
    name,
    mediaType,
    dataUrl,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
  return {
    schema: CODING_CONVERSATION_SCHEMA,
    kind: "image",
    artifactId: `coding_image_${hashCanonical(identity).slice(0, 28)}`,
    ...identity,
    createdAt: input.createdAt ?? Date.now(),
  };
};

const boundedUnique = (values: ReadonlyArray<string>, limit: number): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort().slice(0, limit);

const boundedOrderedUnique = (values: ReadonlyArray<string>, limit: number): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);

const isAsciiLower = (character: string): boolean =>
  character >= "a" && character <= "z";

const isAsciiUpper = (character: string): boolean =>
  character >= "A" && character <= "Z";

const isAsciiDigit = (character: string): boolean =>
  character >= "0" && character <= "9";

const isAsciiLetterOrDigit = (character: string): boolean =>
  isAsciiLower(character) || isAsciiUpper(character) || isAsciiDigit(character);

const isWhitespace = (character: string): boolean =>
  character.trim().length === 0;

const validCodingConversationTag = (value: string): boolean => {
  const separator = value.indexOf(":");
  if (separator < 1 || separator !== value.lastIndexOf(":")) return false;
  const namespace = value.slice(0, separator);
  const name = value.slice(separator + 1);
  if (namespace.length > 32 || name.length < 1 || name.length > 64) return false;
  if (!isAsciiLower(namespace[0] ?? "") || !isAsciiLetterOrDigit(name[0] ?? "")) return false;
  return [...namespace].every((character) =>
    isAsciiLower(character) || isAsciiDigit(character) || character === "-")
    && [...name].every((character) =>
      isAsciiLower(character)
      || isAsciiDigit(character)
      || character === "."
      || character === "_"
      || character === "-");
};

const inlinePrefixedTokens = (input: {
  readonly text: string;
  readonly prefix: "@" | "#";
  readonly maxLength: number;
  readonly allowed: (character: string) => boolean;
}): ReadonlyArray<string> => {
  const tokens: string[] = [];
  for (let index = 0; index < input.text.length; index += 1) {
    if (input.text[index] !== input.prefix) continue;
    if (index > 0 && !isWhitespace(input.text[index - 1] ?? "")) continue;
    const first = input.text[index + 1] ?? "";
    if (!isAsciiLetterOrDigit(first)) continue;
    let end = index + 1;
    while (end < input.text.length
      && end - index - 1 < input.maxLength
      && input.allowed(input.text[end] ?? "")) {
      end += 1;
    }
    tokens.push(input.text.slice(index + 1, end));
    index = end - 1;
  }
  return tokens;
};

export const normalizeCodingConversationTags = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  boundedUnique(
    values.map((value) => value.toLowerCase()).filter(validCodingConversationTag),
    MAX_TAGS,
  );

const normalizeCodingConversationTagsWithRequired = (
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const normalizedRequired = normalizeCodingConversationTags(required);
  const requiredSet = new Set(normalizedRequired);
  const normalizedOptional = normalizeCodingConversationTags(optional)
    .filter((tag) => !requiredSet.has(tag))
    .slice(0, Math.max(0, MAX_TAGS - normalizedRequired.length));
  return [...normalizedRequired, ...normalizedOptional].sort();
};

export const codingConversationInlineTags = (text: string): ReadonlyArray<string> =>
  normalizeCodingConversationTags(inlinePrefixedTokens({
    text,
    prefix: "#",
    maxLength: 97,
    allowed: (character) =>
      isAsciiLetterOrDigit(character)
      || character === ":"
      || character === "."
      || character === "_"
      || character === "-",
  }));

export const codingConversationInlineMentions = (text: string): ReadonlyArray<string> =>
  boundedUnique(inlinePrefixedTokens({
    text,
    prefix: "@",
    maxLength: 80,
    allowed: (character) =>
      isAsciiLetterOrDigit(character)
      || character === "."
      || character === "_"
      || character === "-",
  }), MAX_MENTIONS);

const normalizedSource = (source: CodingConversationSource): CodingConversationSource => ({
  kind: source.kind,
  ...(source.provider?.trim() ? { provider: source.provider.trim().slice(0, 80) } : {}),
  ...(source.repository?.trim() ? { repository: source.repository.trim().slice(0, 500) } : {}),
  ...(source.externalId?.trim() ? { externalId: source.externalId.trim().slice(0, 500) } : {}),
  ...(source.revision?.trim() ? { revision: source.revision.trim().slice(0, 160) } : {}),
  ...(source.url?.trim() ? { url: source.url.trim().slice(0, 2_000) } : {}),
});

export const createCodingConversationMessage = (input: {
  readonly conversationId: string;
  readonly workspaceId?: string;
  readonly author: CodingConversationMessage["author"];
  readonly source: CodingConversationSource;
  readonly text: string;
  readonly tags?: ReadonlyArray<string>;
  readonly mentions?: ReadonlyArray<string>;
  readonly attachments?: ReadonlyArray<CodingConversationImageAttachment>;
  readonly replyTo?: string;
  readonly createdAt?: number;
}): CodingConversationMessage => {
  const text = input.text.trim();
  if (!text || text.length > MAX_MESSAGE_CHARS) {
    throw new Error(`Coding conversation text must be between 1 and ${MAX_MESSAGE_CHARS} characters`);
  }
  const source = normalizedSource(input.source);
  const mentions = boundedUnique([
    ...(input.mentions ?? []),
    ...codingConversationInlineMentions(text),
  ], MAX_MENTIONS);
  const attachments = [...new Map((input.attachments ?? [])
    .filter((attachment) => attachment.kind === "image"
      && Boolean(codingConversationImageMediaType(attachment.mediaType)))
    .slice(0, MAX_CODING_CONVERSATION_IMAGES)
    .map((attachment) => [attachment.artifactId, {
      kind: "image" as const,
      artifactId: attachment.artifactId.slice(0, 200),
      name: attachment.name.trim().replace(/\s+/g, " ").slice(0, 200) || "Attached image",
      mediaType: attachment.mediaType,
      ...(normalizedImageDimension(attachment.width) ? { width: normalizedImageDimension(attachment.width) } : {}),
      ...(normalizedImageDimension(attachment.height) ? { height: normalizedImageDimension(attachment.height) } : {}),
    }])).values()];
  // System-owned envelope tags come first so callers cannot exhaust MAX_TAGS and
  // accidentally remove the provenance needed by projections and audits. They
  // remain descriptive metadata; mentions are resolved to node IDs separately.
  const tags = normalizeCodingConversationTagsWithRequired([
    `source:${source.kind}`,
    `author:${input.author.kind}`,
    ...(mentions.length > 0 ? ["routing:mention"] : []),
    ...(input.replyTo ? ["thread:reply"] : []),
    ...(attachments.length > 0 ? ["content:image"] : []),
  ], [
    ...(input.tags ?? []),
    ...codingConversationInlineTags(text),
  ]);
  const identity = {
    conversationId: input.conversationId,
    ...(input.workspaceId?.trim() ? { workspaceId: input.workspaceId.trim().slice(0, 160) } : {}),
    author: input.author,
    source,
    text,
    tags,
    mentions,
    attachments,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  };
  return {
    schema: CODING_CONVERSATION_SCHEMA,
    messageId: `coding_message_${hashCanonical(identity).slice(0, 28)}`,
    ...identity,
    createdAt: input.createdAt ?? Date.now(),
  };
};

export const createCodingConversationRoute = (input: {
  readonly conversationId: string;
  readonly inReplyTo: string;
  readonly disposition: CodingConversationDisposition;
  readonly selectedNodeIds: ReadonlyArray<string>;
  readonly primaryNodeId?: string;
  readonly coordination?: CodingConversationCoordination;
  readonly tags?: ReadonlyArray<string>;
  readonly questions?: ReadonlyArray<string>;
  readonly answer?: string;
  readonly rationale: string;
  readonly confidence: number;
  readonly createdAt?: number;
}): CodingConversationRoute => {
  const disposition = input.disposition;
  const selectedNodeIds = input.disposition === "informational"
    ? boundedOrderedUnique(input.selectedNodeIds, 12)
    : boundedUnique(input.selectedNodeIds, 12);
  const questions = boundedUnique(input.questions ?? [], 4).map((question) => question.slice(0, 1_000));
  const confidence = Math.max(0, Math.min(1, input.confidence));
  if (disposition === "needs_clarification" && questions.length === 0) {
    throw new Error("A clarification route requires at least one question");
  }
  const answer = input.answer?.trim().slice(0, 4_000);
  const directAnswer = disposition === "informational" || disposition === "operational";
  if (directAnswer && !answer) {
    throw new Error(`An ${disposition} route requires an answer`);
  }
  const actionable = disposition === "ready" || disposition === "investigating" || disposition === "escalated";
  if (input.primaryNodeId && !selectedNodeIds.includes(input.primaryNodeId)) {
    throw new Error("A conversation route primary node must be explicitly selected");
  }
  if (actionable && (!input.primaryNodeId || !input.coordination)) {
    throw new Error("An actionable conversation route requires explicit primary and coordination decisions");
  }
  if (!actionable && (input.primaryNodeId || input.coordination)) {
    throw new Error("A non-actionable conversation route cannot carry execution coordination");
  }
  if (input.coordination?.validationScope === "repository-wide"
    && input.coordination.reviewMode !== "reviewed") {
    throw new Error("Repository-wide validation requires reviewed coordination");
  }
  const primaryNodeId = input.primaryNodeId;
  const coordination = input.coordination
    ? {
        reviewMode: input.coordination.reviewMode,
        validationScope: input.coordination.validationScope,
      }
    : undefined;
  const content = {
    conversationId: input.conversationId,
    inReplyTo: input.inReplyTo,
    disposition,
    selectedNodeIds,
    ...(primaryNodeId ? { primaryNodeId } : {}),
    ...(coordination ? { coordination } : {}),
    tags: normalizeCodingConversationTagsWithRequired([
      "routing:roster",
      `disposition:${disposition}`,
      ...(actionable ? ["intent:execution", "routing:nodes"] : []),
      ...(disposition === "investigating" ? ["intent:investigation", "authority:read-only"] : []),
      ...(disposition === "informational" ? ["intent:informational"] : []),
      ...(disposition === "operational" ? ["intent:operational"] : []),
      ...(disposition === "needs_clarification" ? ["intent:clarification"] : []),
    ], [
      ...(input.tags ?? []),
    ]),
    questions,
    ...(directAnswer && answer ? { answer } : {}),
    rationale: input.rationale.trim().slice(0, 2_000),
    confidence,
  };
  return {
    schema: CODING_CONVERSATION_SCHEMA,
    routeId: `coding_route_${hashCanonical(content).slice(0, 28)}`,
    ...content,
    createdAt: input.createdAt ?? Date.now(),
  };
};

const plannerSchema = z.object({
  disposition: z.enum(["ready", "investigating", "informational", "operational", "needs_clarification", "escalated", "declined"]),
  selectedNodeIds: z.array(z.string()).max(12),
  // OpenAI Structured Outputs requires every object property to be present.
  // Nullable preserves "no primary" without generating an optional property.
  primaryNodeId: z.string().nullable(),
  coordination: codingConversationCoordinationSchema.nullable(),
  tags: z.array(z.string()).max(MAX_TAGS),
  questions: z.array(z.string()).max(4),
  answer: z.string().max(4_000).nullable(),
  rationale: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1),
});

type CodingConversationPlannerResult = Awaited<ReturnType<CodingConversationPlanner>>;

export const CODING_CONVERSATION_PLANNER_OUTPUT_CONTRACT = {
  type: "object",
  additionalProperties: false,
  required: [
    "disposition",
    "selectedNodeIds",
    "primaryNodeId",
    "coordination",
    "tags",
    "questions",
    "answer",
    "rationale",
    "confidence",
  ],
  properties: {
    disposition: {
      type: "string",
      enum: ["ready", "investigating", "informational", "operational", "needs_clarification", "escalated", "declined"],
    },
    selectedNodeIds: {
      type: "array",
      maxItems: 12,
      items: { type: "string" },
    },
    primaryNodeId: {
      type: ["string", "null"],
    },
    coordination: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["reviewMode", "validationScope"],
          properties: {
            reviewMode: { type: "string", enum: ["fast", "reviewed"] },
            validationScope: { type: "string", enum: ["focused", "repository-wide"] },
          },
        },
        { type: "null" },
      ],
    },
    tags: {
      type: "array",
      maxItems: MAX_TAGS,
      items: { type: "string" },
    },
    questions: {
      type: "array",
      maxItems: 4,
      items: { type: "string", maxLength: 1_000 },
    },
    answer: {
      type: ["string", "null"],
      maxLength: 4_000,
    },
    rationale: {
      type: "string",
      minLength: 1,
      maxLength: 2_000,
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
  },
} as const satisfies JsonValue;

const humanNode = (nodes: ReadonlyArray<WorkspaceNode>): WorkspaceNode | undefined =>
  nodes.find((node) => node.id === CODING_HUMAN_NODE_ID || node.metadata?.participantKind === "human");

const mentionAlias = (value: string): string => {
  let normalized = value
    .trim()
    .toLowerCase()
    .split("")
    .reduce((alias, character) => {
      const allowed = isAsciiLower(character)
        || isAsciiDigit(character)
        || character === "."
        || character === "_"
        || character === "-";
      if (allowed) return `${alias}${character}`;
      return alias.endsWith("-") ? alias : `${alias}-`;
    }, "");
  while (normalized.startsWith("-")) normalized = normalized.slice(1);
  while (normalized.endsWith("-")) normalized = normalized.slice(0, -1);
  return normalized;
};

const workspaceNodeMentionAliases = (node: WorkspaceNode): ReadonlySet<string> => {
  const metadataAliases = [
    node.metadata?.givenName,
    node.metadata?.displayRole,
    node.metadata?.specialty,
  ].filter((value): value is string => typeof value === "string");
  return new Set([
    mentionAlias(node.id),
    mentionAlias(node.name),
    ...metadataAliases.map(mentionAlias),
  ].filter(Boolean));
};

const mentionedWorkspaceNodes = (
  mentions: ReadonlyArray<string>,
  nodes: ReadonlyArray<WorkspaceNode>,
): ReadonlyArray<WorkspaceNode> => {
  const requested = new Set(mentions.map(mentionAlias).filter(Boolean));
  return nodes.filter((node) => [...workspaceNodeMentionAliases(node)].some((alias) => requested.has(alias)));
};

export const codingConversationMentionedNodeIds = (
  mentions: ReadonlyArray<string>,
  nodes: ReadonlyArray<WorkspaceNode>,
): ReadonlyArray<string> => mentionedWorkspaceNodes(mentions, nodes).map((node) => node.id);

/** The shared saved-node eligibility boundary for independent coding review. */
export const isCodingReviewEligibleNode = (
  node: WorkspaceNode | undefined,
  primaryNodeId: string,
): node is WorkspaceNode => Boolean(
  node
  && node.id !== primaryNodeId
  && node.metadata?.participantKind !== "human"
  && (node.capabilities.includes("review") || node.metadata?.role === "supervisor"),
);

const validatePlannerSelection = (
  result: z.infer<typeof plannerSchema>,
  nodes: ReadonlyArray<WorkspaceNode>,
): CodingConversationPlannerResult => {
  const allowed = new Set(nodes.map((node) => node.id));
  const invalidNodeId = result.selectedNodeIds.find((nodeId) => !allowed.has(nodeId));
  if (invalidNodeId) throw new Error(`Conversation planner selected unknown workspace node ${invalidNodeId}`);
  const selected = result.disposition === "informational"
    ? result.tags.includes("routing:participants")
      ? boundedOrderedUnique(result.selectedNodeIds, 12)
      : []
    : boundedUnique(result.selectedNodeIds, 12);
  const human = humanNode(nodes);
  const actionable = result.disposition === "ready" || result.disposition === "investigating" || result.disposition === "escalated";
  const investigation = result.disposition === "investigating";
  const primaryNodeId = actionable ? result.primaryNodeId ?? undefined : undefined;
  if (actionable) {
    if (!result.coordination) throw new Error("An actionable conversation route requires a coordination plan");
    if (!primaryNodeId || !allowed.has(primaryNodeId) || primaryNodeId === human?.id) {
      throw new Error("An actionable conversation route requires an explicit saved non-human primary node");
    }
    const primaryNode = nodes.find((node) => node.id === primaryNodeId);
    if (!primaryNode
      || (investigation
        ? !primaryNode.capabilities.some((capability) => capability === "respond" || capability === "review" || capability === "implement")
        : (!primaryNode.capabilities.includes("implement") && primaryNode.metadata?.role !== "worker"))) {
      throw new Error(investigation
        ? "An investigation route requires a repository-capable primary node"
        : "An actionable conversation route requires a mutation-capable primary node");
    }
    if (!selected.includes(primaryNodeId)) {
      throw new Error("The actionable conversation route must include its primary node in selectedNodeIds");
    }
    const independentReviewSelected = selected.some((nodeId) => {
      const node = nodes.find((candidate) => candidate.id === nodeId);
      return isCodingReviewEligibleNode(node, primaryNodeId);
    });
    if (result.coordination.reviewMode === "reviewed" && !independentReviewSelected) {
      throw new Error("A reviewed conversation route requires an explicitly selected independent review node");
    }
    if (result.coordination.reviewMode === "fast" && independentReviewSelected && !investigation) {
      throw new Error("A fast conversation route cannot include an independent review node");
    }
    if (result.coordination.validationScope === "repository-wide"
      && result.coordination.reviewMode !== "reviewed") {
      throw new Error("Repository-wide validation requires reviewed coordination");
    }
    if (result.disposition === "escalated"
      && (result.coordination.reviewMode !== "reviewed"
        || result.coordination.validationScope !== "repository-wide")) {
      throw new Error("An escalated conversation route requires reviewed repository-wide coordination");
    }
    if (result.answer !== null) throw new Error("An actionable conversation route cannot include an answer");
  } else {
    if (result.coordination !== null) throw new Error("A non-actionable conversation route cannot include coordination");
    if (result.primaryNodeId !== null) throw new Error("A non-actionable conversation route cannot include a primary node");
    if (result.disposition === "informational" || result.disposition === "operational") {
      if (result.disposition === "operational" && selected.length > 0) {
        throw new Error("An operational conversation route cannot select workspace nodes");
      }
      if (result.disposition === "informational") {
        const invalidResponder = selected.find((nodeId) => {
          const node = nodes.find((candidate) => candidate.id === nodeId);
          return !node
            || node.id === "coordinator"
            || node.id === human?.id
            || node.metadata?.participantKind === "human"
            || node.metadata?.participantKind === "system";
        });
        if (invalidResponder) {
          throw new Error(`An informational conversation route selected non-agent responder ${invalidResponder}`);
        }
      }
      if (!result.answer?.trim()) throw new Error(`An ${result.disposition} conversation route requires an answer`);
    } else if (result.disposition === "needs_clarification") {
      if (!human || !selected.includes(human.id)) {
        throw new Error("A clarification route must explicitly select the saved human participant");
      }
      if (result.answer !== null) throw new Error("A clarification route cannot include an answer");
    } else if (result.disposition === "declined") {
      if (selected.length > 0) throw new Error("A declined conversation route cannot select workspace nodes");
      if (result.answer !== null) throw new Error("A declined conversation route cannot include an answer");
    }
  }
  // A ready route is already the planner's bounded declaration of the
  // specialists relevant to this change. Expanding every saved dependency at
  // that point turns a narrow leaf concern (for example UI state) into the
  // repository's entire collaboration topology. Reserve transitive closure
  // for explicitly escalated, cross-boundary work; ready routes keep only the
  // selected mutation peer and independent review peers.
  if (result.disposition === "escalated") {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (let index = 0; index < selected.length && selected.length < 12; index += 1) {
      const node = byId.get(selected[index]!);
      for (const dependencyId of node ? codingWorkspaceNodeDependencyIds(node) : []) {
        const dependency = byId.get(dependencyId);
        if (!dependency || dependency.metadata?.participantKind === "human" || selected.includes(dependencyId)) continue;
        selected.push(dependencyId);
        if (selected.length >= 12) break;
      }
    }
  }
  const {
    primaryNodeId: _requestedPrimaryNodeId,
    coordination: _requestedCoordination,
    answer,
    ...baseResult
  } = result;
  return {
    ...baseResult,
    selectedNodeIds: result.disposition === "informational"
      ? boundedOrderedUnique(selected, Math.max(1, Math.min(12, nodes.length)))
      : boundedUnique(selected, Math.max(1, Math.min(12, nodes.length))),
    ...(primaryNodeId ? { primaryNodeId } : {}),
    ...(result.coordination ? { coordination: result.coordination } : {}),
    ...((result.disposition === "informational" || result.disposition === "operational") && answer?.trim()
      ? { answer: answer.trim() }
      : {}),
    tags: [...normalizeCodingConversationTags(result.tags)],
    questions: boundedUnique(result.questions, 4),
  };
};

export const validateCodingConversationPlannerResult = (
  result: CodingConversationPlannerResult,
  nodes: ReadonlyArray<WorkspaceNode>,
): CodingConversationPlannerResult => {
  const disposition = result.disposition;
  const actionable = disposition === "ready" || disposition === "investigating" || disposition === "escalated";
  const human = humanNode(nodes);
  const normalizedAuthorityFields = actionable
    ? { answer: null }
    : disposition === "needs_clarification"
      ? {
          selectedNodeIds: human ? [human.id] : result.selectedNodeIds,
          primaryNodeId: null,
          coordination: null,
          answer: null,
        }
      : {
          selectedNodeIds: disposition === "informational" ? result.selectedNodeIds : [],
          primaryNodeId: null,
          coordination: null,
          questions: [],
          answer: disposition === "informational" || disposition === "operational"
            ? result.answer ?? null
            : null,
        };
  return validatePlannerSelection(plannerSchema.parse({
    ...result,
    primaryNodeId: result.primaryNodeId ?? null,
    coordination: result.coordination ?? null,
    ...normalizedAuthorityFields,
  }), nodes);
};

const codingConversationRosterContext = (
  workspaceNodes: ReadonlyArray<WorkspaceNode>,
): ReadonlyArray<JsonValue> => workspaceNodes
  .filter((node) => node.id !== "coordinator")
  .map((node) => ({
    id: node.id,
    name: node.name,
    capabilities: node.capabilities,
    specialty: typeof node.metadata?.specialty === "string" ? node.metadata.specialty : null,
    participantKind: typeof node.metadata?.participantKind === "string"
      ? node.metadata.participantKind
      : "agent",
    responsibility: typeof node.metadata?.repositoryReason === "string"
      ? node.metadata.repositoryReason
      : null,
    specialization: typeof node.metadata?.specializationSummary === "string"
      ? node.metadata.specializationSummary
      : null,
    skills: Array.isArray(node.metadata?.specialistSkills)
      ? node.metadata.specialistSkills.filter((skill): skill is JsonValue =>
          typeof skill === "string")
      : [],
    toolRequirements: Array.isArray(node.metadata?.toolRequirements)
      ? node.metadata.toolRequirements.filter((tool): tool is JsonValue =>
          typeof tool === "string")
      : [],
    dependsOnNodeIds: codingWorkspaceNodeDependencyIds(node),
  }));

export const codingConversationTranscript = (
  messages: ReadonlyArray<CodingConversationMessage>,
  routes: ReadonlyArray<CodingConversationRoute> = [],
): ReadonlyArray<JsonValue> => {
  const authoredReplyIds = new Set(messages.flatMap((message) =>
    message.author.kind !== "user" && message.replyTo ? [message.replyTo] : []));
  const entries: Array<{ readonly createdAt: number; readonly value: JsonValue }> = [
    ...messages.map((message) => ({
      createdAt: message.createdAt,
      value: {
        kind: "message",
        id: message.messageId,
        createdAt: message.createdAt,
        author: {
          kind: message.author.kind,
          id: message.author.id,
          name: message.author.name,
        },
        text: message.text,
        tags: message.tags,
        mentions: message.mentions,
        attachments: message.attachments.map(({ artifactId, name, mediaType, width, height }) => ({
          kind: "image",
          artifactId,
          name,
          mediaType,
          ...(width ? { width } : {}),
          ...(height ? { height } : {}),
        })),
        replyTo: message.replyTo ?? null,
      },
    })),
    ...routes.flatMap((route) => {
      if (authoredReplyIds.has(route.inReplyTo)) return [];
      const text = route.answer
        ?? (route.questions.length > 0 ? route.questions.join("\n") : undefined);
      return text ? [{
        createdAt: route.createdAt,
        value: {
          kind: "route",
          id: route.routeId,
          createdAt: route.createdAt,
          author: {
            kind: "system",
            id: "coordinator",
            name: "Roster",
          },
          text,
          disposition: route.disposition,
          inReplyTo: route.inReplyTo,
        },
      }] : [];
    }),
  ];
  return entries
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-40)
    .map((entry) => entry.value);
};

export const codingConversationModelContext = (input: CodingConversationPlannerInput & {
  readonly runtimeContext?: JsonValue;
}): JsonValue => ({
  ...(input.productContext ? { productContext: input.productContext } : {}),
  repositoryContext: input.repositoryContext,
  ...(input.runtimeContext !== undefined ? { runtimeContext: input.runtimeContext } : {}),
  ...(input.collaborationContext ? { collaborationContext: input.collaborationContext } : {}),
  ...(input.activeRunContext ? { activeRunContext: input.activeRunContext } : {}),
  ...(input.responder ? {
    responder: {
      nodeId: input.responder.id,
      name: typeof input.responder.metadata?.givenName === "string"
        ? input.responder.metadata.givenName
        : input.responder.name.split(",", 1)[0] ?? input.responder.name,
      role: typeof input.responder.metadata?.displayRole === "string"
        ? input.responder.metadata.displayRole
        : input.responder.capabilities[0] ?? "Agent",
      instruction: "Write the informational answer as this participant. Reply to the latest speaker; do not ask this participant to answer and do not tag this participant.",
    },
  } : {}),
  roster: codingConversationRosterContext(input.workspaceNodes),
  transcript: codingConversationTranscript(input.messages, input.routes),
});

/**
 * Model-planned routing with deterministic Roster validation. The model may use
 * new namespaced tags without a routing-table migration, but it may only bind
 * saved logical nodes and cannot exceed the workspace population bound.
 */
export const modelCodingConversationPlanner = (
  llmStructured: LlmStructured,
  configuredModel?: string,
): CodingConversationPlanner =>
  async (input) => {
    const { workspaceNodes } = input;
    const result = await llmStructured({
      ...(configuredModel?.trim() ? { model: configuredModel.trim() } : {}),
      system: [
        CODING_COORDINATION_SKILL.instructions,
        "Use productContext and runtimeContext as factual metadata when relevant; do not invent missing product facts.",
        "When activeRunContext is present, treat it as the exact durable live status. Route status questions and check-ins as informational unless the latest message changes the requested work, and include a concise direct answer in that informational route. Route repository questions that require file inspection as investigating, tracked-content changes as ready or escalated, and host process, checkout, or browser actions as operational.",
        "When collaborationContext is awaiting_human, the latest human message answers or refines the listed unresolved subjects. Route the continuation using that exact context.",
        "When responder is present, the informational answer must be written in that saved participant's voice as their reply to the latest speaker. Never describe or summon the responder in third person.",
        "Use open namespaced tags such as domain:data, intent:clarification, risk:security, source:pr-comment.",
      ].join(" "),
      user: JSON.stringify(codingConversationModelContext({
        ...input,
        runtimeContext: {
          kind: "openai",
          ...(configuredModel?.trim() ? { model: configuredModel.trim() } : {}),
          executionAuthority: {
            repositoryMutation: "route-only",
            hostProcess: "none",
            browserControl: "none",
            currentCheckoutGit: "none",
          },
        },
      })),
      schema: plannerSchema,
      schemaName: "coding_conversation_route",
    });
    return validatePlannerSelection(result.parsed, workspaceNodes);
  };

export const modelCodingConversationAnswerer = (
  llmText: CodingConversationTextModel,
  configuredModel: string,
): CodingConversationAnswerer => async ({
  messages,
  routes,
  workspaceNodes,
  responder,
  repositoryContext,
  productContext,
  activeRunContext,
  onDelta,
}) => {
  const responderName = typeof responder?.metadata?.givenName === "string"
    ? responder.metadata.givenName
    : responder?.name.split(",")[0]?.trim() ?? responder?.name;
  const responderRole = typeof responder?.metadata?.displayRole === "string"
    ? responder.metadata.displayRole
    : typeof responder?.metadata?.specialty === "string"
      ? responder.metadata.specialty
      : "saved workspace participant";
  const latestSpeaker = messages.at(-1)?.author;
  const answerMessages = responder && messages.length > 0
    ? messages.map((message, index) => {
        if (index !== messages.length - 1) return message;
        const addressedText = message.mentions.reduce(
          (text, mention) => text.replaceAll(
            mention.startsWith("@") ? mention : `@${mention}`,
            " ",
          ),
          message.text,
        )
          .replace(/\s+/gu, " ")
          .replace(/^[\s,.:;!?—-]+|[\s,.:;!?—-]+$/gu, "")
          .trim();
        return {
          ...message,
          text: addressedText || "Reply to the human's direct address.",
        };
      })
    : messages;
  const answer = await llmText({
    model: configuredModel,
    system: [
      ...(responder ? [
        `You are ${responderName}, the saved ${responderRole} in this repository team room.`,
        latestSpeaker?.kind === "agent"
          ? `Reply in the room to ${latestSpeaker.name}'s request as this participant. If they asked you to introduce yourself or answer the human, address the human directly.`
          : "Reply directly to the human as this participant, grounded in your saved identity, specialty, capabilities, and the supplied repository context.",
        "Let your specialty shape what you notice, but do not recite your role or reintroduce yourself unless the human asks.",
        `The latest @mention addresses you (${responderName}); it is not automatically the human's name.`,
        "If the speaker asks you to tag one teammate and request a reply, use that saved teammate’s exact @GivenName in your answer. That explicit mention creates one bounded conversational handoff; merely writing their plain name does not.",
        "Do not tag a teammate unless the speaker actually asks for that handoff, and never tag yourself.",
        "Do not speak as Roster or describe yourself as the coordinator.",
      ] : [
        "You are Roster, the conversational host of an ongoing repository team room, never one of the saved agents.",
        "Roster is the orchestration system behind the room, not an agent or teammate; use first person only for Roster's own coordination behavior.",
      ]),
      "Continue the ongoing exchange and answer what the human means, not merely the literal wording of the latest message.",
      "Sound like an experienced collaborator: use ordinary conversational language, contractions when natural, and specific repository details that actually help.",
      "Lead with the answer or reaction. Do not open with a status label, repeat the question, or narrate routing and orchestration unless it matters to the answer.",
      "Prefer one cohesive paragraph built around a clear through-line, analogy, or concrete example; do not turn every concept into a serial definition, checklist, or reading list.",
      "Default to two to five natural sentences. Treat that as a real editing constraint: combine related details instead of emitting a seven-step tour.",
      "Use headings or bullets only when the human asks for a breakdown or the answer is genuinely easier to scan that way.",
      "When the human says an earlier answer was abstract, confusing, stiff, or otherwise unhelpful, acknowledge that briefly and immediately replace it with a more concrete explanation.",
      "Acknowledge uncertainty or frustration briefly when present, then move the conversation forward.",
      "When identity, membership, capability, or comparison matters to the answer, ground it in the actual saved agents, their roles, and how they coordinate; do not invent people or flatten distinct specialties into one persona.",
      "Do not say you need more detail before creating a branch or starting an agent unless the user actually requested a repository mutation.",
      "Do not ask a follow-up question when a useful qualified answer is possible.",
      "Use productContext and runtimeContext as factual metadata when they are relevant. Do not invent missing product facts.",
      "When activeRunContext is present, answer status questions directly from it. Clearly distinguish work in progress, queued work, accepted work, and failures; do not claim a task is complete unless the context says it is accepted.",
      "Resolve corrections and references from the chronological transcript, including Roster's preceding answers.",
      "Keep the answer concise by default, but do not sacrifice warmth, continuity, or a useful explanation to hit an arbitrary word count.",
    ].join(" "),
    user: JSON.stringify(codingConversationModelContext({
      conversationId: messages.at(-1)?.conversationId ?? "conversation",
      messages: answerMessages,
      routes,
      workspaceNodes,
      repositoryContext,
      productContext,
      activeRunContext,
      runtimeContext: {
        kind: "openai",
        model: configuredModel,
        responsibility: responder
          ? `direct reply as saved workspace node ${responder.id}`
          : "conversation planning and answers",
        executionAuthority: {
          repositoryMutation: "route-only",
          hostProcess: "none",
          browserControl: "none",
          currentCheckoutGit: "none",
        },
      },
    })),
    ...(onDelta && !responder ? { onDelta } : {}),
    });
  if (!responder || !responderName) return answer;
  const lowerAnswer = answer.toLocaleLowerCase();
  const lowerName = responderName.toLocaleLowerCase();
  const greeting = ["hello", "hi", "hey"].find((candidate) =>
    lowerAnswer.startsWith(candidate));
  if (!greeting) {
    await onDelta?.(answer);
    return answer;
  }
  let cursor = greeting.length;
  while (cursor < answer.length && (answer[cursor] === " " || answer[cursor] === ",")) cursor += 1;
  if (!lowerAnswer.slice(cursor).startsWith(lowerName)) {
    await onDelta?.(answer);
    return answer;
  }
  const boundary = answer[cursor + responderName.length];
  if (boundary && !/[\s,.!?:;—-]/u.test(boundary)) {
    await onDelta?.(answer);
    return answer;
  }
  const remainder = answer.slice(cursor + responderName.length)
    .replace(/^[\s,.!?:;—-]+/u, "")
    .trim();
  const sanitized = `${greeting[0]?.toUpperCase() ?? ""}${greeting.slice(1)}!${
    remainder
      ? ` ${remainder[0]?.toUpperCase() ?? ""}${remainder.slice(1)}`
      : ""
  }`;
  await onDelta?.(sanitized);
  return sanitized;
};

export const codingConversationImageEvent = (
  image: CodingConversationImage,
): Extract<OrchestrationEvent, { readonly type: "artifact.published" }> => inlineArtifactPublishedEvent({
  runId: image.conversationId,
  artifactId: image.artifactId,
  origin: "input",
  outputKey: `conversation_image_${image.artifactId}`,
  nodeId: CODING_HUMAN_NODE_ID,
  kind: CODING_CONVERSATION_IMAGE_KIND,
  inputVersions: {},
}, JSON.stringify(image));

export const codingConversationMessageEvent = (
  message: CodingConversationMessage,
): Extract<OrchestrationEvent, { readonly type: "artifact.published" }> => inlineArtifactPublishedEvent({
  runId: message.conversationId,
  artifactId: message.messageId,
  origin: "input",
  outputKey: `conversation_message_${message.messageId}`,
  nodeId: message.author.id,
  kind: CODING_CONVERSATION_MESSAGE_KIND,
  inputVersions: {},
}, JSON.stringify(message));

export const codingConversationRouteEvent = (
  route: CodingConversationRoute,
): Extract<OrchestrationEvent, { readonly type: "artifact.published" }> => inlineArtifactPublishedEvent({
  runId: route.conversationId,
  artifactId: route.routeId,
  origin: "input",
  outputKey: `conversation_route_${route.routeId}`,
  nodeId: "coordinator",
  kind: CODING_CONVERSATION_ROUTE_KIND,
  inputVersions: { message: route.inReplyTo },
}, JSON.stringify(route));

const parsed = <Value>(value: string, schema: z.ZodType<Value>): Value | undefined => {
  try {
    const result = schema.safeParse(JSON.parse(value));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

const messageSchema: z.ZodType<CodingConversationMessage> = z.object({
  schema: z.literal(CODING_CONVERSATION_SCHEMA),
  messageId: z.string(),
  conversationId: z.string(),
  workspaceId: z.string().optional(),
  author: z.object({ kind: z.enum(["user", "agent", "system"]), id: z.string(), name: z.string() }),
  source: z.object({
    kind: z.enum(["ui", "api", "pr-comment", "review-comment", "agent"]),
    provider: z.string().optional(),
    repository: z.string().optional(),
    externalId: z.string().optional(),
    revision: z.string().optional(),
    url: z.string().optional(),
  }),
  text: z.string(),
  tags: z.array(z.string()),
  mentions: z.array(z.string()),
  attachments: z.array(z.object({
    kind: z.literal("image"),
    artifactId: z.string(),
    name: z.string(),
    mediaType: z.enum(CODING_CONVERSATION_IMAGE_MEDIA_TYPES),
    width: z.number().optional(),
    height: z.number().optional(),
  })).default([]),
  replyTo: z.string().optional(),
  createdAt: z.number(),
});

const imageSchema: z.ZodType<CodingConversationImage> = z.object({
  schema: z.literal(CODING_CONVERSATION_SCHEMA),
  kind: z.literal("image"),
  artifactId: z.string(),
  conversationId: z.string(),
  name: z.string(),
  mediaType: z.enum(CODING_CONVERSATION_IMAGE_MEDIA_TYPES),
  dataUrl: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  createdAt: z.number(),
});

const routeSchema: z.ZodType<CodingConversationRoute> = z.object({
  schema: z.literal(CODING_CONVERSATION_SCHEMA),
  routeId: z.string(),
  conversationId: z.string(),
  inReplyTo: z.string(),
  disposition: z.enum(["ready", "investigating", "informational", "operational", "needs_clarification", "escalated", "declined"]),
  selectedNodeIds: z.array(z.string()),
  primaryNodeId: z.string().optional(),
  coordination: codingConversationCoordinationSchema.optional(),
  tags: z.array(z.string()),
  questions: z.array(z.string()),
  answer: z.string().optional(),
  rationale: z.string(),
  confidence: z.number(),
  createdAt: z.number(),
});

export const codingConversationFromEvents = (events: ReadonlyArray<OrchestrationEvent>): {
  readonly messages: ReadonlyArray<CodingConversationMessage>;
  readonly images: ReadonlyArray<CodingConversationImage>;
  readonly routes: ReadonlyArray<CodingConversationRoute>;
} => {
  const messages: CodingConversationMessage[] = [];
  const images: CodingConversationImage[] = [];
  const routes: CodingConversationRoute[] = [];
  for (const event of events) {
    if (event.type !== "artifact.published" || event.payload.storage !== "inline") continue;
    if (event.kind === CODING_CONVERSATION_MESSAGE_KIND) {
      const message = parsed(event.payload.value, messageSchema);
      if (message) messages.push(message);
    } else if (event.kind === CODING_CONVERSATION_IMAGE_KIND) {
      const image = parsed(event.payload.value, imageSchema);
      if (image) images.push(image);
    } else if (event.kind === CODING_CONVERSATION_ROUTE_KIND) {
      const route = parsed(event.payload.value, routeSchema);
      if (route) routes.push(route);
    }
  }
  return {
    messages: messages.sort((left, right) => left.createdAt - right.createdAt || left.messageId.localeCompare(right.messageId)),
    images: images.sort((left, right) => left.createdAt - right.createdAt || left.artifactId.localeCompare(right.artifactId)),
    routes: routes.sort((left, right) => left.createdAt - right.createdAt || left.routeId.localeCompare(right.routeId)),
  };
};

export const codingConversationObjective = (messages: ReadonlyArray<CodingConversationMessage>): string =>
  messages
    .filter((message) => message.author.kind === "user")
    .map((message, index) => index === 0 ? message.text : `Follow-up ${index}: ${message.text}`)
    .join("\n\n")
    .slice(0, MAX_MESSAGE_CHARS);
