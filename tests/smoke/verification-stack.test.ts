import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("isolated verification does not lock the live SpacetimeDB data directory", async () => {
  const source = await readFile(new URL("../../scripts/verify-with-spacetimedb.mjs", import.meta.url), "utf8");

  assert.match(source, /const dataDirectory = path\.join\(tempDirectory, "spacetime-data"\)/);
  assert.match(source, /"--data-dir", dataDirectory/);
  assert.match(source, /"--listen-addr", `127\.0\.0\.1:\$\{port\}`/);
  assert.match(source, /"--in-memory"/);
});
