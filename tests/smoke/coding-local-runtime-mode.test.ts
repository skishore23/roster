import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import test from "node:test";
import { populate } from "dotenv";

import {
  codingConversationModel,
  codingDefaultWorkerRuntime,
  codingLocalConversationModel,
  codingUsesLocalRuntimesOnly,
} from "../../src/agents/coding.agent.ts";
import { applyRosterLocalOnlyEnvironment } from "../../src/runtime/local-only.ts";
import {
  DEFAULT_CODING_WORKSPACE_CODEX_MODEL,
  DEFAULT_CODING_WORKSPACE_PI_MODEL,
} from "../../src/domains/coding-workspace.ts";
import {
  rosterLocalServerEntrypoint,
  rosterLocalServerEnvironment,
} from "../../src/operations/local-stack.ts";

test("desktop local mode uses the selected installed runtime without API credentials", () => {
  assert.equal(codingUsesLocalRuntimesOnly({
    ROSTER_CODING_LOCAL_ONLY: "1",
    OPENAI_API_KEY: "invalid-and-ignored",
  }), true);
  assert.equal(codingUsesLocalRuntimesOnly({ OPENAI_API_KEY: "present" }), false);

  assert.equal(codingDefaultWorkerRuntime({
    ROSTER_CODING_DEFAULT_RUNTIME: "codex-cli",
  }), "codex-cli");
  assert.equal(codingDefaultWorkerRuntime({
    ROSTER_CODING_DEFAULT_RUNTIME: "claude-code",
  }), "claude-code");
  assert.equal(codingDefaultWorkerRuntime({
    ROSTER_CODING_DEFAULT_RUNTIME: "hermes-agent",
  }), "hermes-agent");
  assert.equal(codingDefaultWorkerRuntime({
    ROSTER_CODING_DEFAULT_RUNTIME: "unsupported",
  }), "pi-agent");
});

test("shared local startup removes direct API credentials before loading the server", () => {
  const env: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: "must-not-leak",
    OPENAI_MODEL: "api-model",
    CODEX_HOME: "/keep-cli-auth-separate",
  };

  assert.equal(applyRosterLocalOnlyEnvironment(env), env);
  assert.equal(env.ROSTER_CODING_LOCAL_ONLY, "1");
  assert.equal(env.OPENAI_API_KEY, "");
  assert.equal(env.OPENAI_MODEL, "");
  assert.equal(env.CODEX_HOME, "/keep-cli-auth-separate");
  populate(env, {
    OPENAI_API_KEY: "must-stay-disabled",
    OPENAI_MODEL: "must-stay-disabled",
  });
  assert.equal(env.OPENAI_API_KEY, "");
  assert.equal(env.OPENAI_MODEL, "");
  assert.equal(rosterLocalServerEntrypoint("/repo"), "/repo/dist/local.js");
  const serverEnv = rosterLocalServerEnvironment("/repo", {
    PATH: "/usr/bin",
    OPENAI_API_KEY: "must-not-reach-local-server",
  });
  assert.equal(serverEnv.ROSTER_CODING_LOCAL_ONLY, "1");
  assert.equal(serverEnv.OPENAI_API_KEY, "");
  assert.equal(serverEnv.PATH?.split(delimiter)[0], join("/repo", "node_modules", ".bin"));
});

test("default mutation models use the efficient tier while review stays independently configurable", () => {
  assert.equal(DEFAULT_CODING_WORKSPACE_CODEX_MODEL, "gpt-5.6-luna");
  assert.equal(DEFAULT_CODING_WORKSPACE_PI_MODEL, "openai-codex/gpt-5.6-luna");
});

test("ordinary workspace conversation uses the low-cost semantic model by default", () => {
  assert.equal(codingConversationModel({}), "gpt-5.6-luna");
  assert.equal(codingConversationModel({
    ROSTER_CODING_CONVERSATION_MODEL: "conversation-override",
    OPENAI_MODEL: "quality-global",
  }), "conversation-override");
});

test("local conversation identity reports the selected model instead of execution placement", () => {
  assert.equal(codingLocalConversationModel("codex-cli", {}), "gpt-5.6-luna");
  assert.equal(codingLocalConversationModel("pi-agent", {
    ROSTER_CODING_PI_MODEL: "openai-codex/gpt-5.6-sol",
  }), "openai-codex/gpt-5.6-sol");
  assert.doesNotMatch(codingLocalConversationModel("pi-agent", {}), /\blocal\b/iu);
});
