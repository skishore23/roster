import assert from "node:assert/strict";
import test from "node:test";

import { resolveRuntimeLimits } from "../../src/engine/runtime/limits.js";
import { parseFormNum } from "../../src/engine/runtime/workflow.js";

test("runtime capacity separates automatic defaults, global ceilings, and per-run overrides", () => {
  const env = {
    ROSTER_DEFAULT_MAX_PARALLEL: "6",
    ROSTER_MAX_PARALLEL: "20",
    ROSTER_MAX_NODES: "200",
  };

  assert.deepEqual(resolveRuntimeLimits({}, env), { maxNodes: 200, maxParallel: 6 });
  assert.deepEqual(resolveRuntimeLimits({ maxParallel: 12 }, env), { maxNodes: 200, maxParallel: 12 });
  assert.deepEqual(resolveRuntimeLimits({ maxParallel: 50, maxNodes: 500 }, env), {
    maxNodes: 200,
    maxParallel: 20,
  });
});

test("blank capacity form values select automatic runtime policy", () => {
  assert.equal(parseFormNum(undefined), undefined);
  assert.equal(parseFormNum(""), undefined);
  assert.equal(parseFormNum("   "), undefined);
  assert.equal(parseFormNum("8"), 8);
});
