export type RuntimeLimits = {
  readonly maxNodes: number;
  readonly maxParallel: number;
};

type RuntimeLimitOverrides = {
  readonly maxNodes?: number;
  readonly maxParallel?: number;
};

const boundedInteger = (value: string | undefined, fallback: number, minimum: number, maximum: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
};

/** Resolves platform capacity separately from domain population demand. */
export const resolveRuntimeLimits = (
  overrides: RuntimeLimitOverrides = {},
  env: Readonly<Record<string, string | undefined>> = process.env
): RuntimeLimits => {
  const maxNodes = boundedInteger(env.ROSTER_MAX_NODES, 128, 2, 10_000);
  const parallelCeiling = boundedInteger(env.ROSTER_MAX_PARALLEL, 32, 1, 256);
  const defaultParallel = Math.min(
    parallelCeiling,
    boundedInteger(env.ROSTER_DEFAULT_MAX_PARALLEL, 3, 1, 256)
  );
  const requestedParallel = Number.isFinite(overrides.maxParallel ?? Number.NaN)
    ? Math.floor(overrides.maxParallel!)
    : defaultParallel;
  const requestedNodes = Number.isFinite(overrides.maxNodes ?? Number.NaN)
    ? Math.floor(overrides.maxNodes!)
    : maxNodes;

  return {
    maxNodes: Math.max(2, Math.min(maxNodes, requestedNodes)),
    maxParallel: Math.max(1, Math.min(parallelCeiling, requestedParallel)),
  };
};
