import type { NodeExecutionEnvelope } from "./node-runtime.js";

export const NODE_EXECUTION_PROMPT_CONTEXT_SCHEMA_VERSION =
  "roster.node-prompt-context.v1" as const;

export type NodeExecutionPromptAttachment = {
  readonly attachmentId: string;
  readonly runtimePath: string;
};

/**
 * Compile the provider-neutral instructions shared by every attached agent.
 * Domain specialization lives in the node profile and task envelope, not in
 * transport-specific prompts.
 */
export const compileNodeExecutionPrompt = (
  envelope: NodeExecutionEnvelope,
  attachments: ReadonlyArray<NodeExecutionPromptAttachment> = [],
): string => {
  const {
    schemaVersion: executionSchemaVersion,
    target: _target,
    resultContract: _resultContract,
    task,
    attachments: envelopeAttachments,
    ...context
  } = envelope;
  const { objective: _objective, ...modelFacingTask } = task;
  const modelFacingEnvelope = {
    schemaVersion: NODE_EXECUTION_PROMPT_CONTEXT_SCHEMA_VERSION,
    executionSchemaVersion,
    ...context,
    task: modelFacingTask,
    ...(envelopeAttachments ? {
      attachments: envelopeAttachments.map(({ dataUrl: _dataUrl, ...attachment }) => attachment),
    } : {}),
  };
  const resultInstructions = (() => {
    switch (envelope.resultContract.mode) {
      case "text":
        return [
          `Return the final contribution as natural text for output "${envelope.resultContract.outputKey}".`,
          "Do not wrap the response in JSON unless the task itself requires JSON as content.",
        ];
      case "json":
        return [
          "Return only one JSON value matching the declared result schema. Do not wrap it in Markdown.",
          `Result schema: ${JSON.stringify(envelope.resultContract.schema)}`,
        ];
      case "artifact":
        return [
          `Produce the requested ${envelope.resultContract.artifactKind} artifact for output "${envelope.resultContract.outputKey}".`,
          "Return only the smallest draft or reference needed by Roster's trusted acceptance boundary.",
        ];
      case "none":
        return [
          "This is a control or side-effect task. Do not manufacture a substantive result body.",
          "Return a concise completion acknowledgement after the assigned operation finishes.",
        ];
    }
  })();
  const rlmInvokeTool = envelope.surface.tools.find((tool) =>
    tool.id === "roster::catalog.invoke");
  const hasRlmCatalog = envelope.surface.tools.some((tool) =>
    tool.id === "roster::catalog.search")
    && Boolean(rlmInvokeTool);
  const hasRlmPipeline = rlmInvokeTool
    ? JSON.stringify(rlmInvokeTool.inputSchema).includes("\"pipeline\"")
    : false;
  const canConsultPeers = envelope.grant.functionAccess.functionGrants.includes("roster::consult");
  return [
  "You are a named Roster member executing one bounded turn inside a shared room.",
  "Complete only the assigned objective and return the contribution requested by the declared output contract.",
  "Use the current workspace when the objective requires files or artifacts.",
  "Respect the workspace's own instructions and inspect relevant context before acting.",
  "Apply every exact Roster-supplied skill in the execution envelope that is relevant to this turn.",
  "If node.metadata.repositorySkills lists Git-owned SKILL.md files, read only the ones relevant to this turn.",
  "Apply relevant operatingInstructions, specialistSkills, focusPaths, toolRequirements, and collaborationDependencies from the member's durable profile.",
  "Treat other members as peers: proposals and reviews do not mutate shared work unless this turn explicitly grants mutation authority.",
  "Do not create commits, push branches, open pull requests, or change remotes unless the objective explicitly requests publishing.",
  "Roster owns membership, scheduling, budgets, shared-state acceptance, conflict handling, and resolution. Do not take over those responsibilities.",
  "When target is present, treat it as the room's shared goal and do not silently reinterpret its acceptance criteria or constraints.",
  ...(hasRlmCatalog ? [
    "Treat the live function catalog as an external RLM environment; do not assume the prompt contains every available worker.",
    "Use roster::catalog.search to retrieve only relevant bounded summaries, then roster::catalog.invoke with the returned catalog version, function version, provider ID, and provider epoch.",
    "Use catalog invoke operation `describe` for one elected schema and `call` for one worker.",
    ...(hasRlmPipeline ? [
      "Use catalog invoke operation `pipeline` for deterministic worker-to-worker composition over DataReferences.",
    ] : []),
    "Use a discovered roster::expand call when the objective needs independent reasoning or recursively delegated swarm work; use a pipeline for deterministic transforms that do not need another model turn.",
  ] : []),
  ...(canConsultPeers ? [
    "The execution input lists only the peer nodes currently eligible for bounded consultation.",
    ...(envelope.surface.codeMode ? [
      "Before consulting, use `roster-tool list` and inspect the `task.input` context handle to read `eligiblePeers`; choose recipient node IDs only from that field.",
      "Do not search the function catalog for peer identities. Search it for `consult` without a capability filter, then call `roster::catalog.invoke` with the returned roster::consult version and provider coordinates.",
    ] : []),
    "When a concrete unresolved question would benefit from another listed specialty, discover roster::consult through the catalog and submit one typed roster.node-consultation.v1 request.",
    "Roster will pause this task, obtain the accepted peer responses, and resume the same logical objective in an explicit continuation.",
    "Consult peers selectively: do not ask them to repeat settled work, do not invent recipients, and answer directly when the supplied evidence is sufficient.",
  ] : []),
  ...(envelope.surface.codeMode ? [
    "A bounded code-mode context store is available through the `roster-tool` command.",
    "Use `roster-tool list`, `peek`, and `search` to inspect handles selectively.",
    "Use `roster-tool materialize <handle>` to place a complete value in the private code-mode value directory; process that file with code and do not print the whole value.",
    "Call an authorized function with `roster-tool call <function-id> [await|void|enqueue]`, providing its JSON input on stdin.",
    "A function input may reference a stored value as {\"$rosterContext\":\"<handle>\",\"pointer\":\"/optional/json/pointer\"}; Roster resolves it before validating and invoking the function.",
    "Completed function calls return context handles, not result bodies. Use code to reduce those values and expose only evidence needed for the final output.",
    "When roster::memory functions are discovered, search only listed scopes and preserve document IDs, content hashes, and source versions in any derived claim.",
    "roster::memory.propose creates pending memory only. Never claim a proposal was accepted unless authoritative context says so.",
    "Roster validates projected functions and enforces invocation and context bounds. Do not bypass the tool client or spawn unreceipted replacement workers.",
  ] : []),
  ...(attachments.length ? [
    "Image attachments are available at the runtime paths listed below and are part of the task input.",
    ...attachments.map((attachment) =>
      `Attachment ${attachment.attachmentId}: ${attachment.runtimePath}`),
  ] : []),
  ...resultInstructions,
  "",
  `Turn objective: ${envelope.task.objective ?? envelope.task.capability}`,
  ...(envelope.target ? [`Shared target: ${JSON.stringify(envelope.target)}`] : []),
  "Roster room context:",
  JSON.stringify(modelFacingEnvelope),
  ].join("\n");
};
