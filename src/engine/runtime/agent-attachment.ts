import type {
  JsonValue,
  WorkspaceNode,
  WorkspaceNodeRuntime,
} from "../orchestration/types.js";
import {
  normalizeWorkspaceNode,
  resolveWorkspaceNodeName,
  rosterNativeRuntime,
} from "../workspace/node.js";

type AttachmentMetadata = Readonly<Record<string, JsonValue>>;

type LocalAgentOptions = {
  readonly command?: ReadonlyArray<string>;
  readonly profile?: string;
  readonly workingDirectory?: string;
};

export type CodexAgentAttachment = LocalAgentOptions & {
  readonly kind: "codex";
  readonly model?: string;
  readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly sandbox?: "read-only" | "workspace-write";
};

export type ClaudeAgentAttachment = LocalAgentOptions & {
  readonly kind: "claude";
  readonly model?: string;
  readonly permissionMode?: "acceptEdits" | "dontAsk" | "plan";
};

export type PiAgentAttachment = LocalAgentOptions & {
  readonly kind: "pi";
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly projectTrust?: "approve" | "no-approve" | "default";
  readonly extensions?: ReadonlyArray<string>;
  readonly skills?: ReadonlyArray<string>;
  readonly tools?: ReadonlyArray<string>;
  readonly excludeTools?: ReadonlyArray<string>;
  readonly offline?: boolean;
};

export type HermesAgentAttachment = Omit<LocalAgentOptions, "profile"> & {
  readonly kind: "hermes";
  readonly provider?: string;
  readonly model?: string;
  readonly yolo?: boolean;
};

export type CommandAgentAttachment = {
  readonly kind: "command";
  /** Executable and argv prefix implementing the Roster envelope protocol over stdio. */
  readonly command: ReadonlyArray<string>;
  readonly profile?: string;
  readonly metadata?: AttachmentMetadata;
};

export type A2AAgentAttachment = {
  readonly kind: "a2a";
  readonly endpoint: string;
  readonly profile?: string;
  readonly metadata?: AttachmentMetadata;
};

export type NativeAgentAttachment = {
  readonly kind: "native";
  readonly profile?: string;
};

export type CustomAgentAttachment = {
  readonly kind: "custom";
  readonly runtime: WorkspaceNodeRuntime;
};

export type RosterAgentAttachment =
  | NativeAgentAttachment
  | CodexAgentAttachment
  | ClaudeAgentAttachment
  | PiAgentAttachment
  | HermesAgentAttachment
  | CommandAgentAttachment
  | A2AAgentAttachment
  | CustomAgentAttachment;

const metadata = (
  values: Readonly<Record<string, JsonValue | undefined>>,
): AttachmentMetadata | undefined => {
  const entries = Object.entries(values).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const localRuntime = (
  kind: WorkspaceNodeRuntime["kind"],
  attachment: LocalAgentOptions,
  values: Readonly<Record<string, JsonValue | undefined>>,
): WorkspaceNodeRuntime => ({
  kind,
  ...(attachment.profile ? { profile: attachment.profile } : {}),
  ...(attachment.command ? { command: [...attachment.command] } : {}),
  ...(metadata({ workingDirectory: attachment.workingDirectory, ...values })
    ? { metadata: metadata({ workingDirectory: attachment.workingDirectory, ...values }) }
    : {}),
});

/** Convert one ergonomic agent attachment into the provider-neutral node runtime. */
export const rosterAgentRuntime = (
  attachment: RosterAgentAttachment,
): WorkspaceNodeRuntime => {
  switch (attachment.kind) {
    case "native":
      return rosterNativeRuntime(attachment.profile);
    case "codex":
      return localRuntime("codex-cli", attachment, {
        model: attachment.model,
        reasoningEffort: attachment.reasoningEffort,
        sandbox: attachment.sandbox,
      });
    case "claude":
      return localRuntime("claude-code", attachment, {
        model: attachment.model,
        permissionMode: attachment.permissionMode,
      });
    case "pi":
      return localRuntime("pi-agent", attachment, {
        provider: attachment.provider,
        model: attachment.model,
        thinking: attachment.thinking,
        projectTrust: attachment.projectTrust,
        extensions: attachment.extensions,
        skills: attachment.skills,
        tools: attachment.tools,
        excludeTools: attachment.excludeTools,
        offline: attachment.offline,
      });
    case "hermes":
      return localRuntime("hermes-agent", attachment, {
        provider: attachment.provider,
        model: attachment.model,
        yolo: attachment.yolo,
      });
    case "command":
      return {
        kind: "shell",
        command: [...attachment.command],
        ...(attachment.profile ? { profile: attachment.profile } : {}),
        ...(attachment.metadata ? { metadata: { ...attachment.metadata } } : {}),
      };
    case "a2a":
      return {
        kind: "a2a",
        endpoint: attachment.endpoint,
        ...(attachment.profile ? { profile: attachment.profile } : {}),
        ...(attachment.metadata ? { metadata: { ...attachment.metadata } } : {}),
      };
    case "custom":
      return {
        ...attachment.runtime,
        ...(attachment.runtime.command ? { command: [...attachment.runtime.command] } : {}),
        ...(attachment.runtime.metadata ? { metadata: { ...attachment.runtime.metadata } } : {}),
      };
  }
};

export const attachNative = (
  options: Omit<NativeAgentAttachment, "kind"> = {},
): NativeAgentAttachment => ({ kind: "native", ...options });

export const attachCodex = (
  options: Omit<CodexAgentAttachment, "kind"> = {},
): CodexAgentAttachment => ({ kind: "codex", ...options });

export const attachClaude = (
  options: Omit<ClaudeAgentAttachment, "kind"> = {},
): ClaudeAgentAttachment => ({ kind: "claude", ...options });

export const attachPi = (
  options: Omit<PiAgentAttachment, "kind"> = {},
): PiAgentAttachment => ({ kind: "pi", ...options });

export const attachHermes = (
  options: Omit<HermesAgentAttachment, "kind"> = {},
): HermesAgentAttachment => ({ kind: "hermes", ...options });

export const attachCommand = (
  options: Omit<CommandAgentAttachment, "kind">,
): CommandAgentAttachment => ({ kind: "command", ...options });

export const attachA2A = (
  options: Omit<A2AAgentAttachment, "kind">,
): A2AAgentAttachment => ({ kind: "a2a", ...options });

export const attachCustomRuntime = (
  runtime: WorkspaceNodeRuntime,
): CustomAgentAttachment => ({ kind: "custom", runtime });

export type RosterMemberInput = {
  readonly id: string;
  readonly name?: string;
  readonly role?: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly attachment: RosterAgentAttachment;
  readonly parentId?: string;
  readonly promptProfile?: string;
  readonly metadata?: AttachmentMetadata;
};

/**
 * Define the durable member identity separately from the agent used to execute
 * its turns. Changing `attachment` never changes the member id or room history.
 */
export const defineRosterMember = (input: RosterMemberInput): WorkspaceNode => {
  const resolvedName = resolveWorkspaceNodeName({
    name: input.name,
    nameSource: input.name ? "profile" : undefined,
    capability: input.capabilities[0] ?? "participant",
    role: input.role,
  });
  return normalizeWorkspaceNode({
    id: input.id,
    name: resolvedName.name,
    capabilities: input.capabilities,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.promptProfile ? { promptProfile: input.promptProfile } : {}),
    runtime: rosterAgentRuntime(input.attachment),
    metadata: {
      ...(input.metadata ?? {}),
      ...(input.role ? { role: input.role } : {}),
      displayNameSource: resolvedName.source,
    },
  });
};
