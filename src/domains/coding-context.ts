export const CODING_TASK_CONTEXT_SCHEMA = "roster.coding.task-context.v1" as const;
export const CODING_TASK_CONTEXT_INPUT_KEY = "codingTaskContext" as const;
export const CODING_TASK_CONTEXT_OUTPUT_KEY = "coding_task_context" as const;

export type CodingContextSource =
  | "objective"
  | "repository"
  | "specialization"
  | "peer-decisions"
  | "dependency-reports"
  | "implementation-report"
  | "change-frontier"
  | "review-findings"
  | "validation-evidence"
  | "shared-memory";

export type CodingChangeFrontierAvailability = "none" | "optional" | "required";

/**
 * A durable, phase-specific projection of the context a Coding task may use.
 * `primary` controls emphasis; `available` records the complete admitted
 * context surface. Large or changing bodies stay behind bounded tools.
 */
export type CodingTaskContextPolicy = {
  readonly schema: typeof CODING_TASK_CONTEXT_SCHEMA;
  readonly capability: string;
  readonly primary: ReadonlyArray<CodingContextSource>;
  readonly available: ReadonlyArray<CodingContextSource>;
  readonly changeFrontier: CodingChangeFrontierAvailability;
};

const policy = (
  capability: string,
  primary: ReadonlyArray<CodingContextSource>,
  available: ReadonlyArray<CodingContextSource>,
  changeFrontier: CodingChangeFrontierAvailability = "none",
): CodingTaskContextPolicy => ({
  schema: CODING_TASK_CONTEXT_SCHEMA,
  capability,
  primary,
  available: [...new Set([...primary, ...available])],
  changeFrontier,
});

/**
 * Context is selected by task semantics, not by runtime provider. A Codex,
 * Claude, Pi, or Hermes binding executing the same capability receives the
 * same logical projection.
 */
export const codingTaskContextPolicy = (
  capability: string,
): CodingTaskContextPolicy => {
  switch (capability) {
    case "room":
      return policy(capability, ["objective", "specialization"], [
        "dependency-reports",
        "peer-decisions",
      ]);
    case "propose":
      return policy(capability, ["objective", "specialization"], [
        "repository",
        "shared-memory",
      ]);
    case "respond":
      return policy(capability, ["dependency-reports", "specialization"], [
        "objective",
        "repository",
        "shared-memory",
      ]);
    case "investigate":
      return policy(capability, ["objective", "repository", "specialization"], [
        "dependency-reports",
        "peer-decisions",
        "shared-memory",
      ]);
    case "resolve":
      return policy(capability, ["peer-decisions", "dependency-reports"], [
        "objective",
        "repository",
        "specialization",
      ]);
    case "implement":
      return policy(capability, ["objective", "peer-decisions", "repository"], [
        "specialization",
        "dependency-reports",
        "change-frontier",
        "shared-memory",
      ], "optional");
    case "review":
      return policy(capability, ["change-frontier", "implementation-report"], [
        "objective",
        "repository",
        "specialization",
        "dependency-reports",
        "shared-memory",
      ], "required");
    case "remediate":
      return policy(capability, ["review-findings", "change-frontier"], [
        "objective",
        "repository",
        "specialization",
        "peer-decisions",
        "implementation-report",
        "shared-memory",
      ], "required");
    case "validate":
      return policy(capability, ["change-frontier", "validation-evidence"], [
        "objective",
        "implementation-report",
        "repository",
      ], "required");
    case "certify":
      return policy(capability, ["change-frontier", "validation-evidence"], [
        "objective",
        "implementation-report",
        "specialization",
        "dependency-reports",
        "repository",
      ], "required");
    case "synthesize":
      return policy(capability, ["implementation-report", "validation-evidence", "dependency-reports"], [
        "objective",
        "change-frontier",
        "peer-decisions",
        "repository",
      ], "required");
    default:
      return policy(capability, ["objective"], ["repository"]);
  }
};

/** Capabilities that may discover the live, Git-backed ChangeFrontier tool. */
export const codingCapabilityUsesChangeFrontier = (
  capability: string,
): boolean => codingTaskContextPolicy(capability).changeFrontier !== "none";
