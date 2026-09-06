import { hashCanonical } from "../core/canonical.js";
import type {
  JsonValue,
  WorkspaceNode,
  WorkspaceNodeRuntime,
} from "../engine/orchestration/types.js";
import type { NodeRuntimeRegistry } from "../engine/runtime/node-runtime.js";
import type { NodeExecutionAttachmentInput } from "../engine/runtime/node-runtime.js";
import {
  classifyModelFailure,
  type ModelFailureClass,
} from "../engine/runtime/model-escalation.js";
import { CODING_COORDINATION_SKILL } from "./coding-coordination-skill.js";
import {
  CODING_CONVERSATION_PLANNER_OUTPUT_CONTRACT,
  codingConversationModelContext,
  validateCodingConversationPlannerResult,
  type CodingConversationPlanner,
  type CodingConversationPlannerInput,
} from "./coding-conversation.js";
import type { CodingWorkerExecution } from "./coding-execution.js";

type CodingConversationPlannerOutput = Awaited<ReturnType<CodingConversationPlanner>>;

export const codingConversationRuntimeAttachments = (
  input: Pick<CodingConversationPlannerInput, "messages" | "images">,
): ReadonlyArray<NodeExecutionAttachmentInput> => {
  const imageById = new Map((input.images ?? []).map((image) => [image.artifactId, image]));
  return input.messages
    .slice(-8)
    .flatMap((message) => message.attachments)
    .slice(-4)
    .flatMap((attachment) => {
      const image = imageById.get(attachment.artifactId);
      return image ? [{
        kind: "image" as const,
        attachmentId: image.artifactId,
        name: image.name,
        mediaType: image.mediaType,
        dataUrl: image.dataUrl,
      }] : [];
    });
};

export type LocalCodingConversationPlannerOptions = {
  readonly runtimes: NodeRuntimeRegistry;
  readonly execution: (
    input: CodingConversationPlannerInput,
  ) => CodingWorkerExecution | Promise<CodingWorkerExecution>;
  readonly timeoutMs?: number;
};

const TERMINAL_CONVERSATION_RUNTIME_FAILURES = new Set<ModelFailureClass>([
  "authentication",
  "authorization",
  "budget",
  "rate-limit",
  "provider",
  "provider-uncertain",
]);

export const codingConversationRuntimeFailureClass = (
  error: unknown,
): ModelFailureClass | undefined => {
  const failureClass = error instanceof CodingConversationRuntimeUnavailableError
    ? error.failureClass
    : classifyModelFailure(error);
  return TERMINAL_CONVERSATION_RUNTIME_FAILURES.has(failureClass) ? failureClass : undefined;
};

export class CodingConversationRuntimeUnavailableError extends Error {
  constructor(
    readonly failureClass: ModelFailureClass,
    readonly runtimeError: unknown,
  ) {
    super(
      `Conversation runtime unavailable (${failureClass}): ${
        runtimeError instanceof Error ? runtimeError.message : String(runtimeError)
      }`,
    );
    this.name = "CodingConversationRuntimeUnavailableError";
  }
}

const runtimeForConversation = (
  execution: CodingWorkerExecution,
  workingDirectory: string | undefined,
): WorkspaceNodeRuntime => {
  if (execution.runtime === "codex-cli") {
    return {
      kind: "codex-cli",
      metadata: {
        ...(workingDirectory ? { workingDirectory } : {}),
        model: execution.model,
        reasoningEffort: "low",
        sandbox: "read-only",
      },
    };
  }
  if (execution.runtime === "claude-code") {
    return {
      kind: "claude-code",
      metadata: {
        ...(workingDirectory ? { workingDirectory } : {}),
        model: execution.model,
        permissionMode: "plan",
      },
    };
  }
  if (execution.runtime === "hermes-agent") {
    return {
      kind: "hermes-agent",
      metadata: {
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(execution.provider ? { provider: execution.provider } : {}),
        model: execution.model,
        yolo: false,
      },
    };
  }
  return {
    kind: "pi-agent",
    metadata: {
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(execution.pi.provider ? { provider: execution.pi.provider } : {}),
      model: execution.pi.model,
      thinking: "low",
      projectTrust: "no-approve",
      noBuiltinTools: true,
      noExtensions: true,
      // Disable ambient provider discovery. Roster supplies the exact bounded,
      // hashed coordination skill in the execution envelope below.
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noTools: true,
      noContextFiles: true,
    },
  };
};

const runtimeContext = (execution: CodingWorkerExecution): JsonValue => ({
  kind: execution.runtime,
  model: execution.model,
  responsibility: "conversation planning and answers",
  executionAuthority: {
    repositoryMutation: "route-only",
    hostProcess: "none",
    browserControl: "none",
    currentCheckoutGit: "none",
  },
});

const conversationNode = (
  execution: CodingWorkerExecution,
  workingDirectory: string | undefined,
): WorkspaceNode => ({
  id: "roster.conversation",
  name: "Roster",
  capabilities: ["route-conversation", "answer-conversation"],
  runtime: runtimeForConversation(execution, workingDirectory),
  metadata: {
    role: "system",
    participantKind: "system",
    authority: "conversation-only",
  },
});

const jsonStringPrefix = (value: string, start: number): string => {
  let result = "";
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') return result;
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escape = value[index + 1];
    if (escape === undefined) return result;
    index += 1;
    if (escape === "u") {
      const encoded = value.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/iu.test(encoded)) return result;
      result += JSON.parse(`"\\u${encoded}"`) as string;
      index += 4;
      continue;
    }
    const escaped = ({
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    } as const)[escape as '"' | "\\" | "/" | "b" | "f" | "n" | "r" | "t"];
    if (escaped === undefined) return result;
    result += escaped;
  }
  return result;
};

const streamedTopLevelJsonString = (value: string, field: string): string | undefined => {
  const objectStart = value.indexOf("{");
  if (objectStart < 0) return undefined;
  let depth = 0;
  let previousSignificant = "";
  for (let index = objectStart; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') {
      let end = index + 1;
      let escaped = false;
      for (; end < value.length; end += 1) {
        const candidate = value[end]!;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (candidate === "\\") {
          escaped = true;
          continue;
        }
        if (candidate === '"') break;
      }
      if (end >= value.length) return undefined;
      if (depth === 1 && (previousSignificant === "{" || previousSignificant === ",")) {
        let key: unknown;
        try {
          key = JSON.parse(value.slice(index, end + 1));
        } catch {
          return undefined;
        }
        let cursor = end + 1;
        while (/\s/u.test(value[cursor] ?? "")) cursor += 1;
        if (value[cursor] === ":") cursor += 1;
        while (/\s/u.test(value[cursor] ?? "")) cursor += 1;
        if (key === field && value[cursor] === '"') {
          return jsonStringPrefix(value, cursor + 1);
        }
      }
      index = end;
      previousSignificant = '"';
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    if (!/\s/u.test(character)) previousSignificant = character;
  }
  return undefined;
};

/**
 * Runs one bounded, tool-free conversation turn through the desktop-selected
 * local runtime. The complete durable transcript is model input; the runtime
 * does not own room history, topology, task creation, or acceptance.
 */
export const localRuntimeCodingConversationPlanner = (
  options: LocalCodingConversationPlannerOptions,
): CodingConversationPlanner => async (input) => {
  const execution = await options.execution(input);
  const node = conversationNode(execution, input.repositoryRoot);
  const latest = input.messages.at(-1);
  const taskId = `conversation_${hashCanonical({
    conversationId: input.conversationId,
    messageId: latest?.messageId ?? "empty",
    responderNodeId: input.responder?.id ?? null,
    runtime: execution.runtime,
    model: execution.model,
  }).slice(0, 24)}`;
  let priorFailure = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let streamedOutput = "";
    let streamedAnswer = "";
    let pendingDeltas = Promise.resolve();
    try {
      const output = await options.runtimes.execute<unknown>({
        runId: input.conversationId,
        node,
        task: {
          taskId,
          nodeId: node.id,
          capability: "route-conversation",
          objective: [
            "Apply the supplied roster-coordination skill to the complete chronological room context and return the typed coordination decision.",
            ...(input.responder ? [
              `This is a bounded peer reply authored by saved participant ${input.responder.name} (${input.responder.id}). Return an informational answer in that participant's first-person voice to the latest speaker. Do not describe, tag, or ask ${input.responder.name} to respond.`,
            ] : []),
            ...(priorFailure
              ? [`The prior draft was rejected by Roster validation: ${priorFailure}. Correct the structured decision without changing the user's request.`]
              : []),
          ].join(" "),
        },
        input: codingConversationModelContext({
          ...input,
          runtimeContext: runtimeContext(execution),
        }),
        resultContract: {
          mode: "json",
          outputKey: "decision",
          schema: CODING_CONVERSATION_PLANNER_OUTPUT_CONTRACT,
        },
        surface: { skills: [CODING_COORDINATION_SKILL] },
        attachments: codingConversationRuntimeAttachments(input),
        attempt,
        timeoutMs: options.timeoutMs ?? 120_000,
        ...(input.onDelta ? {
          onModelOutput: (entry) => {
            streamedOutput = entry.kind === "delta"
              ? `${streamedOutput}${entry.text}`
              : entry.text;
            if (streamedTopLevelJsonString(streamedOutput, "disposition") !== "informational") {
              return;
            }
            const nextAnswer = streamedTopLevelJsonString(streamedOutput, "answer");
            if (nextAnswer === undefined
              || !nextAnswer.startsWith(streamedAnswer)
              || nextAnswer.length === streamedAnswer.length) return;
            const delta = nextAnswer.slice(streamedAnswer.length);
            streamedAnswer = nextAnswer;
            pendingDeltas = pendingDeltas.then(() => input.onDelta?.(delta));
          },
        } : {}),
        execute: async () => {
          throw new Error("The local conversation node requires an attached CLI runtime");
        },
      });
      await pendingDeltas;
      return validateCodingConversationPlannerResult(
        output as CodingConversationPlannerOutput,
        input.workspaceNodes,
      );
    } catch (error) {
      priorFailure = (error instanceof Error ? error.message : "invalid planner output")
        .replace(/\s+/gu, " ")
        .slice(0, 500);
      const failureClass = codingConversationRuntimeFailureClass(error);
      if (failureClass) {
        throw new CodingConversationRuntimeUnavailableError(failureClass, error);
      }
    }
  }
  throw new Error(`Conversation planner failed after two bounded attempts: ${priorFailure}`);
};
