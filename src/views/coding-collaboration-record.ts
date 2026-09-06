import type { QueueJob } from "../engine/runtime/job-queue.js";
import type { StoredNodeRuntimeLog } from "../engine/runtime/node-runtime-log.js";
import {
  CODING_COLLABORATION_ENDORSEMENT_PREFIX,
  CODING_COLLABORATION_PROPOSAL_PREFIX,
  CODING_COLLABORATION_RESOLUTION_OUTPUT,
  CODING_COLLABORATION_RESPONSE_PREFIX,
  parseCodingPeerEndorsement,
  parseCodingPeerProposal,
  parseCodingPeerResolution,
  parseCodingPeerResponse,
} from "../domains/coding-collaboration.js";
import {
  codingAcceptedOutputValues,
  type CodingAcceptedOutput,
} from "../domains/coding-accepted-outputs.js";
import {
  orchestrationOutputValues,
  type OrchestrationEvent,
  type OrchestrationState,
} from "../modules/orchestration.js";

export const CODING_COLLABORATION_RECORD_LIMITS = Object.freeze({
  totalBytes: 96 * 1024,
  fieldCharacters: 1_600,
  objectiveCharacters: 6_000,
  collectionItems: 64,
  evidenceItems: 12,
  sections: Object.freeze({
    objective: 7 * 1024,
    contributions: 20 * 1024,
    members: 8 * 1024,
    tasks: 12 * 1024,
    conflicts: 8 * 1024,
    certification: 9 * 1024,
    integration: 4 * 1024,
    git: 3 * 1024,
    result: 8 * 1024,
    diagnostics: 12 * 1024,
  }),
});

const TRUNCATED = "[Truncated deterministically]";
const REDACTED = "[REDACTED]";
const REDACTED_ESCAPED = "\\[REDACTED\\]";

type CollaborationPhase = "proposal" | "response" | "resolution" | "endorsement";

type Contribution = {
  readonly phase: CollaborationPhase;
  readonly outputKey: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly subjectId: string;
  readonly value: string;
};

type BoundedCollection<T> = {
  readonly items: ReadonlyArray<T>;
  readonly omitted: number;
};

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const canonicalCompare = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const truncateCharacters = (value: string, max: number): string => {
  const characters = [...value];
  return characters.length <= max
    ? value
    : `${characters.slice(0, Math.max(0, max - TRUNCATED.length - 1)).join("").trimEnd()} ${TRUNCATED}`;
};

const normalizeText = (value: string): string => value
  .replace(/\r\n?/g, "\n")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
  .replace(/\t/g, "  ")
  .replace(/[ \u00A0]+\n/g, "\n")
  .trim();

const redactSecrets = (value: string): string => value
  .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi, REDACTED)
  .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (match) => `${match.split(/\s+/, 1)[0]} ${REDACTED}`)
  .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, REDACTED)
  .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, REDACTED)
  .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED)
  .replace(/\bAKIA[A-Z0-9]{16}\b/g, REDACTED)
  .replace(
    /\b((?:aws[_-]?)?secret[_-]?access[_-]?key|api[_-]?key|access[_-]?(?:token|key)|auth[_-]?token|client[_-]?secret|password|passwd)\b(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
    (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
  );

const escapeMarkdown = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/([\\`*_[\]{}()#+.!|])/g, "\\$1")
  .replace(/(^|\n)(\s*)-/g, "$1$2\\-")
  .replaceAll(REDACTED_ESCAPED, REDACTED);

const safeText = (value: unknown, max: number = CODING_COLLABORATION_RECORD_LIMITS.fieldCharacters): string => {
  if (typeof value !== "string" || !value.trim()) return "Not recorded";
  return truncateCharacters(escapeMarkdown(redactSecrets(normalizeText(value))), max);
};

const safeInline = (value: unknown, max = 240): string => safeText(value, max).replace(/\n+/g, " ");

const boundedBlock = (value: string, maxBytes: number): string => {
  if (utf8Bytes(value) <= maxBytes) return value;
  const marker = `\n\n${TRUNCATED}\n`;
  const available = Math.max(0, maxBytes - utf8Bytes(marker));
  const lines: string[] = [];
  let bytes = 0;
  for (const line of value.split("\n")) {
    const candidate = `${line}\n`;
    const candidateBytes = utf8Bytes(candidate);
    if (bytes + candidateBytes > available) break;
    lines.push(line);
    bytes += candidateBytes;
  }
  return `${lines.join("\n").trimEnd()}${marker}`;
};

const section = (heading: string, body: string, maxBytes: number): string =>
  boundedBlock(`## ${heading}\n\n${body.trim() || "Not recorded"}\n`, maxBytes);

const boundedCollection = <T>(items: ReadonlyArray<T>, max: number): BoundedCollection<T> => ({
  items: items.slice(0, max),
  omitted: Math.max(0, items.length - max),
});

const stringValues = (value: unknown): ReadonlyArray<string> => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  : [];

const omissionLine = (omitted: number, indent = "", label?: string): string =>
  omitted > 0
    ? `${indent}- ${label ? `${label} ` : ""}${TRUNCATED}: ${omitted} item${omitted === 1 ? "" : "s"} omitted`
    : "";

const contributionPhase = (outputKey: string): CollaborationPhase | undefined => {
  if (outputKey.startsWith(CODING_COLLABORATION_PROPOSAL_PREFIX)) return "proposal";
  if (outputKey.startsWith(CODING_COLLABORATION_RESPONSE_PREFIX)) return "response";
  if (outputKey === CODING_COLLABORATION_RESOLUTION_OUTPUT) return "resolution";
  if (outputKey.startsWith(CODING_COLLABORATION_ENDORSEMENT_PREFIX)) return "endorsement";
  return undefined;
};

const phaseRank: Readonly<Record<CollaborationPhase, number>> = {
  proposal: 0,
  response: 1,
  resolution: 2,
  endorsement: 3,
};

const contributionSubject = (phase: CollaborationPhase, value: string): string => {
  if (phase === "proposal") return parseCodingPeerProposal(value)?.recommendations.map((item) => item.subjectId).sort(canonicalCompare)[0] ?? "";
  if (phase === "response") return parseCodingPeerResponse(value)?.answers.map((item) => item.subjectId).sort(canonicalCompare)[0] ?? "";
  if (phase === "resolution") return parseCodingPeerResolution(value)?.decisions.map((item) => item.subjectId).sort(canonicalCompare)[0] ?? "";
  return parseCodingPeerEndorsement(value)?.frontierHash ?? "";
};

type CodingGraphTask = NonNullable<OrchestrationState["taskGraph"]>["tasks"][number];

const graphTasks = (state: OrchestrationState): ReadonlyArray<CodingGraphTask> =>
  (state.taskGraph?.tasks ?? []).filter((task) => task.capability !== "coordinate.graph");

const contributionsFromState = (state: OrchestrationState): ReadonlyArray<Contribution> => {
  const values = orchestrationOutputValues(state);
  const taskOrder = new Map(graphTasks(state).map((task, index) => [task.taskId, index]));
  return Object.entries(state.outputs).flatMap(([outputKey, binding]) => {
    const phase = contributionPhase(outputKey);
    const value = values[outputKey];
    if (!phase || !value) return [];
    const parsed = phase === "proposal" ? parseCodingPeerProposal(value)
      : phase === "response" ? parseCodingPeerResponse(value)
        : phase === "resolution" ? parseCodingPeerResolution(value)
          : parseCodingPeerEndorsement(value);
    if (!parsed) return [];
    const artifact = state.artifacts[binding.artifactId];
    return [{
      phase,
      outputKey,
      taskId: binding.taskId ?? artifact?.taskId ?? "",
      nodeId: artifact?.nodeId
        ?? graphTasks(state).find((task) => task.taskId === binding.taskId)?.nodeId
        ?? "unknown",
      subjectId: contributionSubject(phase, value),
      value,
    }];
  }).sort((left, right) =>
    phaseRank[left.phase] - phaseRank[right.phase]
    || (taskOrder.get(left.taskId) ?? Number.MAX_SAFE_INTEGER) - (taskOrder.get(right.taskId) ?? Number.MAX_SAFE_INTEGER)
    || canonicalCompare(left.outputKey, right.outputKey)
    || canonicalCompare(left.nodeId, right.nodeId)
    || canonicalCompare(left.subjectId, right.subjectId));
};

const validContribution = (
  outputKey: string,
  value: string,
): { readonly phase: CollaborationPhase; readonly subjectId: string } | undefined => {
  const phase = contributionPhase(outputKey);
  if (!phase) return undefined;
  const parsed = phase === "proposal" ? parseCodingPeerProposal(value)
    : phase === "response" ? parseCodingPeerResponse(value)
      : phase === "resolution" ? parseCodingPeerResolution(value)
        : parseCodingPeerEndorsement(value);
  return parsed ? { phase, subjectId: contributionSubject(phase, value) } : undefined;
};

const contributionsFromAcceptedOutputs = (
  outputs: ReadonlyArray<CodingAcceptedOutput>,
): ReadonlyArray<Contribution> => outputs.flatMap((output) => {
  const contribution = validContribution(output.outputKey, output.value);
  return contribution ? [{
    ...contribution,
    outputKey: output.outputKey,
    taskId: output.taskId,
    nodeId: output.nodeId,
    value: output.value,
  }] : [];
});

const mergeContributions = (
  state: OrchestrationState,
  acceptedOutputs: ReadonlyArray<CodingAcceptedOutput>,
): ReadonlyArray<Contribution> => {
  const taskOrder = new Map(graphTasks(state).map((task, index) => [task.taskId, index]));
  const acceptedOutputKeys = new Set(acceptedOutputs.map((output) => output.outputKey));
  const unique = new Map<string, Contribution>();
  for (const contribution of [
    ...contributionsFromState(state)
      .filter((contribution) => !acceptedOutputKeys.has(contribution.outputKey)),
    ...contributionsFromAcceptedOutputs(acceptedOutputs),
  ]) {
    unique.set([
      contribution.phase,
      contribution.outputKey,
      contribution.taskId,
      contribution.nodeId,
      contribution.value,
    ].join("\u0000"), contribution);
  }
  return [...unique.values()].sort((left, right) =>
    phaseRank[left.phase] - phaseRank[right.phase]
    || (taskOrder.get(left.taskId) ?? Number.MAX_SAFE_INTEGER) - (taskOrder.get(right.taskId) ?? Number.MAX_SAFE_INTEGER)
    || canonicalCompare(left.outputKey, right.outputKey)
    || canonicalCompare(left.nodeId, right.nodeId)
    || canonicalCompare(left.subjectId, right.subjectId));
};

const evidenceLines = (items: ReadonlyArray<string>): ReadonlyArray<string> => {
  const bounded = boundedCollection(items, CODING_COLLABORATION_RECORD_LIMITS.evidenceItems);
  return [
    ...bounded.items.map((item) => `  - Evidence: ${safeText(item, 500)}`),
    omissionLine(bounded.omitted, "  "),
  ].filter(Boolean);
};

const renderContribution = (contribution: Contribution): string => {
  const prefix = [
    `### ${safeInline(contribution.phase)} — ${safeInline(contribution.outputKey, 300)}`,
    "",
    `- Member: ${safeInline(contribution.nodeId)}`,
    `- Task: ${safeInline(contribution.taskId || "Not recorded")}`,
  ];
  if (contribution.phase === "proposal") {
    const parsed = parseCodingPeerProposal(contribution.value);
    if (!parsed) return "";
    const recommendations = [...parsed.recommendations].sort((left, right) => canonicalCompare(left.subjectId, right.subjectId));
    return [...prefix, `- Summary: ${safeText(parsed.summary)}`, ...recommendations.flatMap((item) => [
      `- ${safeInline(item.subjectId)}: ${safeText(item.recommendation)}`,
      `  - Rationale: ${safeText(item.rationale)}`,
      `  - Confidence: ${item.confidence.toFixed(2)}`,
      ...evidenceLines(item.evidence),
    ]), ...parsed.questions.map((item) => `- Question: ${safeText(item, 600)}`)].join("\n");
  }
  if (contribution.phase === "response") {
    const parsed = parseCodingPeerResponse(contribution.value);
    if (!parsed) return "";
    const answers = [...parsed.answers].sort((left, right) => canonicalCompare(left.subjectId, right.subjectId));
    const questions = [...parsed.openQuestions].sort((left, right) => canonicalCompare(left.subjectId, right.subjectId));
    return [...prefix, `- Summary: ${safeText(parsed.summary)}`, ...answers.flatMap((item) => [
      `- ${safeInline(item.subjectId)}: ${safeText(item.response)}`,
      `  - Rationale: ${safeText(item.rationale)}`,
      `  - Confidence: ${item.confidence.toFixed(2)}`,
      ...evidenceLines(item.evidence),
    ]), ...questions.flatMap((item) => [
      `- Open question — ${safeInline(item.subjectId)}: ${safeText(item.question, 600)}`,
      `  - Reason: ${safeText(item.reason, 1_000)}`,
    ])].join("\n");
  }
  if (contribution.phase === "resolution") {
    const parsed = parseCodingPeerResolution(contribution.value);
    if (!parsed) return "";
    return [...prefix, `- Status: ${safeInline(parsed.status)}`, `- Summary: ${safeText(parsed.summary)}`].join("\n");
  }
  const parsed = parseCodingPeerEndorsement(contribution.value);
  if (!parsed) return "";
  return [...prefix,
    `- Verdict: ${safeInline(parsed.verdict)}`,
    `- Frontier hash: ${safeInline(parsed.frontierHash, 240)}`,
    `- Summary: ${safeText(parsed.summary)}`,
    ...evidenceLines(parsed.evidence),
  ].join("\n");
};

const selectedNodeIds = (state: OrchestrationState, job: QueueJob): BoundedCollection<string> => {
  const selected = [...new Set(stringValues(job.payload.selectedNodeIds))];
  const all = selected.length > 0 ? selected : [...new Set(graphTasks(state).map((task) => task.nodeId))]
    .filter((nodeId) => nodeId !== "coordinator" && state.nodes[nodeId]?.status !== "retired")
    .sort(canonicalCompare);
  return boundedCollection(all, 24);
};

const renderMembers = (state: OrchestrationState, job: QueueJob): string => {
  const selected = selectedNodeIds(state, job);
  return [...selected.items.map((nodeId) => {
    const node = state.nodes[nodeId];
    const binding = state.nodeBindings[nodeId];
    const runtime = binding?.runtime ?? node?.runtime;
    const model = typeof runtime?.metadata?.model === "string" ? runtime.metadata.model : undefined;
    return [
      `- ${safeInline(node?.name ?? nodeId)} (${safeInline(nodeId)})`,
      `  - Runtime: ${safeInline(runtime?.kind ?? "Not recorded")}`,
      `  - Profile: ${safeInline(runtime?.profile ?? "Not recorded")}`,
      `  - Model: ${safeInline(model ?? "Not recorded")}`,
      `  - Binding epoch: ${binding?.epoch ?? "Not recorded"}`,
    ].join("\n");
  }), omissionLine(selected.omitted)].filter(Boolean).join("\n");
};

const orderedTasks = (state: OrchestrationState): ReadonlyArray<CodingGraphTask> =>
  [...graphTasks(state)].sort((left, right) => canonicalCompare(left.taskId, right.taskId));

const taskCollectionLines = (label: string, values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const bounded = boundedCollection(values, 20);
  if (bounded.items.length === 0) return [];
  return [
    `  - ${label}: ${bounded.items.map((item) => safeInline(item)).join(", ")}`,
    omissionLine(bounded.omitted, "    ", label),
  ].filter(Boolean);
};

const renderTasks = (state: OrchestrationState): string => {
  const tasks = boundedCollection(orderedTasks(state), CODING_COLLABORATION_RECORD_LIMITS.collectionItems);
  return [...tasks.items.map((task) => [
    `- ${safeInline(task.taskId)} — ${safeInline(task.status)}`,
    `  - Member: ${safeInline(task.nodeId)}`,
    `  - Capability: ${safeInline(task.capability)}`,
    ...(task.objective ? [`  - Objective: ${safeText(task.objective)}`] : []),
    ...taskCollectionLines("Dependencies", task.dependencies.map((dependency) =>
      `${dependency.taskId} (${dependency.condition})`)),
  ].join("\n")), omissionLine(tasks.omitted)].filter(Boolean).join("\n");
};

const renderConflicts = (outputValues: Readonly<Record<string, string>>): string => {
  const resolution = parseCodingPeerResolution(outputValues[CODING_COLLABORATION_RESOLUTION_OUTPUT] ?? "");
  if (!resolution) return "No structured collaboration resolution recorded; authoritative conflict state is not projected here.";
  const decisions = [...resolution.decisions].sort((left, right) => canonicalCompare(left.subjectId, right.subjectId));
  const unresolved = [...resolution.unresolved].sort((left, right) => canonicalCompare(left.subjectId, right.subjectId));
  return [
    "This section projects the recorded structured resolution, not the authoritative shared-workspace conflict set.",
    `- Resolution status: ${safeInline(resolution.status)}`,
    `- Summary: ${safeText(resolution.summary)}`,
    ...decisions.flatMap((item) => [
      `- Decision — ${safeInline(item.subjectId)}: ${safeText(item.resolution)}`,
      `  - Rationale: ${safeText(item.rationale)}`,
      ...evidenceLines(item.evidence),
    ]),
    ...unresolved.flatMap((item) => [
      `- Unresolved — ${safeInline(item.subjectId)}: ${safeText(item.reason, 1_000)}`,
      ...item.candidateSummaries.map((candidate) => `  - Candidate: ${safeText(candidate, 600)}`),
    ]),
    ...(unresolved.length === 0 ? ["- Unresolved subjects in the recorded resolution: None recorded"] : []),
  ].join("\n");
};

const renderCertification = (
  state: OrchestrationState,
  events: ReadonlyArray<OrchestrationEvent>,
  contributions: ReadonlyArray<Contribution>,
  authoritativeAcceptedOutputs: boolean,
): string => {
  const endorsements = contributions.filter((item) => item.phase === "endorsement");
  const receipts = authoritativeAcceptedOutputs
    ? []
    : events.filter((event): event is Extract<OrchestrationEvent, { readonly type: "control.frontier.certified" }> =>
        event.type === "control.frontier.certified")
      .sort((left, right) => canonicalCompare(left.certificationId, right.certificationId)
        || canonicalCompare(left.artifactId, right.artifactId));
  const endorsementTaskIds = new Set(endorsements.map((endorsement) => endorsement.taskId));
  const certificationTasks = orderedTasks(state).filter((task) =>
    (task.capability === "certify" || task.taskId.startsWith("certify-"))
    && (!authoritativeAcceptedOutputs || endorsementTaskIds.has(task.taskId)));
  const evidence = [
    ...endorsements.map((item) => {
      const endorsement = parseCodingPeerEndorsement(item.value);
      if (!endorsement) return "";
      return [
        `- Endorsement by ${safeInline(item.nodeId)}: ${safeInline(endorsement.verdict)}`,
        `  - Frontier hash: ${safeInline(endorsement.frontierHash, 240)}`,
        `  - Summary: ${safeText(endorsement.summary)}`,
        ...evidenceLines(endorsement.evidence),
      ].join("\n");
    }),
    ...receipts.map((receipt) => [
      `- Certified frontier receipt: ${safeInline(receipt.certificationId)}`,
      `  - Artifact: ${safeInline(receipt.artifactId)}`,
      `  - Frontier: ${safeInline(receipt.frontierVersion)}`,
      `  - Version hash: ${safeInline(receipt.versionHash, 240)}`,
    ].join("\n")),
  ].filter(Boolean);
  return [
    ...(evidence.length > 0 ? evidence : ["No certification evidence recorded at this replay head."]),
    ...certificationTasks.map((task) => `- Certification task context — ${safeInline(task.taskId)}: ${safeInline(task.status)}`),
  ].join("\n");
};

type IntegrationResult = {
  readonly status: "integrated" | "already_integrated";
  readonly targetBranch: string;
  readonly resultingCommit: string;
};

const integrationResult = (
  outputValues: Readonly<Record<string, string>>,
  runId: string,
): IntegrationResult | undefined => {
  const raw = outputValues.integration_result;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = parsed as Readonly<Record<string, unknown>>;
    if (value.schema !== "roster.coding-integration.result.v1"
      || value.runId !== runId
      || (value.status !== "integrated" && value.status !== "already_integrated")
      || typeof value.targetBranch !== "string"
      || !value.targetBranch.trim()
      || typeof value.resultingCommit !== "string"
      || !value.resultingCommit.trim()) return undefined;
    return {
      status: value.status,
      targetBranch: value.targetBranch,
      resultingCommit: value.resultingCommit,
    };
  } catch {
    return undefined;
  }
};

const renderIntegration = (outputValues: Readonly<Record<string, string>>, runId: string): string => {
  const result = integrationResult(outputValues, runId);
  if (!result) return "No structured integration result recorded at this replay head.";
  return [
    `- Status: ${safeInline(result.status)}`,
    `- Target branch: ${safeInline(result.targetBranch, 500)}`,
    `- Resulting commit: ${safeInline(result.resultingCommit, 500)}`,
  ].join("\n");
};

const renderResult = (job: QueueJob): string => {
  const result = job.result;
  const changedFiles = boundedCollection(stringValues(result?.changedFiles ?? result?.changed_files), 40);
  const validation = boundedCollection(stringValues(result?.validation ?? result?.validations), 40);
  return [
    "This section is sourced from the selected queue job, not later replay outputs.",
    `- Job status: ${safeInline(job.status)}`,
    `- Result status: ${safeInline(result?.status ?? job.status)}`,
    `- Summary: ${safeText(result?.summary)}`,
    ...changedFiles.items.map((item) => `- Changed file: ${safeText(item, 600)}`),
    omissionLine(changedFiles.omitted),
    ...validation.items.map((item) => `- Validation: ${safeText(item, 800)}`),
    omissionLine(validation.omitted),
    ...(typeof result?.frontierHash === "string" || typeof result?.frontier_hash === "string"
      ? [`- Result frontier hash: ${safeInline(result.frontierHash ?? result.frontier_hash, 240)}`]
      : []),
  ].filter(Boolean).join("\n");
};

const renderDiagnostics = (entries: ReadonlyArray<StoredNodeRuntimeLog>): string => {
  const retained = {
    items: entries.slice(-80),
    omitted: Math.max(0, entries.length - 80),
  };
  return [
    "Process output is bounded, redacted, and diagnostic only; durable receipts remain authoritative.",
    ...retained.items.map((entry) =>
      `- ${new Date(entry.at).toISOString()} · ${safeInline(entry.nodeId, 200)} · ${safeInline(entry.stream, 40)} · ${safeText(entry.text, 1_000)}${entry.truncated ? ` · ${TRUNCATED}` : ""}`),
    omissionLine(retained.omitted),
  ].filter(Boolean).join("\n");
};

const filenamePart = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160);

export const codingCollaborationRecordFilename = (runId: string, jobId: string): string =>
  `roster-collaboration-${filenamePart(runId)}-${filenamePart(jobId)}.md`;

export const renderCodingCollaborationRecord = (input: {
  readonly runId: string;
  readonly receiptCount: number;
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly job: QueueJob;
  readonly acceptedOutputs?: ReadonlyArray<CodingAcceptedOutput>;
  readonly acceptedOutputsOmitted?: number;
  readonly runtimeDiagnostics?: ReadonlyArray<StoredNodeRuntimeLog>;
}): string => {
  const acceptedOutputs = input.acceptedOutputs ?? [];
  const outputValues = {
    ...orchestrationOutputValues(input.state),
    ...codingAcceptedOutputValues({ outputs: acceptedOutputs }),
  };
  const allContributions = mergeContributions(input.state, acceptedOutputs);
  const contributions = boundedCollection(allContributions, CODING_COLLABORATION_RECORD_LIMITS.collectionItems);
  const objective = safeText(input.job.payload.objective, CODING_COLLABORATION_RECORD_LIMITS.objectiveCharacters);
  const branch = typeof input.job.payload.branch === "string"
    ? input.job.payload.branch
    : typeof input.job.result?.branch === "string" ? input.job.result.branch : undefined;
  const commit = typeof input.job.result?.commit === "string" ? input.job.result.commit : undefined;
  const renderedContributions = [
    ...(contributions.items.length ? contributions.items.map(renderContribution).filter(Boolean) : ["No structured peer contributions recorded."]),
    omissionLine(contributions.omitted),
  ].filter(Boolean).join("\n\n");
  const sections = [
    section("Objective", objective, CODING_COLLABORATION_RECORD_LIMITS.sections.objective),
    section("Peer contributions", renderedContributions, CODING_COLLABORATION_RECORD_LIMITS.sections.contributions),
    section("Selected members", renderMembers(input.state, input.job), CODING_COLLABORATION_RECORD_LIMITS.sections.members),
    section("Tasks", renderTasks(input.state), CODING_COLLABORATION_RECORD_LIMITS.sections.tasks),
    section("Conflicts and resolution", renderConflicts(outputValues), CODING_COLLABORATION_RECORD_LIMITS.sections.conflicts),
    section("Certification", renderCertification(
      input.state,
      input.events,
      allContributions,
      acceptedOutputs.length > 0,
    ), CODING_COLLABORATION_RECORD_LIMITS.sections.certification),
    section("Current-head integration", renderIntegration(outputValues, input.runId), CODING_COLLABORATION_RECORD_LIMITS.sections.integration),
    section("Git handoff", `- Branch: ${safeInline(branch ?? "Not recorded", 500)}\n- Commit: ${safeInline(commit ?? "Not recorded", 500)}`, CODING_COLLABORATION_RECORD_LIMITS.sections.git),
    section("Result", renderResult(input.job), CODING_COLLABORATION_RECORD_LIMITS.sections.result),
    section(
      "Runtime diagnostics",
      renderDiagnostics(input.runtimeDiagnostics ?? []),
      CODING_COLLABORATION_RECORD_LIMITS.sections.diagnostics,
    ),
  ];
  const record = [
    "# Roster coding collaboration record",
    "",
    `- Run: ${safeInline(input.runId)}`,
    `- Selected job: ${safeInline(input.job.id)}`,
    `- Record basis: durable receipt replay head with ${input.receiptCount} receipt${input.receiptCount === 1 ? "" : "s"} plus an authoritative accepted-output snapshot with ${acceptedOutputs.length} output${acceptedOutputs.length === 1 ? "" : "s"}`,
    ...((input.acceptedOutputsOmitted ?? 0) > 0
      ? [`- Accepted output projection ${TRUNCATED}: ${input.acceptedOutputsOmitted} output${input.acceptedOutputsOmitted === 1 ? "" : "s"} omitted`]
      : []),
    "- Projection note: receipt replay and accepted outputs are independently observed durable projections; later state may produce a newer record. This is not an archival completion snapshot.",
    "",
    ...sections,
  ].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return boundedBlock(record, CODING_COLLABORATION_RECORD_LIMITS.totalBytes).trimEnd() + "\n";
};
