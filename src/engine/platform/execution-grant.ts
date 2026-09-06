import { hashCanonical } from "../../core/canonical.js";
import type {
  RosterFunctionAccess,
  RosterFunctionEffect,
  RosterFunctionTool,
} from "../functions/function-directory.js";
import type { RunExecutionPolicy, DynamicTaskDefinition } from "./protocol.js";

export const ROSTER_TASK_RISK_ASSESSMENT_VERSION = "roster.task-risk-assessment.v1" as const;
export const ROSTER_TASK_ADMISSION_DECISION_VERSION = "roster.task-admission-decision.v1" as const;
export const ROSTER_TASK_EXECUTION_GRANT_VERSION = "roster.task-execution-grant.v1" as const;

const ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._:/-]*$/u;
const MAX_GRANT_ITEMS = 256;

export type TaskExecutionRiskClass =
  | "read-only"
  | "workspace-write"
  | "external"
  | "non-repeatable";

export type TaskRiskAssessment = {
  readonly schemaVersion: typeof ROSTER_TASK_RISK_ASSESSMENT_VERSION;
  readonly assessmentId: string;
  readonly taskDefinitionHash: string;
  readonly policyVersion: string;
  readonly riskClass: TaskExecutionRiskClass;
  readonly rationale: string;
};

export type TaskAdmissionDecision = {
  readonly schemaVersion: typeof ROSTER_TASK_ADMISSION_DECISION_VERSION;
  readonly decisionId: string;
  readonly taskDefinitionHash: string;
  readonly assessmentId: string;
  readonly policyVersion: string;
  readonly disposition: "granted" | "denied" | "deferred";
  readonly authority: "deterministic-policy" | "human";
  readonly authorizationId?: string;
  readonly reason: string;
};

export type TaskExecutionGrantTool = {
  readonly id: string;
  readonly version: string;
  readonly effects: ReadonlyArray<RosterFunctionEffect>;
};

export type TaskExecutionGrantSkill = {
  readonly id: string;
  readonly contentHash: string;
};

export type TaskExecutionGrantCodeMode = {
  readonly maxFunctionCalls: number;
  readonly maxContextValues: number;
  readonly maxContextBytes: number;
  readonly maxValueBytes: number;
  readonly maxObservationBytes: number;
  readonly maxRequestBytes: number;
};

export type TaskExecutionGrant = {
  readonly schemaVersion: typeof ROSTER_TASK_EXECUTION_GRANT_VERSION;
  readonly grantId: string;
  readonly policyVersion: string;
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly fence: number;
  readonly taskDefinitionHash: string;
  readonly frontierVersion: string;
  readonly topologyVersion: string;
  readonly catalogVersion: string;
  readonly runtimeBindingEpoch: number;
  readonly riskAssessment: TaskRiskAssessment;
  readonly admissionDecision: TaskAdmissionDecision;
  readonly functionAccess: Required<RosterFunctionAccess>;
  readonly workspaceOperations: ReadonlyArray<"read" | "publish">;
  readonly allowGraphExpansion: boolean;
  readonly surface: {
    readonly skills: ReadonlyArray<TaskExecutionGrantSkill>;
    readonly tools: ReadonlyArray<TaskExecutionGrantTool>;
    readonly codeMode?: TaskExecutionGrantCodeMode;
  };
  readonly budgets: {
    readonly maxTokens: number;
    readonly maxCostMicros: number;
    readonly maxFunctionCalls: number;
    readonly timeoutMs: number;
  };
};

export type CreateTaskExecutionGrantInput = {
  readonly runId: string;
  readonly definition: DynamicTaskDefinition;
  readonly attempt: number;
  readonly fence: number;
  readonly policyVersion: string;
  readonly policy: Pick<RunExecutionPolicy, "maxTokens" | "maxCostMicros">;
  readonly functionAccess?: RosterFunctionAccess;
  readonly workspaceOperations?: ReadonlyArray<"read" | "publish">;
  readonly allowGraphExpansion?: boolean;
  readonly skills?: ReadonlyArray<TaskExecutionGrantSkill>;
  readonly tools?: ReadonlyArray<Pick<RosterFunctionTool, "id" | "version" | "effects">>;
  readonly codeMode?: TaskExecutionGrantCodeMode;
  readonly maxFunctionCalls?: number;
  readonly riskClass?: TaskExecutionRiskClass;
  readonly rationale?: string;
  readonly admissionDecision?: Omit<
    TaskAdmissionDecision,
    "schemaVersion" | "decisionId" | "taskDefinitionHash" | "assessmentId" | "policyVersion"
  >;
};

const boundedText = (
  value: string,
  label: string,
  maximum = 240,
): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return normalized;
};

const boundedId = (value: string, label: string): string => {
  const normalized = boundedText(value, label);
  if (!ID_PATTERN.test(normalized)) throw new Error(`${label} is not a valid identifier`);
  return normalized;
};

const nonNegativeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
};

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
};

const effects = (
  values: ReadonlyArray<RosterFunctionEffect> | undefined,
  label: string,
): ReadonlyArray<RosterFunctionEffect> => {
  const normalized: RosterFunctionEffect[] = [
    ...new Set<RosterFunctionEffect>(values ?? ["read"]),
  ].sort();
  if (normalized.some((value) => value !== "read" && value !== "write" && value !== "external")) {
    throw new Error(`${label} contains an unsupported effect`);
  }
  return Object.freeze(normalized);
};

const boundedIds = (
  values: ReadonlyArray<string> | undefined,
  label: string,
): ReadonlyArray<string> => {
  const normalized = [...new Set((values ?? []).map((value) => boundedId(value, label)))].sort();
  if (normalized.length > MAX_GRANT_ITEMS) {
    throw new Error(`${label} exceeds ${MAX_GRANT_ITEMS} entries`);
  }
  return Object.freeze(normalized);
};

const functionAccess = (
  access: RosterFunctionAccess | undefined,
): Required<RosterFunctionAccess> => Object.freeze({
  functionGrants: boundedIds(access?.functionGrants, "Execution grant function"),
  scopes: boundedIds(access?.scopes, "Execution grant scope"),
  allowedEffects: effects(access?.allowedEffects, "Execution grant function access"),
});

const workspaceOperations = (
  values: ReadonlyArray<"read" | "publish"> | undefined,
): ReadonlyArray<"read" | "publish"> => {
  const normalized: Array<"read" | "publish"> = [
    ...new Set<"read" | "publish">(values ?? ["read"]),
  ].sort();
  if (normalized.some((value) => value !== "read" && value !== "publish")) {
    throw new Error("Execution grant contains an unsupported workspace operation");
  }
  return Object.freeze(normalized);
};

const skills = (
  values: ReadonlyArray<TaskExecutionGrantSkill> | undefined,
): ReadonlyArray<TaskExecutionGrantSkill> => {
  const normalized = (values ?? []).map((skill) => Object.freeze({
    id: boundedId(skill.id, "Execution grant skill id"),
    contentHash: boundedText(skill.contentHash, "Execution grant skill hash"),
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (normalized.length > MAX_GRANT_ITEMS || new Set(normalized.map(({ id }) => id)).size !== normalized.length) {
    throw new Error("Execution grant skills must be unique and bounded");
  }
  return Object.freeze(normalized);
};

const tools = (
  values: CreateTaskExecutionGrantInput["tools"],
): ReadonlyArray<TaskExecutionGrantTool> => {
  const normalized = (values ?? []).map((tool) => Object.freeze({
    id: boundedId(tool.id, "Execution grant tool id"),
    version: boundedText(tool.version, "Execution grant tool version", 120),
    effects: effects(tool.effects, `Execution grant tool ${tool.id}`),
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (normalized.length > MAX_GRANT_ITEMS || new Set(normalized.map(({ id }) => id)).size !== normalized.length) {
    throw new Error("Execution grant tools must be unique and bounded");
  }
  return Object.freeze(normalized);
};

const codeMode = (
  value: TaskExecutionGrantCodeMode | undefined,
): TaskExecutionGrantCodeMode | undefined => value === undefined
  ? undefined
  : Object.freeze({
      maxFunctionCalls: positiveInteger(value.maxFunctionCalls, "Execution grant code-mode maxFunctionCalls"),
      maxContextValues: positiveInteger(value.maxContextValues, "Execution grant code-mode maxContextValues"),
      maxContextBytes: positiveInteger(value.maxContextBytes, "Execution grant code-mode maxContextBytes"),
      maxValueBytes: positiveInteger(value.maxValueBytes, "Execution grant code-mode maxValueBytes"),
      maxObservationBytes: positiveInteger(
        value.maxObservationBytes,
        "Execution grant code-mode maxObservationBytes",
      ),
      maxRequestBytes: positiveInteger(value.maxRequestBytes, "Execution grant code-mode maxRequestBytes"),
    });

const defaultRiskClass = (
  definition: DynamicTaskDefinition,
  access: Required<RosterFunctionAccess>,
): TaskExecutionRiskClass => {
  if (definition.sideEffect === "non-repeatable") return "non-repeatable";
  if (access.allowedEffects.includes("external")) return "external";
  if (definition.sideEffect === "idempotent" || access.allowedEffects.includes("write")) {
    return "workspace-write";
  }
  return "read-only";
};

const createRiskAssessment = (input: {
  readonly definition: DynamicTaskDefinition;
  readonly policyVersion: string;
  readonly riskClass: TaskExecutionRiskClass;
  readonly rationale: string;
}): TaskRiskAssessment => {
  const content = {
    schemaVersion: ROSTER_TASK_RISK_ASSESSMENT_VERSION,
    taskDefinitionHash: boundedText(input.definition.definitionHash, "Risk assessment task definition hash"),
    policyVersion: boundedText(input.policyVersion, "Risk assessment policy version"),
    riskClass: input.riskClass,
    rationale: boundedText(input.rationale, "Risk assessment rationale", 2_000),
  };
  return Object.freeze({
    ...content,
    assessmentId: `risk_${hashCanonical(content).slice(0, 28)}`,
  });
};

const createAdmissionDecision = (input: {
  readonly definition: DynamicTaskDefinition;
  readonly policyVersion: string;
  readonly assessment: TaskRiskAssessment;
  readonly decision?: CreateTaskExecutionGrantInput["admissionDecision"];
}): TaskAdmissionDecision => {
  const disposition = input.decision?.disposition ?? "granted";
  const authority = input.decision?.authority ?? "deterministic-policy";
  const authorizationId = input.decision?.authorizationId;
  if (!["granted", "denied", "deferred"].includes(disposition)) {
    throw new Error("Task admission has an unsupported disposition");
  }
  if (authority !== "deterministic-policy" && authority !== "human") {
    throw new Error("Task admission has an unsupported authority");
  }
  if (authority === "human" && !authorizationId) {
    throw new Error("Human task admission requires an exact authorizationId");
  }
  if (authority === "deterministic-policy" && authorizationId !== undefined) {
    throw new Error("Deterministic task admission cannot claim a human authorizationId");
  }
  const content = {
    schemaVersion: ROSTER_TASK_ADMISSION_DECISION_VERSION,
    taskDefinitionHash: input.definition.definitionHash,
    assessmentId: input.assessment.assessmentId,
    policyVersion: boundedText(input.policyVersion, "Admission decision policy version"),
    disposition,
    authority,
    ...(authorizationId
      ? { authorizationId: boundedId(authorizationId, "Admission authorization id") }
      : {}),
    reason: boundedText(
      input.decision?.reason ?? "The task is covered by deterministic Roster policy.",
      "Admission decision reason",
      2_000,
    ),
  };
  return Object.freeze({
    ...content,
    decisionId: `admission_${hashCanonical(content).slice(0, 28)}`,
  });
};

const grantIdentity = (
  grant: Omit<TaskExecutionGrant, "schemaVersion" | "grantId">,
) => ({
  schemaVersion: ROSTER_TASK_EXECUTION_GRANT_VERSION,
  ...grant,
});

export const createTaskExecutionGrant = (
  input: CreateTaskExecutionGrantInput,
): TaskExecutionGrant => {
  const access = functionAccess(input.functionAccess);
  const riskClass = input.riskClass ?? defaultRiskClass(input.definition, access);
  if (!["read-only", "workspace-write", "external", "non-repeatable"].includes(riskClass)) {
    throw new Error("Task execution grant has an unsupported risk class");
  }
  const assessment = createRiskAssessment({
    definition: input.definition,
    policyVersion: input.policyVersion,
    riskClass,
    rationale: input.rationale ?? `Deterministic classification for ${input.definition.sideEffect} task execution.`,
  });
  const decision = createAdmissionDecision({
    definition: input.definition,
    policyVersion: input.policyVersion,
    assessment,
    decision: input.admissionDecision,
  });
  if (decision.disposition !== "granted") {
    throw new Error(`Task execution cannot create a grant from ${decision.disposition} admission`);
  }
  const normalizedCodeMode = codeMode(input.codeMode);
  const maxFunctionCalls = positiveInteger(
    input.maxFunctionCalls ?? normalizedCodeMode?.maxFunctionCalls ?? 1,
    "Execution grant maxFunctionCalls",
  );
  const content: Omit<TaskExecutionGrant, "schemaVersion" | "grantId"> = {
    policyVersion: boundedText(input.policyVersion, "Execution grant policy version"),
    runId: boundedId(input.runId, "Execution grant run id"),
    taskId: boundedId(input.definition.taskId, "Execution grant task id"),
    nodeId: boundedId(input.definition.nodeId, "Execution grant node id"),
    attempt: positiveInteger(input.attempt, "Execution grant attempt"),
    fence: positiveInteger(input.fence, "Execution grant fence"),
    taskDefinitionHash: boundedText(input.definition.definitionHash, "Execution grant task definition hash"),
    frontierVersion: boundedText(input.definition.inputs.frontierVersion, "Execution grant frontier version"),
    topologyVersion: boundedText(input.definition.inputs.topologyVersion, "Execution grant topology version"),
    catalogVersion: boundedText(input.definition.inputs.catalogVersion, "Execution grant catalog version"),
    runtimeBindingEpoch: nonNegativeInteger(
      input.definition.runtimeBindingEpoch,
      "Execution grant runtime binding epoch",
    ),
    riskAssessment: assessment,
    admissionDecision: decision,
    functionAccess: access,
    workspaceOperations: workspaceOperations(input.workspaceOperations),
    allowGraphExpansion: input.allowGraphExpansion ?? false,
    surface: Object.freeze({
      skills: skills(input.skills),
      tools: tools(input.tools),
      ...(normalizedCodeMode ? { codeMode: normalizedCodeMode } : {}),
    }),
    budgets: Object.freeze({
      maxTokens: nonNegativeInteger(input.policy.maxTokens, "Execution grant maxTokens"),
      maxCostMicros: nonNegativeInteger(input.policy.maxCostMicros, "Execution grant maxCostMicros"),
      maxFunctionCalls,
      timeoutMs: nonNegativeInteger(input.definition.timeoutMs, "Execution grant timeoutMs"),
    }),
  };
  const identity = grantIdentity(content);
  return Object.freeze({
    ...identity,
    grantId: `grant_${hashCanonical(identity).slice(0, 28)}`,
  });
};

export const validateTaskExecutionGrant = (
  grant: TaskExecutionGrant,
): TaskExecutionGrant => {
  if (grant.schemaVersion !== ROSTER_TASK_EXECUTION_GRANT_VERSION) {
    throw new Error("Task execution grant has an unsupported schema version");
  }
  const reconstructed = createTaskExecutionGrant({
    runId: grant.runId,
    definition: {
      schemaVersion: "roster.task-definition.v1",
      taskId: grant.taskId,
      semanticKey: "execution-grant-validation",
      definitionHash: grant.taskDefinitionHash,
      nodeId: grant.nodeId,
      capability: "execution-grant-validation",
      objective: "Validate an exact task execution grant.",
      handler: { kind: "execution-grant-validation", version: "1" },
      acceptance: { policyId: "execution-grant-validation", policyVersion: "1" },
      result: { mode: "none" },
      dependencies: [],
      join: { kind: "all-success" },
      inputs: {
        inputVersions: {},
        dataReferences: [],
        frontierVersion: grant.frontierVersion,
        topologyVersion: grant.topologyVersion,
        catalogVersion: grant.catalogVersion,
      },
      runtimeBindingEpoch: grant.runtimeBindingEpoch,
      retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
      timeoutMs: grant.budgets.timeoutMs,
      sideEffect: grant.riskAssessment.riskClass === "non-repeatable"
        ? "non-repeatable"
        : grant.riskAssessment.riskClass === "workspace-write"
          ? "idempotent"
          : "pure",
      estimatedCostMicros: 0,
    },
    attempt: grant.attempt,
    fence: grant.fence,
    policyVersion: grant.policyVersion,
    policy: {
      maxTokens: grant.budgets.maxTokens,
      maxCostMicros: grant.budgets.maxCostMicros,
    },
    functionAccess: grant.functionAccess,
    workspaceOperations: grant.workspaceOperations,
    allowGraphExpansion: grant.allowGraphExpansion,
    skills: grant.surface.skills,
    tools: grant.surface.tools,
    codeMode: grant.surface.codeMode,
    maxFunctionCalls: grant.budgets.maxFunctionCalls,
    riskClass: grant.riskAssessment.riskClass,
    rationale: grant.riskAssessment.rationale,
    admissionDecision: {
      disposition: grant.admissionDecision.disposition,
      authority: grant.admissionDecision.authority,
      ...(grant.admissionDecision.authorizationId
        ? { authorizationId: grant.admissionDecision.authorizationId }
        : {}),
      reason: grant.admissionDecision.reason,
    },
  });
  if (
    reconstructed.grantId !== grant.grantId
    || hashCanonical(reconstructed) !== hashCanonical(grant)
  ) {
    throw new Error("Task execution grant identity does not match its exact contents");
  }
  return reconstructed;
};

export const assertTaskExecutionGrant = (input: {
  readonly grant: TaskExecutionGrant;
  readonly runId: string;
  readonly definition: DynamicTaskDefinition;
  readonly attempt: number;
  readonly fence: number;
}): TaskExecutionGrant => {
  const grant = validateTaskExecutionGrant(input.grant);
  if (
    grant.runId !== input.runId
    || grant.taskId !== input.definition.taskId
    || grant.nodeId !== input.definition.nodeId
    || grant.attempt !== input.attempt
    || grant.fence !== input.fence
    || grant.taskDefinitionHash !== input.definition.definitionHash
    || grant.frontierVersion !== input.definition.inputs.frontierVersion
    || grant.topologyVersion !== input.definition.inputs.topologyVersion
    || grant.catalogVersion !== input.definition.inputs.catalogVersion
    || grant.runtimeBindingEpoch !== input.definition.runtimeBindingEpoch
  ) {
    throw new Error(`Task ${input.definition.taskId} execution grant does not match its exact execution fence`);
  }
  return grant;
};

export const assertTaskExecutionGrantTool = (
  grant: TaskExecutionGrant,
  functionId: string,
): TaskExecutionGrantTool => {
  const tool = grant.surface.tools.find((candidate) => candidate.id === functionId);
  if (!tool) throw new Error(`Task execution grant ${grant.grantId} does not authorize tool ${functionId}`);
  return tool;
};

export const assertTaskExecutionGrantWorkspaceOperation = (
  grant: TaskExecutionGrant,
  operation: "read" | "publish",
): void => {
  if (!grant.workspaceOperations.includes(operation)) {
    throw new Error(`Task execution grant ${grant.grantId} does not authorize workspace ${operation}`);
  }
};
