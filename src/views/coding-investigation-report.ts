export const CODING_INVESTIGATION_REPORT_LIMITS = Object.freeze({
  answerCharacters: 20_000,
  summaryCharacters: 1_600,
  collectionItems: 24,
  evidenceItems: 16,
  itemCharacters: 1_600,
  totalCharacters: 64_000,
});

export type CodingInvestigationFinding = {
  readonly claim: string;
  readonly evidence: ReadonlyArray<string>;
};

export type CodingInvestigationReport = {
  readonly status: string;
  readonly summary: string;
  readonly answer: string;
  readonly findings: ReadonlyArray<CodingInvestigationFinding>;
  readonly files: ReadonlyArray<string>;
  readonly limitations: ReadonlyArray<string>;
  readonly specialistReports: ReadonlyArray<string>;
};

const boundedText = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const boundedStrings = (value: unknown): ReadonlyArray<string> => Array.isArray(value)
  ? value
      .flatMap((item) => {
        const text = boundedText(item, CODING_INVESTIGATION_REPORT_LIMITS.itemCharacters);
        return text ? [text] : [];
      })
      .slice(0, CODING_INVESTIGATION_REPORT_LIMITS.collectionItems)
  : [];

export const parseCodingInvestigationReport = (
  value: string | undefined,
): CodingInvestigationReport | undefined => {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const root = parsed as Readonly<Record<string, unknown>>;
  const enveloped = root.final_report;
  const report = enveloped && typeof enveloped === "object" && !Array.isArray(enveloped)
    ? enveloped as Readonly<Record<string, unknown>>
    : root;
  const answer = boundedText(report.answer, CODING_INVESTIGATION_REPORT_LIMITS.answerCharacters);
  const summary = boundedText(report.summary, CODING_INVESTIGATION_REPORT_LIMITS.summaryCharacters);
  if (!answer && !summary) return undefined;
  const findings = Array.isArray(report.findings)
    ? report.findings.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
        const finding = candidate as Readonly<Record<string, unknown>>;
        const claim = boundedText(finding.claim, CODING_INVESTIGATION_REPORT_LIMITS.itemCharacters);
        if (!claim) return [];
        return [{
          claim,
          evidence: boundedStrings(finding.evidence).slice(0, CODING_INVESTIGATION_REPORT_LIMITS.evidenceItems),
        }];
      }).slice(0, CODING_INVESTIGATION_REPORT_LIMITS.collectionItems)
    : [];
  return {
    status: boundedText(report.status, 120) || "completed",
    summary: summary || answer.slice(0, CODING_INVESTIGATION_REPORT_LIMITS.summaryCharacters),
    answer: answer || summary,
    findings,
    files: boundedStrings(report.files),
    limitations: boundedStrings(report.limitations),
    specialistReports: boundedStrings(report.specialistReports),
  };
};

const markdownText = (value: string): string => value
  .replace(/\r\n?/gu, "\n")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
  .trim();

const markdownInline = (value: string): string => markdownText(value).replace(/\n+/gu, " ");

const markdownList = (items: ReadonlyArray<string>): string =>
  items.length > 0 ? items.map((item) => `- ${markdownText(item)}`).join("\n") : "None recorded.";

export const renderCodingInvestigationReport = (input: {
  readonly runId: string;
  readonly objective: string;
  readonly report: CodingInvestigationReport;
}): string => {
  const findings = input.report.findings.length > 0
    ? input.report.findings.map((finding) => [
        `### ${markdownInline(finding.claim)}`,
        "",
        finding.evidence.length > 0
          ? finding.evidence.map((item) => `- ${markdownText(item)}`).join("\n")
          : "No separate evidence references recorded.",
      ].join("\n")).join("\n\n")
    : "No separate structured findings recorded; see the answer above.";
  return [
    "# Repository investigation report",
    "",
    `- Run: ${markdownInline(input.runId)}`,
    `- Status: ${markdownInline(input.report.status)}`,
    "",
    "## Objective",
    "",
    markdownText(input.objective),
    "",
    "## Executive summary",
    "",
    markdownText(input.report.summary),
    "",
    "## Final answer",
    "",
    markdownText(input.report.answer),
    "",
    "## Findings and evidence",
    "",
    findings,
    "",
    "## Relevant files",
    "",
    markdownList(input.report.files),
    "",
    "## Limitations",
    "",
    markdownList(input.report.limitations),
    "",
    "## Specialist reports consulted",
    "",
    markdownList(input.report.specialistReports),
    "",
  ].join("\n").slice(0, CODING_INVESTIGATION_REPORT_LIMITS.totalCharacters).trimEnd() + "\n";
};

const filenamePart = (value: string): string => value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 160);

export const codingInvestigationReportFilename = (runId: string): string =>
  `roster-investigation-${filenamePart(runId)}.md`;
