import assert from "node:assert/strict";
import test from "node:test";

import { zodTextFormat } from "openai/helpers/zod";

import { modelCodingWorkspaceToolchainOnboarder } from "../../src/domains/coding-workspace-toolchain.js";

test("toolchain onboarding emits a strict Responses schema with nullable cwd", async () => {
  let commandRequired: readonly string[] = [];
  const onboarder = modelCodingWorkspaceToolchainOnboarder(async (input) => {
    const schema = zodTextFormat(input.schema, input.schemaName).schema as {
      readonly properties?: {
        readonly installCommands?: {
          readonly items?: {
            readonly required?: readonly string[];
            readonly properties?: {
              readonly cwd?: { readonly anyOf?: ReadonlyArray<{ readonly type?: string }> };
            };
          };
        };
      };
    };
    const command = schema.properties?.installCommands?.items;
    commandRequired = command?.required ?? [];
    assert.deepEqual(
      command?.properties?.cwd?.anyOf?.map((entry) => entry.type).sort(),
      ["null", "string"],
    );
    return {
      parsed: {
        summary: "Use the checked-in npm scripts.",
        evidenceFiles: ["package.json"],
        installCommands: [{ command: "npm", args: ["ci"], cwd: null }],
        verifyCommands: [{ command: "npm", args: ["run", "verify"], cwd: null }],
      },
      raw: "{}",
    };
  });

  const proposal = await onboarder({
    repositoryRoot: "/workspace",
    repositoryFingerprint: "fingerprint",
    technologies: ["node"],
    evidence: [{
      path: "package.json",
      content: "{}",
      contentHash: "hash",
      truncated: false,
    }],
    allowedCommands: ["npm"],
  });

  assert.ok(commandRequired.includes("cwd"));
  assert.equal(proposal.installCommands[0]?.cwd, null);
});
