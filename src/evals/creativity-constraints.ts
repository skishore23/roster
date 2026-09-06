const countWords = (text: string): number =>
  text.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu)?.length ?? 0;

const countNumberedItems = (text: string): number =>
  text.match(/^\s*\d+[.)]\s+/gm)?.length ?? 0;

/** Deterministic checks for the benchmark constraints that are machine-testable. */
export const deterministicCreativityConstraintPass = (
  caseId: string,
  text: string,
): boolean | undefined => {
  if (caseId === "prism-unusual-key" || caseId === "prism-no-sleep-consequences") {
    return countNumberedItems(text) === 12;
  }
  if (caseId === "liveidea-periodic-table") return countWords(text) <= 100;
  if (caseId === "prism-short-story-organ-empire-comply") {
    const sentences = text.split(/[.!?]+["”']?(?:\s+|$)/u).filter((value) => value.trim()).length;
    return sentences <= 5
      && ["organ", "empire", "comply"].every((word) =>
        new RegExp(`\\b${word}\\b`, "iu").test(text)
      );
  }
  if (caseId === "prism-creative-math-2adic") {
    return /\b32\b|2\s*\^\s*5|2⁵/u.test(text);
  }
  return undefined;
};
