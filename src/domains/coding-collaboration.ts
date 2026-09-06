import { z } from "zod";

import { hashCanonical } from "../core/canonical.js";
import type { ArtifactConflict, ArtifactProjection } from "../engine/artifact/shared-crdt.js";
import type {
  SharedWorkspaceValue,
  WorkspaceEntryInput,
} from "../engine/workspace/shared-workspace.js";

const boundedId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const boundedText = (max: number) => z.string().trim().min(1).max(max);
// Semantic control fields stay strict. Model-authored prose is diagnostic, so
// normalize it to the shared-workspace bounds instead of discarding an
// otherwise valid contribution because one explanation ran long.
const normalizedPeerText = (max: number) => z.string().trim().min(1)
  .transform((value) => value.slice(0, max));
const evidenceSchema = z.array(normalizedPeerText(500)).max(12).default([]);

export const codingPeerProposalSchema = z.object({
  status: z.literal("proposal"),
  summary: normalizedPeerText(1_200),
  recommendations: z.array(z.object({
    subjectId: boundedId,
    recommendation: normalizedPeerText(1_600),
    rationale: normalizedPeerText(1_600),
    evidence: evidenceSchema,
    confidence: z.number().min(0).max(1),
  }).strict()).min(1).max(8),
  questions: z.array(normalizedPeerText(600)).max(6).default([]),
}).strict();

export const codingPeerResponseSchema = z.object({
  status: z.literal("response"),
  summary: normalizedPeerText(1_200),
  answers: z.array(z.object({
    subjectId: boundedId,
    response: normalizedPeerText(1_600),
    rationale: normalizedPeerText(1_600),
    evidence: evidenceSchema,
    confidence: z.number().min(0).max(1),
  }).strict()).max(8),
  openQuestions: z.array(z.object({
    subjectId: boundedId,
    question: normalizedPeerText(600),
    reason: normalizedPeerText(1_000),
  }).strict()).max(6),
}).strict();

export const codingPeerResolutionSchema = z.object({
  status: z.enum(["aligned", "resolved", "ambiguous"]),
  summary: normalizedPeerText(1_600),
  decisions: z.array(z.object({
    subjectId: boundedId,
    resolution: normalizedPeerText(1_600),
    rationale: normalizedPeerText(1_600),
    evidence: evidenceSchema,
  }).strict()).max(12),
  unresolved: z.array(z.object({
    subjectId: boundedId,
    reason: normalizedPeerText(1_000),
    candidateSummaries: z.array(normalizedPeerText(600)).min(1).max(8),
  }).strict()).max(8),
}).strict().superRefine((resolution, context) => {
  const decisionSubjects = new Set<string>();
  for (const [index, decision] of resolution.decisions.entries()) {
    if (decisionSubjects.has(decision.subjectId)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate resolution subjectId: ${decision.subjectId}`,
        path: ["decisions", index, "subjectId"],
      });
    }
    decisionSubjects.add(decision.subjectId);
  }
  const unresolvedSubjects = new Set<string>();
  for (const [index, unresolved] of resolution.unresolved.entries()) {
    if (unresolvedSubjects.has(unresolved.subjectId)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate unresolved subjectId: ${unresolved.subjectId}`,
        path: ["unresolved", index, "subjectId"],
      });
    }
    if (decisionSubjects.has(unresolved.subjectId)) {
      context.addIssue({
        code: "custom",
        message: `A subject cannot be both decided and unresolved: ${unresolved.subjectId}`,
        path: ["unresolved", index, "subjectId"],
      });
    }
    unresolvedSubjects.add(unresolved.subjectId);
  }
  if (resolution.status === "ambiguous" && resolution.unresolved.length === 0) {
    context.addIssue({
      code: "custom",
      message: "An ambiguous resolution must name at least one unresolved subject",
      path: ["unresolved"],
    });
  }
  if (resolution.status !== "ambiguous" && resolution.unresolved.length > 0) {
    context.addIssue({
      code: "custom",
      message: "Only an ambiguous resolution may contain unresolved subjects",
      path: ["unresolved"],
    });
  }
});

const normalizedEndorsementText = (max: number) => z.string().trim().min(1)
  .transform((value) => value.slice(0, max));
const normalizedEndorsementEvidence = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Object.entries(value).map(([key, entry]) => ({ [key]: entry }));
  }
  return value === null || value === undefined ? [] : [value];
}, z.array(z.unknown()))
  .transform((values) => [...new Set(values.flatMap((value) => {
    const text = typeof value === "string"
      ? value.trim()
      : value === null || value === undefined
        ? ""
        : JSON.stringify(value);
    return text ? [text.slice(0, 500)] : [];
  }))].slice(0, 12));

export const codingPeerEndorsementSchema = z.object({
  verdict: z.enum(["approve", "changes_requested"]),
  frontierHash: boundedText(200),
  // Verdict and frontier are control fields. Human-authored summaries and
  // evidence are diagnostic, so normalize them to the shared-workspace bounds
  // instead of discarding an otherwise valid certification.
  summary: normalizedEndorsementText(1_200),
  evidence: normalizedEndorsementEvidence.default([]),
}).passthrough();

export type CodingPeerProposal = z.infer<typeof codingPeerProposalSchema>;
export type CodingPeerResponse = z.infer<typeof codingPeerResponseSchema>;
export type CodingPeerResolution = z.infer<typeof codingPeerResolutionSchema>;
export type CodingPeerEndorsement = z.infer<typeof codingPeerEndorsementSchema>;

export const CODING_COLLABORATION_ARTIFACT_KIND = "roster-workspace";
export const CODING_COLLABORATION_SCHEMA_VERSION = "roster-workspace/v3";
export const CODING_COLLABORATION_RESOLUTION_OUTPUT = "collaboration_resolution";
export const CODING_COLLABORATION_PROPOSAL_PREFIX = "collaboration_proposal_";
export const CODING_COLLABORATION_RESPONSE_PREFIX = "collaboration_response_";
export const CODING_COLLABORATION_ENDORSEMENT_PREFIX = "collaboration_endorsement_";

export const codingCollaborationArtifactId = (runId: string): string =>
  `coding:${runId}:collaboration`;

export const codingCollaborationProposalOutputKey = (specialty: string): string =>
  `${CODING_COLLABORATION_PROPOSAL_PREFIX}${specialty}`;

export const codingCollaborationEndorsementOutputKey = (specialty: string): string =>
  `${CODING_COLLABORATION_ENDORSEMENT_PREFIX}${specialty}`;

export const codingCollaborationResponseOutputKey = (specialty: string): string =>
  `${CODING_COLLABORATION_RESPONSE_PREFIX}${specialty}`;

export const isCodingCollaborationOutputKey = (outputKey: string): boolean =>
  outputKey === CODING_COLLABORATION_RESOLUTION_OUTPUT
  || outputKey.startsWith(CODING_COLLABORATION_PROPOSAL_PREFIX)
  || outputKey.startsWith(CODING_COLLABORATION_RESPONSE_PREFIX)
  || outputKey.startsWith(CODING_COLLABORATION_ENDORSEMENT_PREFIX);

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

export const parseCodingPeerProposal = (value: string): CodingPeerProposal | undefined => {
  const parsed = codingPeerProposalSchema.safeParse(parseJson(value));
  return parsed.success ? parsed.data : undefined;
};

export const parseCodingPeerResponse = (value: string): CodingPeerResponse | undefined => {
  const parsed = codingPeerResponseSchema.safeParse(parseJson(value));
  return parsed.success ? parsed.data : undefined;
};

export const parseCodingPeerResolution = (value: string): CodingPeerResolution | undefined => {
  const parsed = codingPeerResolutionSchema.safeParse(parseJson(value));
  return parsed.success ? parsed.data : undefined;
};

/**
 * Converts one validated ambiguous peer frontier plus the human participant's
 * accepted answer into a complete decision frontier. The answer is authority,
 * not another peer proposal: later execution must review the implementation,
 * but it must not reopen proposal/resolver rounds and invent serial preference
 * questions after the operator has answered the exact unresolved subjects.
 */
export const resolveCodingPeerAmbiguityWithHumanAnswer = (
  resolution: CodingPeerResolution,
  answer: string,
): CodingPeerResolution => {
  if (resolution.status !== "ambiguous" || resolution.unresolved.length === 0) {
    throw new Error("Human collaboration resolution requires an ambiguous peer frontier");
  }
  const normalizedAnswer = answer.trim();
  if (!normalizedAnswer) throw new Error("Human collaboration resolution requires a non-blank answer");
  return codingPeerResolutionSchema.parse({
    status: "resolved",
    summary: `The human participant resolved the remaining collaboration subjects. ${resolution.summary}`,
    decisions: [
      ...resolution.decisions,
      ...resolution.unresolved.map((subject) => ({
        subjectId: subject.subjectId,
        resolution: normalizedAnswer,
        rationale: `The human participant supplied the missing product context for ${subject.subjectId}: ${subject.reason}`,
        evidence: [
          `Human conversation answer: ${normalizedAnswer}`,
          ...subject.candidateSummaries.map((candidate) => `Prior candidate: ${candidate}`),
        ],
      })),
    ],
    unresolved: [],
  });
};

export const parseCodingPeerEndorsement = (value: string): CodingPeerEndorsement | undefined => {
  const parsed = codingPeerEndorsementSchema.safeParse(parseJson(value));
  return parsed.success ? parsed.data : undefined;
};

export type CodingCollaborationContribution = {
  readonly entry: Omit<WorkspaceEntryInput, "nodeId">;
  readonly inputVersions?: Readonly<Record<string, string>>;
};

export type CodingResolutionCoverage = {
  readonly conflictSubjectIds: ReadonlyArray<string>;
  readonly missingSubjectIds: ReadonlyArray<string>;
};

/**
 * Checks a structured resolution against the authoritative CRDT conflict set.
 * Subject ids are semantic protocol keys: a readable summary is never allowed
 * to stand in for an exact, machine-checkable decision.
 */
export const codingResolutionCoverage = (
  resolution: CodingPeerResolution,
  conflicts: ReadonlyArray<ArtifactConflict>,
): CodingResolutionCoverage => {
  const conflictSubjectIds = [...new Set(conflicts.map((conflict) =>
    conflict.subjectId.replace(/^decision:/, "")))].sort();
  const coveredSubjectIds = new Set([
    ...resolution.decisions.map((decision) => decision.subjectId),
    ...resolution.unresolved.map((unresolved) => unresolved.subjectId),
  ]);
  return {
    conflictSubjectIds,
    missingSubjectIds: conflictSubjectIds.filter((subjectId) => !coveredSubjectIds.has(subjectId)),
  };
};

/**
 * Converts one validated task output into bounded peer-authored workspace
 * entries. Semantic positions are exclusive decisions; explanations and
 * questions remain append-only so concurrent evidence is never overwritten.
 */
export const codingCollaborationContributions = (input: {
  readonly outputKey: string;
  readonly value: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly priorProjection?: ArtifactProjection<SharedWorkspaceValue>;
}): ReadonlyArray<CodingCollaborationContribution> => {
  const proposal = input.outputKey.startsWith(CODING_COLLABORATION_PROPOSAL_PREFIX)
    ? parseCodingPeerProposal(input.value)
    : undefined;
  if (proposal) {
    return [
      {
        entry: {
          kind: "finding",
          mode: "append",
          subjectId: `proposal-summary:${input.taskId}`,
          body: { type: "proposal-summary", summary: proposal.summary },
          references: [],
        },
      },
      ...proposal.recommendations.flatMap((recommendation): ReadonlyArray<CodingCollaborationContribution> => [
        {
          entry: {
            kind: "decision",
            mode: "exclusive",
            subjectId: recommendation.subjectId,
            body: { type: "position", recommendation: recommendation.recommendation },
            references: recommendation.evidence,
          },
        },
        {
          entry: {
            kind: "finding",
            mode: "append",
            subjectId: `rationale:${recommendation.subjectId}`,
            body: {
              type: "rationale",
              subjectId: recommendation.subjectId,
              rationale: recommendation.rationale,
              confidence: recommendation.confidence,
            },
            references: recommendation.evidence,
          },
        },
      ]),
      ...proposal.questions.map((question, index): CodingCollaborationContribution => ({
        entry: {
          kind: "message",
          mode: "append",
          subjectId: `question:${input.taskId}:${index + 1}`,
          body: { type: "question", text: question },
          references: [],
        },
      })),
    ];
  }

  const response = input.outputKey.startsWith(CODING_COLLABORATION_RESPONSE_PREFIX)
    ? parseCodingPeerResponse(input.value)
    : undefined;
  if (response) {
    return [
      {
        entry: {
          kind: "message",
          mode: "append",
          subjectId: `response-summary:${input.taskId}`,
          body: { type: "peer-response-summary", summary: response.summary },
          references: response.answers.flatMap((answer) => answer.evidence),
        },
      },
      ...response.answers.map((answer): CodingCollaborationContribution => ({
        entry: {
          kind: "finding",
          mode: "append",
          subjectId: `peer-response:${answer.subjectId}:${input.taskId}`,
          body: {
            type: "peer-response",
            subjectId: answer.subjectId,
            response: answer.response,
            rationale: answer.rationale,
            confidence: answer.confidence,
          },
          references: answer.evidence,
        },
      })),
      ...response.openQuestions.map((question, index): CodingCollaborationContribution => ({
        entry: {
          kind: "message",
          mode: "append",
          subjectId: `open-question:${question.subjectId}:${input.taskId}:${index + 1}`,
          body: {
            type: "open-question",
            subjectId: question.subjectId,
            question: question.question,
            reason: question.reason,
          },
          references: [],
        },
      })),
    ];
  }

  const resolution = input.outputKey === CODING_COLLABORATION_RESOLUTION_OUTPUT
    ? parseCodingPeerResolution(input.value)
    : undefined;
  if (resolution) {
    const conflictRefs = input.priorProjection?.conflicts.flatMap((conflict) => conflict.candidateUpdateIds) ?? [];
    const projectionVersion = input.priorProjection?.versionHash;
    return [
      {
        entry: {
          kind: "message",
          mode: "append",
          subjectId: `resolution-summary:${input.taskId}`,
          body: { type: "resolution-summary", status: resolution.status, summary: resolution.summary },
          references: conflictRefs,
        },
        ...(projectionVersion ? { inputVersions: { priorProjection: projectionVersion } } : {}),
      },
      ...resolution.decisions.map((decision): CodingCollaborationContribution => ({
        entry: {
          kind: "decision",
          mode: "exclusive",
          subjectId: decision.subjectId,
          body: {
            type: "resolution",
            resolution: decision.resolution,
            rationale: decision.rationale,
          },
          references: [...new Set([...conflictRefs, ...decision.evidence])],
        },
        ...(projectionVersion ? { inputVersions: { priorProjection: projectionVersion } } : {}),
      })),
      ...resolution.unresolved.map((unresolved): CodingCollaborationContribution => ({
        entry: {
          kind: "message",
          mode: "append",
          subjectId: `unresolved:${unresolved.subjectId}`,
          body: {
            type: "unresolved",
            subjectId: unresolved.subjectId,
            reason: unresolved.reason,
            candidateSummaries: unresolved.candidateSummaries,
          },
          references: conflictRefs,
        },
        ...(projectionVersion ? { inputVersions: { priorProjection: projectionVersion } } : {}),
      })),
    ];
  }

  const endorsement = input.outputKey.startsWith(CODING_COLLABORATION_ENDORSEMENT_PREFIX)
    ? parseCodingPeerEndorsement(input.value)
    : undefined;
  if (endorsement) {
    return [{
      entry: {
        kind: "evidence",
        mode: "append",
        subjectId: `endorsement:${input.nodeId}`,
        body: {
          type: "endorsement",
          verdict: endorsement.verdict,
          frontierHash: endorsement.frontierHash,
          summary: endorsement.summary,
        },
        references: endorsement.evidence,
      },
    }];
  }
  return [];
};

export const unresolvedCodingCollaborationConflicts = (
  resolution: CodingPeerResolution | undefined,
  updateIds: ReadonlyArray<string> = [],
): ReadonlyArray<ArtifactConflict> => {
  if (!resolution || resolution.status !== "ambiguous") return [];
  const unresolved = resolution.unresolved.length
    ? resolution.unresolved
    : [{ subjectId: "collaboration", reason: resolution.summary, candidateSummaries: [resolution.summary] }];
  return unresolved.map((item) => ({
    conflictId: `coding_conflict_${hashCanonical({ subjectId: item.subjectId, reason: item.reason, updateIds: [...updateIds].sort() }).slice(0, 24)}`,
    kind: "coding-ambiguity",
    subjectId: item.subjectId,
    candidateUpdateIds: [...updateIds].sort(),
    candidateHashes: item.candidateSummaries.map((candidate) => hashCanonical(candidate)).sort(),
  }));
};

export type CodingCollaborationStatus = {
  readonly phase: "idle" | "proposing" | "discussing" | "resolving" | "implementing" | "reviewing" | "certified" | "conflicted";
  readonly proposalCount: number;
  readonly responseCount: number;
  readonly endorsementCount: number;
  readonly peerCount: number;
  readonly conflictCount: number;
  readonly resolutionStatus?: CodingPeerResolution["status"];
  readonly summary?: string;
};

export const codingCollaborationStatus = (input: {
  readonly outputs: Readonly<Record<string, string>>;
  readonly taskStatuses: Readonly<Record<string, string>>;
  readonly peerCount: number;
  readonly certified: boolean;
}): CodingCollaborationStatus => {
  const proposalCount = Object.keys(input.outputs).filter((key) => key.startsWith(CODING_COLLABORATION_PROPOSAL_PREFIX)).length;
  const responseCount = Object.keys(input.outputs).filter((key) => key.startsWith(CODING_COLLABORATION_RESPONSE_PREFIX)).length;
  const endorsementCount = Object.keys(input.outputs).filter((key) => key.startsWith(CODING_COLLABORATION_ENDORSEMENT_PREFIX)).length;
  const resolution = parseCodingPeerResolution(input.outputs[CODING_COLLABORATION_RESOLUTION_OUTPUT] ?? "");
  const conflictCount = resolution?.unresolved.length ?? 0;
  const runningTask = Object.entries(input.taskStatuses).find(([, status]) => status === "running")?.[0] ?? "";
  const phase = input.certified
    ? "certified"
    : runningTask.startsWith("propose-")
        ? "proposing"
        : runningTask.startsWith("respond-")
          ? "discussing"
        : runningTask === "resolve-collaboration"
          ? "resolving"
          : runningTask === "implement" || runningTask === "remediate" || runningTask === "validate-repository"
            ? "implementing"
            : runningTask.startsWith("review-") || runningTask.startsWith("certify-")
              ? "reviewing"
              : resolution?.status === "ambiguous"
                ? "conflicted"
              : proposalCount ? "resolving" : "idle";
  return {
    phase,
    proposalCount,
    responseCount,
    endorsementCount,
    peerCount: input.peerCount,
    conflictCount,
    ...(resolution ? { resolutionStatus: resolution.status, summary: resolution.summary } : {}),
  };
};
