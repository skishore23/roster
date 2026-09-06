import { hashCanonical, sha256 } from "../../core/canonical.js";
import type { CompiledPrompt, DomainRegistry, PromptSpec } from "./types.js";

const PLACEHOLDER = /\{\{([A-Za-z0-9_.-]+)\}\}/g;
const HAS_PLACEHOLDER = /\{\{[A-Za-z0-9_.-]+\}\}/;

const render = (template: string, variables: Readonly<Record<string, string>>): string =>
  template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) throw new Error(`Missing template variable: {{${key}}}`);
    return value;
  });

export const versionPromptInputs = (
  inputs: Readonly<Record<string, unknown>>
): Readonly<Record<string, string>> => Object.fromEntries(
  Object.entries(inputs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, hashCanonical(value)])
);

export const compilePrompt = (registry: DomainRegistry, spec: PromptSpec): CompiledPrompt => {
  registry.assertNodeAssignment(spec.nodeId, spec.capability);
  if (!spec.runId.trim()) throw new Error("Prompt requires a runId");
  if (!spec.taskId.trim()) throw new Error("Prompt requires a taskId");
  if (!spec.template.id.trim() || !spec.template.version.trim()) {
    throw new Error("Prompt template requires an id and version");
  }
  if (HAS_PLACEHOLDER.test(spec.template.system)) {
    throw new Error("System prompt templates must be static; put dynamic values in the user template");
  }

  const system = spec.template.system;
  const userBase = render(spec.template.user, spec.variables);
  const constraints = (spec.constraints ?? []).filter((constraint) => constraint.trim().length > 0);
  const contract = spec.outputContract?.trim();
  const suffix = [
    constraints.length > 0 ? `Constraints:\n${constraints.map((constraint) => `- ${constraint}`).join("\n")}` : "",
    contract ? `Output contract:\n${contract}` : "",
  ].filter(Boolean).join("\n\n");
  const user = suffix ? `${userBase}\n\n${suffix}` : userBase;
  const systemHash = sha256(system);
  const userHash = sha256(user);
  const variablesHash = hashCanonical(spec.variables);
  const inputVersions = { ...(spec.inputVersions ?? {}) };
  const toolPolicy = [...(spec.toolPolicy ?? [])];
  const identity = {
    domainId: registry.pack.id,
    domainVersion: registry.pack.version,
    policyVersion: registry.pack.policyVersion,
    runId: spec.runId,
    taskId: spec.taskId,
    nodeId: spec.nodeId,
    capability: spec.capability,
    templateId: spec.template.id,
    templateVersion: spec.template.version,
    systemHash,
    userHash,
    variablesHash,
    inputVersions,
    outputContract: contract,
    toolPolicy,
  };
  const promptHash = hashCanonical(identity);

  return {
    promptId: `prompt-${promptHash.slice(0, 24)}`,
    ...identity,
    system,
    user,
    promptHash,
  };
};
