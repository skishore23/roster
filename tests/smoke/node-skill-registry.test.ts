import assert from "node:assert/strict";
import test from "node:test";

import {
  createNodeExecutionSurface,
  createNodeExecutionSkill,
  MAX_NODE_EXECUTION_SKILLS,
} from "../../src/engine/runtime/node-runtime.ts";
import {
  NodeExecutionSkillRegistry,
} from "../../src/engine/runtime/node-skill-registry.ts";

const skill = (id: string) => createNodeExecutionSkill({
  id,
  name: `${id} skill`,
  description: `Apply ${id} behavior to one bounded task.`,
  instructions: `Use the ${id} contract and preserve Roster authority.`,
});

test("node skill registry returns exact content-addressed selections", () => {
  const first = skill("first");
  const second = skill("second");
  const registry = new NodeExecutionSkillRegistry([first, second]);

  const selected = registry.select(["second", "first"]);

  assert.deepEqual(selected.map((entry) => entry.id), ["second", "first"]);
  assert.deepEqual(selected.map((entry) => entry.contentHash), [
    second.contentHash,
    first.contentHash,
  ]);
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected[0]), true);
  assert.deepEqual(registry.entries().map((entry) => entry.id), ["first", "second"]);
});

test("node skill registry fails closed for ambiguous or excessive selections", () => {
  assert.throws(
    () => new NodeExecutionSkillRegistry([skill("duplicate"), skill("duplicate")]),
    /Duplicate node execution skill duplicate/u,
  );

  const registry = new NodeExecutionSkillRegistry(
    Array.from({ length: MAX_NODE_EXECUTION_SKILLS + 1 }, (_, index) =>
      skill(`skill-${index}`)),
  );
  assert.throws(() => registry.select(["missing"]), /Unknown node execution skill missing/u);
  assert.throws(
    () => registry.select(["skill-0", "skill-0"]),
    /must not contain duplicate IDs/u,
  );
  assert.throws(
    () => registry.select(
      Array.from({ length: MAX_NODE_EXECUTION_SKILLS + 1 }, (_, index) =>
        `skill-${index}`),
    ),
    new RegExp(`at most ${MAX_NODE_EXECUTION_SKILLS} skills`, "u"),
  );
});

test("node execution surfaces reject ambiguous skill and tool identities", () => {
  const duplicate = skill("duplicate");
  assert.throws(
    () => createNodeExecutionSurface({ skills: [duplicate, duplicate] }),
    /Node execution skill IDs must be unique: duplicate/u,
  );

  const tool = {
    id: "context.peek",
    version: "1",
    capability: "context.read",
    description: "Read a bounded projection from a context handle.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    effects: ["read"] as const,
  };
  assert.throws(
    () => createNodeExecutionSurface({ tools: [tool, tool] }),
    /Node execution surface tool IDs must be unique: context.peek/u,
  );
});
