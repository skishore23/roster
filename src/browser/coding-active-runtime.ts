export type CodingActiveRuntimeBinding = {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly bindingId: string;
  readonly epoch: bigint;
  readonly topologyVersion: string;
  readonly runtimeKind: string;
  readonly model: string;
  readonly reasoningEffort: string;
};

export type CodingSavedRuntimePreference = {
  readonly workerRuntime: "codex-cli" | "claude-code" | "pi-agent" | "hermes-agent";
  readonly model: string;
};

const runtimeLabel = (kind: string): string => kind === "codex-cli"
  ? "Codex CLI"
  : kind === "claude-code"
    ? "Claude Code"
    : kind === "pi-agent"
      ? "Pi Code"
      : kind === "hermes-agent"
        ? "Hermes Agent"
        : kind === "shell"
          ? "Host validation"
          : kind;

const titleCase = (value: string): string => value.replace(/(^|[-_\s]+)([a-z])/gu, (_match, prefix, letter: string) =>
  `${prefix ? " " : ""}${letter.toUpperCase()}`).trim();

export const codingPublicModelLabel = (model: string): string => model
  .replace(/^openai(?:-codex)?\//u, "")
  .replace("gpt-5.6-sol", "GPT-5.6 Sol")
  .replace("gpt-5.6-terra", "GPT-5.6 Terra")
  .replace("gpt-5.6-luna", "GPT-5.6 Luna");

export const codingNodeExecutionIdentity = (
  active: CodingActiveRuntimeBinding | undefined,
  preference?: CodingSavedRuntimePreference,
): {
  readonly runtime: string;
  readonly model: string;
  readonly scope: "active" | "preference";
} | undefined => {
  if (active) {
    const model = active.runtimeKind === "shell"
      ? "No LLM"
      : codingPublicModelLabel(active.model);
    const reasoning = active.reasoningEffort ? ` · ${titleCase(active.reasoningEffort)} reasoning` : "";
    return {
      runtime: runtimeLabel(active.runtimeKind),
      model: `${model}${active.runtimeKind === "shell" ? "" : reasoning}`,
      scope: "active",
    };
  }
  return preference ? {
    runtime: runtimeLabel(preference.workerRuntime),
    model: codingPublicModelLabel(preference.model),
    scope: "preference",
  } : undefined;
};
