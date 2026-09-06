/**
 * Normalizes an external numeric value to a finite integer inside an explicit
 * range. Blank, non-numeric, NaN, and infinite values use the supplied
 * fallback; finite fractions are rounded down before clamping.
 */
export const boundedFiniteInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  const normalizedFallback = Math.max(minimum, Math.min(maximum, Math.floor(fallback)));
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
    : normalizedFallback;
};
