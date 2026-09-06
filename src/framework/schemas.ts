import { z } from "zod";

export const theoremRunFormSchema = z.object({
  problem: z.string().optional(),
  append: z.string().optional(),
  rounds: z.string().optional(),
  depth: z.string().optional(),
  memory: z.string().optional(),
  branch: z.string().optional(),
  concurrency: z.string().optional(),
});

export const writerRunFormSchema = z.object({
  problem: z.string().optional(),
  append: z.string().optional(),
  parallel: z.string().optional(),
});

export const codingRunFormSchema = z.object({
  objective: z.string().trim().min(1).max(20_000),
  images: z.string().max(500_000).optional(),
  workspaceId: z.string().regex(/^workspace_[a-f0-9]{20}$/).optional(),
  conversationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/).optional(),
  externalId: z.string().trim().min(1).max(500).optional(),
  reviewPolicy: z.enum(["auto", "fast", "reviewed"]).optional(),
});

export const codingWorkspaceSettingsFormSchema = z.object({
  workspaceId: z.string().regex(/^workspace_[a-f0-9]{20}$/),
  nodeId: z.string().regex(/^workspace\.[A-Za-z0-9][A-Za-z0-9._:-]*$/).default("workspace.implementation"),
  workerRuntime: z.enum(["codex-cli", "claude-code", "pi-agent", "hermes-agent"]),
  codexModel: z.enum(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]).default("gpt-5.6-sol"),
  piModel: z.enum(["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-luna"]).default("openai-codex/gpt-5.6-luna"),
  claudeModel: z.enum(["opus", "sonnet", "haiku"]).default("sonnet"),
  hermesModel: z.enum(["default"]).default("default"),
});

export const agentRunFormSchema = z.object({
  problem: z.string().min(1),
  maxIterations: z.string().optional(),
  maxToolOutputChars: z.string().optional(),
  memoryScope: z.string().optional(),
  workspace: z.string().optional(),
  leanEnvironment: z.string().optional(),
  leanTimeoutSeconds: z.string().optional(),
  autoRepair: z.string().optional(),
  localValidationMode: z.string().optional(),
});

export const axiomSimpleRunFormSchema = z.object({
  problem: z.string().optional(),
  workerCount: z.string().optional(),
  repairMode: z.string().optional(),
});

export const receiptInspectFormSchema = z.object({
  stream: z.string().min(1).max(512),
  order: z.string().optional(),
  limit: z.string().optional(),
  at: z.string().optional(),
  depth: z.string().optional(),
  question: z.string().optional(),
});
