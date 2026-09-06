import { hashCanonical } from "../../core/canonical.js";

const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_TARGET_OBJECTIVE_LENGTH = 32_000;
const MAX_TARGET_ITEMS = 16;
const MAX_TARGET_ITEM_LENGTH = 2_000;

export type TargetContractSpec = {
  readonly id: string;
  readonly version: string;
  readonly objective: string;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly constraints?: ReadonlyArray<string>;
};

/** Immutable, content-addressed alignment context shared by every task in a plan. */
export type TargetContract = TargetContractSpec & {
  readonly contentHash: string;
};

const normalizedItems = (kind: string, values: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (values.length > MAX_TARGET_ITEMS) {
    throw new Error(`Target contract has more than ${MAX_TARGET_ITEMS} ${kind}`);
  }
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => !value)) {
    throw new Error(`Target contract ${kind} must not be blank`);
  }
  if (normalized.some((value) => value.length > MAX_TARGET_ITEM_LENGTH)) {
    throw new Error(`Target contract ${kind} must not exceed ${MAX_TARGET_ITEM_LENGTH} characters`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Target contract ${kind} must be unique`);
  }
  return normalized;
};

export const compileTargetContract = (spec: TargetContractSpec): TargetContract => {
  const id = spec.id.trim();
  const version = spec.version.trim();
  const objective = spec.objective.trim();
  if (!TARGET_ID_PATTERN.test(id)) throw new Error(`Invalid target contract id "${spec.id}"`);
  if (!version) throw new Error(`Target contract ${id} requires a version`);
  if (!objective) throw new Error(`Target contract ${id} requires an objective`);
  if (objective.length > MAX_TARGET_OBJECTIVE_LENGTH) {
    throw new Error(`Target contract objective must not exceed ${MAX_TARGET_OBJECTIVE_LENGTH} characters`);
  }
  const acceptanceCriteria = normalizedItems("acceptance criteria", spec.acceptanceCriteria);
  if (acceptanceCriteria.length === 0) {
    throw new Error(`Target contract ${id} requires at least one acceptance criterion`);
  }
  const constraints = normalizedItems("constraints", spec.constraints ?? []);
  const content = {
    id,
    version,
    objective,
    acceptanceCriteria,
    ...(constraints.length ? { constraints } : {}),
  };
  return { ...content, contentHash: hashCanonical(content) };
};

export const targetInputVersionKey = (target: Pick<TargetContract, "id">): string =>
  `target:${target.id}`;
