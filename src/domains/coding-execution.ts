import {
  DEFAULT_CODING_PI_EXTENSION_PACKAGES,
  resolvePiExtensionPackagePaths,
} from "../engine/runtime/pi-extension-packages.js";
import {
  DEFAULT_CODING_AGENT_MODELS,
  type CodingCodexReasoningEffort,
  type CodingPiProjectTrust,
  type CodingWorkerRuntime,
} from "./coding.js";

export const CODING_WORKER_EXECUTION_SCHEMA = "roster.coding-worker-execution.v1" as const;

export type CodingWorkerSelectionSource =
  | "api-override"
  | "node-preference"
  | "workspace-default"
  | "product-default";

export type CodingPiThinking =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type CodingPiExecution = {
  readonly provider?: string;
  /** Pi model name, unqualified when provider is present. */
  readonly model: string;
  readonly thinking?: CodingPiThinking;
  readonly extensionPackages: ReadonlyArray<string>;
  readonly extensions: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly promptTemplates: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  readonly excludeTools: ReadonlyArray<string>;
  readonly projectTrust?: CodingPiProjectTrust;
  readonly noBuiltinTools?: boolean;
  readonly noExtensions?: boolean;
  readonly offline?: boolean;
};

export type CodingWorkerExecution =
  | {
      readonly schema: typeof CODING_WORKER_EXECUTION_SCHEMA;
      readonly runtime: "pi-agent";
      readonly source: CodingWorkerSelectionSource;
      readonly model: string;
      readonly pi: CodingPiExecution;
    }
  | {
      readonly schema: typeof CODING_WORKER_EXECUTION_SCHEMA;
      readonly runtime: "codex-cli";
      readonly source: CodingWorkerSelectionSource;
      readonly model: string;
      readonly reasoningEffort: CodingCodexReasoningEffort;
      /** Explicit API-only authority to resolve public-registry dependencies after edits. */
      readonly dependencyResolution?: "registry";
    }
  | {
      readonly schema: typeof CODING_WORKER_EXECUTION_SCHEMA;
      readonly runtime: "claude-code";
      readonly source: CodingWorkerSelectionSource;
      readonly model: string;
    }
  | {
      readonly schema: typeof CODING_WORKER_EXECUTION_SCHEMA;
      readonly runtime: "hermes-agent";
      readonly source: CodingWorkerSelectionSource;
      readonly model: string;
      readonly provider?: string;
    };

const PI_THINKING_LEVELS: ReadonlyArray<CodingPiThinking> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const PI_PROJECT_TRUST: ReadonlyArray<CodingPiProjectTrust> = [
  "approve",
  "no-approve",
  "default",
];

const WORKER_SELECTION_SOURCES: ReadonlyArray<CodingWorkerSelectionSource> = [
  "api-override",
  "node-preference",
  "workspace-default",
  "product-default",
];

const boundedString = (value: unknown, maxLength = 2_048): string | undefined =>
  typeof value === "string" && value.trim() && value.trim().length <= maxLength
    ? value.trim()
    : undefined;

const stringArray = (
  value: unknown,
  maxItems = 32,
  maxItemLength = 2_048,
): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const normalized = value.map((item) => boundedString(item, maxItemLength));
  return normalized.every((item): item is string => item !== undefined)
    ? normalized
    : undefined;
};

const uniqueStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(values),
];

const envString = (env: NodeJS.ProcessEnv, name: string): string | undefined =>
  boundedString(env[name]);

const envCsv = (env: NodeJS.ProcessEnv, name: string): ReadonlyArray<string> | undefined => {
  const value = envString(env, name);
  if (!value) return undefined;
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  return values.length > 0 && values.length <= 32 && values.every((item) => item.length <= 2_048)
    ? uniqueStrings(values)
    : undefined;
};

const envBoolean = (env: NodeJS.ProcessEnv, name: string): boolean | undefined => {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
};

const qualifiedPiModel = (
  provider: string | undefined,
  model: string,
): { readonly provider?: string; readonly model: string; readonly displayModel: string } => {
  const slash = model.indexOf("/");
  const modelProvider = slash > 0 ? model.slice(0, slash) : undefined;
  const modelName = slash > 0 ? model.slice(slash + 1) : model;
  if (!modelName) throw new Error("Pi model must not be blank");
  if (provider && modelProvider && provider !== modelProvider) {
    throw new Error(`Pi provider ${provider} conflicts with qualified model ${model}`);
  }
  const resolvedProvider = provider ?? modelProvider;
  return {
    ...(resolvedProvider ? { provider: resolvedProvider } : {}),
    model: resolvedProvider && modelProvider ? modelName : model,
    displayModel: resolvedProvider ? `${resolvedProvider}/${modelName}` : modelName,
  };
};

const piThinking = (value: string | undefined): CodingPiThinking | undefined =>
  value && (PI_THINKING_LEVELS as ReadonlyArray<string>).includes(value)
    ? value as CodingPiThinking
    : undefined;

const piProjectTrust = (value: string | undefined): CodingPiProjectTrust | undefined =>
  value && (PI_PROJECT_TRUST as ReadonlyArray<string>).includes(value)
    ? value as CodingPiProjectTrust
    : undefined;

export const createCodingWorkerExecution = (input: {
  readonly runtime: CodingWorkerRuntime;
  readonly source: CodingWorkerSelectionSource;
  readonly workerModel?: string;
  readonly dependencyResolution?: "registry";
  readonly env?: NodeJS.ProcessEnv;
}): CodingWorkerExecution => {
  const env = input.env ?? process.env;
  if (input.dependencyResolution !== undefined && (
    input.dependencyResolution !== "registry"
    || input.runtime !== "codex-cli"
    || input.source !== "api-override"
  )) {
    throw new Error("Dependency resolution requires an authenticated Codex API override");
  }
  if (input.runtime === "codex-cli") {
    return {
      schema: CODING_WORKER_EXECUTION_SCHEMA,
      runtime: "codex-cli",
      source: input.source,
      model: input.workerModel ?? DEFAULT_CODING_AGENT_MODELS.worker,
      reasoningEffort: "high",
      ...(input.dependencyResolution ? { dependencyResolution: input.dependencyResolution } : {}),
    };
  }
  if (input.runtime === "claude-code") {
    return {
      schema: CODING_WORKER_EXECUTION_SCHEMA,
      runtime: "claude-code",
      source: input.source,
      model: input.workerModel ?? DEFAULT_CODING_AGENT_MODELS.claudeWorker,
    };
  }
  if (input.runtime === "hermes-agent") {
    const provider = envString(env, "ROSTER_CODING_HERMES_PROVIDER");
    const model = input.workerModel
      ?? envString(env, "ROSTER_CODING_HERMES_MODEL")
      ?? DEFAULT_CODING_AGENT_MODELS.hermesWorker;
    return {
      schema: CODING_WORKER_EXECUTION_SCHEMA,
      runtime: "hermes-agent",
      source: input.source,
      model,
      ...(provider ? { provider } : {}),
    };
  }

  const provider = envString(env, "ROSTER_CODING_PI_PROVIDER");
  const configuredModel = envString(env, "ROSTER_CODING_PI_MODEL");
  const normalizedModel = qualifiedPiModel(
    provider,
    configuredModel ?? input.workerModel ?? DEFAULT_CODING_AGENT_MODELS.piWorker,
  );
  const configuredExtensionPackages = envCsv(env, "ROSTER_CODING_PI_EXTENSION_PACKAGES");
  const defaultExtensionPackagesEnabled =
    envBoolean(env, "ROSTER_CODING_PI_ENABLE_DEFAULT_EXTENSIONS") ?? true;
  const extensionPackages = configuredExtensionPackages
    ?? (defaultExtensionPackagesEnabled ? [...DEFAULT_CODING_PI_EXTENSION_PACKAGES] : []);
  const extensions = uniqueStrings([
    ...resolvePiExtensionPackagePaths(extensionPackages),
    ...(envCsv(env, "ROSTER_CODING_PI_EXTENSIONS") ?? []),
  ]);
  const thinkingValue = envString(env, "ROSTER_CODING_PI_THINKING");
  const thinking = piThinking(thinkingValue);
  if (thinkingValue && !thinking) {
    throw new Error(`Unsupported Pi thinking level ${thinkingValue}`);
  }
  const projectTrustValue = envString(env, "ROSTER_CODING_PI_PROJECT_TRUST");
  const projectTrust = piProjectTrust(projectTrustValue);
  if (projectTrustValue && !projectTrust) {
    throw new Error(`Unsupported Pi project trust mode ${projectTrustValue}`);
  }
  const noBuiltinTools = envBoolean(env, "ROSTER_CODING_PI_NO_BUILTIN_TOOLS");
  const noExtensions = envBoolean(env, "ROSTER_CODING_PI_NO_EXTENSIONS");
  const offline = envBoolean(env, "ROSTER_CODING_PI_OFFLINE");
  return {
    schema: CODING_WORKER_EXECUTION_SCHEMA,
    runtime: "pi-agent",
    source: input.source,
    model: normalizedModel.displayModel,
    pi: {
      ...(normalizedModel.provider ? { provider: normalizedModel.provider } : {}),
      model: normalizedModel.model,
      ...(thinking ? { thinking } : {}),
      extensionPackages,
      extensions,
      skills: envCsv(env, "ROSTER_CODING_PI_SKILLS") ?? [],
      promptTemplates: envCsv(env, "ROSTER_CODING_PI_PROMPT_TEMPLATES") ?? [],
      tools: envCsv(env, "ROSTER_CODING_PI_TOOLS") ?? [],
      excludeTools: envCsv(env, "ROSTER_CODING_PI_EXCLUDE_TOOLS") ?? [],
      ...(projectTrust ? { projectTrust } : {}),
      ...(noBuiltinTools !== undefined ? { noBuiltinTools } : {}),
      ...(noExtensions !== undefined ? { noExtensions } : {}),
      ...(offline !== undefined ? { offline } : {}),
    },
  };
};

const parseSource = (value: unknown): CodingWorkerSelectionSource | undefined =>
  typeof value === "string" && (WORKER_SELECTION_SOURCES as ReadonlyArray<string>).includes(value)
    ? value as CodingWorkerSelectionSource
    : undefined;

export const parseCodingWorkerExecution = (
  value: unknown,
): CodingWorkerExecution | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as {
    readonly schema?: unknown;
    readonly runtime?: unknown;
    readonly source?: unknown;
    readonly model?: unknown;
    readonly reasoningEffort?: unknown;
    readonly pi?: unknown;
    readonly provider?: unknown;
    readonly dependencyResolution?: unknown;
  };
  const source = parseSource(candidate.source);
  const model = boundedString(candidate.model, 512);
  if (candidate.schema !== CODING_WORKER_EXECUTION_SCHEMA || !source || !model) return undefined;
  if (candidate.dependencyResolution !== undefined && candidate.runtime !== "codex-cli") {
    return undefined;
  }
  if (candidate.runtime === "codex-cli") {
    const reasoningEffort = candidate.reasoningEffort;
    const dependencyResolution = candidate.dependencyResolution;
    return ["low", "medium", "high", "xhigh", "max"].includes(String(reasoningEffort))
      && (dependencyResolution === undefined
        || (dependencyResolution === "registry" && source === "api-override"))
      ? {
          schema: CODING_WORKER_EXECUTION_SCHEMA,
          runtime: "codex-cli",
          source,
          model,
          reasoningEffort: reasoningEffort as CodingCodexReasoningEffort,
          ...(dependencyResolution === "registry" ? { dependencyResolution } : {}),
        }
      : undefined;
  }
  if (candidate.runtime === "claude-code") {
    return {
      schema: CODING_WORKER_EXECUTION_SCHEMA,
      runtime: "claude-code",
      source,
      model,
    };
  }
  if (candidate.runtime === "hermes-agent") {
    const provider = candidate.provider === undefined ? undefined : boundedString(candidate.provider, 160);
    if (candidate.provider !== undefined && !provider) return undefined;
    return {
      schema: CODING_WORKER_EXECUTION_SCHEMA,
      runtime: "hermes-agent",
      source,
      model,
      ...(provider ? { provider } : {}),
    };
  }
  if (candidate.runtime !== "pi-agent"
    || !candidate.pi
    || typeof candidate.pi !== "object"
    || Array.isArray(candidate.pi)) return undefined;
  const pi = candidate.pi as Partial<CodingPiExecution>;
  const piModel = boundedString(pi.model, 512);
  const provider = pi.provider === undefined ? undefined : boundedString(pi.provider, 160);
  const extensionPackages = stringArray(pi.extensionPackages, 32, 256);
  const extensions = stringArray(pi.extensions);
  const skills = stringArray(pi.skills);
  const promptTemplates = stringArray(pi.promptTemplates);
  const tools = stringArray(pi.tools, 64, 256);
  const excludeTools = stringArray(pi.excludeTools, 64, 256);
  if (!piModel
    || (pi.provider !== undefined && !provider)
    || !extensionPackages
    || !extensions
    || !skills
    || !promptTemplates
    || !tools
    || !excludeTools
    || (pi.thinking !== undefined && !PI_THINKING_LEVELS.includes(pi.thinking))
    || (pi.projectTrust !== undefined && !PI_PROJECT_TRUST.includes(pi.projectTrust))
    || (pi.noBuiltinTools !== undefined && typeof pi.noBuiltinTools !== "boolean")
    || (pi.noExtensions !== undefined && typeof pi.noExtensions !== "boolean")
    || (pi.offline !== undefined && typeof pi.offline !== "boolean")) return undefined;
  const normalizedModel = qualifiedPiModel(provider, piModel);
  if (normalizedModel.displayModel !== model) return undefined;
  return {
    schema: CODING_WORKER_EXECUTION_SCHEMA,
    runtime: "pi-agent",
    source,
    model,
    pi: {
      ...(provider ? { provider } : {}),
      model: piModel,
      ...(pi.thinking ? { thinking: pi.thinking } : {}),
      extensionPackages,
      extensions,
      skills,
      promptTemplates,
      tools,
      excludeTools,
      ...(pi.projectTrust ? { projectTrust: pi.projectTrust } : {}),
      ...(pi.noBuiltinTools !== undefined ? { noBuiltinTools: pi.noBuiltinTools } : {}),
      ...(pi.noExtensions !== undefined ? { noExtensions: pi.noExtensions } : {}),
      ...(pi.offline !== undefined ? { offline: pi.offline } : {}),
    },
  };
};

export const codingWorkerExecutionRosterOptions = (
  execution: CodingWorkerExecution,
) => execution.runtime === "pi-agent"
  ? {
      workerRuntime: execution.runtime,
      piProvider: execution.pi.provider,
      piModel: execution.pi.model,
      piThinking: execution.pi.thinking,
      piExtensions: execution.pi.extensions,
      piSkills: execution.pi.skills,
      piPromptTemplates: execution.pi.promptTemplates,
      piTools: execution.pi.tools,
      piExcludeTools: execution.pi.excludeTools,
      piProjectTrust: execution.pi.projectTrust,
      piNoBuiltinTools: execution.pi.noBuiltinTools,
      piNoExtensions: execution.pi.noExtensions,
      piOffline: execution.pi.offline,
    } as const
  : execution.runtime === "codex-cli"
    ? {
        workerRuntime: execution.runtime,
        codexModel: execution.model,
        codexReasoningEffort: execution.reasoningEffort,
        ...(execution.dependencyResolution
          ? { dependencyResolution: execution.dependencyResolution }
          : {}),
      } as const
    : execution.runtime === "claude-code"
      ? {
        workerRuntime: execution.runtime,
        claudeModel: execution.model,
      } as const
      : {
          workerRuntime: execution.runtime,
          hermesProvider: execution.provider,
          hermesModel: execution.model,
        } as const;
