import assert from "node:assert/strict";
import test from "node:test";

import { canonicalize, hashCanonical } from "../../src/core/canonical.ts";

const ownPrototypeMarker = (marker: string): Readonly<Record<string, unknown>> => {
  const value = {};
  Object.defineProperty(value, "__proto__", {
    value: { marker },
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return Object.freeze(value);
};

test("canonical JSON keeps own __proto__ data distinct without prototype pollution", () => {
  const empty = {};
  const markerA = ownPrototypeMarker("A");
  const markerB = ownPrototypeMarker("B");
  const objectPrototype = Object.getPrototypeOf(empty);

  assert.equal(canonicalize(empty), "{}");
  assert.equal(canonicalize(markerA), '{"__proto__":{"marker":"A"}}');
  assert.equal(canonicalize(markerB), '{"__proto__":{"marker":"B"}}');
  assert.equal(new Set([
    hashCanonical(empty),
    hashCanonical(markerA),
    hashCanonical(markerB),
  ]).size, 3);

  assert.strictEqual(Object.getPrototypeOf(empty), objectPrototype);
  assert.strictEqual(Object.getPrototypeOf(markerA), objectPrototype);
  assert.strictEqual(Object.getPrototypeOf(markerB), objectPrototype);
  assert.equal(Object.prototype.hasOwnProperty.call(objectPrototype, "marker"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(objectPrototype, "__proto__"), true);
});
