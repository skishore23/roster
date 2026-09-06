import assert from "node:assert/strict";
import test from "node:test";

import {
  compileRuntimeExtensionPlan,
  defineRuntimeService,
  type RuntimeExtensionDefinition,
} from "../../src/engine/runtime/runtime-extension.ts";
import { RuntimeExtensionHost } from "../../src/engine/runtime/runtime-extension-host.ts";

const DATABASE = defineRuntimeService<{ readonly query: () => string }>("storage.database", "1");
const REPOSITORY = defineRuntimeService<{ readonly read: () => string }>("storage.repository", "1");
const SEARCH = defineRuntimeService<{ readonly search: () => string }>("search.index", "1");

const databaseExtension = (
  version: string,
  value: string,
  events: string[] = [],
): RuntimeExtensionDefinition => ({
  id: "database",
  version,
  provides: [DATABASE],
  activate: ({ provide, scope }) => {
    events.push(`activate:database:${version}`);
    provide(DATABASE, { query: () => value });
    scope.defer(() => { events.push(`dispose:database:${version}`); });
  },
});

const repositoryExtension = (
  events: string[] = [],
): RuntimeExtensionDefinition => ({
  id: "repository",
  version: "1",
  requires: [DATABASE],
  provides: [REPOSITORY],
  activate: ({ get, provide, scope }) => {
    events.push("activate:repository");
    const database = get(DATABASE);
    provide(REPOSITORY, { read: () => `repo:${database.query()}` });
    scope.defer(() => { events.push("dispose:repository"); });
  },
});

test("runtime extension manifests are immutable, content-addressed, and order independent", () => {
  const left = compileRuntimeExtensionPlan([
    repositoryExtension(),
    databaseExtension("1", "left"),
  ]);
  const right = compileRuntimeExtensionPlan([
    databaseExtension("1", "different-process-value"),
    repositoryExtension(),
  ]);

  assert.equal(left.manifest.generationId, right.manifest.generationId);
  assert.deepEqual(left.activationOrder, ["database", "repository"]);
  assert.deepEqual(left.manifest.modules.map(({ id }) => id), ["database", "repository"]);
  assert.equal(Object.isFrozen(left.manifest), true);
  assert.equal(Object.isFrozen(left.manifest.modules), true);
  assert.equal(Object.isFrozen(left.manifest.modules[1]?.requires), true);
  assert.equal(JSON.stringify(left.manifest).includes("different-process-value"), false);
  assert.equal(JSON.stringify(left.manifest).includes("activate"), false);

  const artifactChanged = compileRuntimeExtensionPlan([{
    ...databaseExtension("1", "same-process-value"),
    artifactHash: "sha256:artifact-b",
    configurationHash: "sha256:config-a",
  }]);
  const artifactChangedAgain = compileRuntimeExtensionPlan([{
    ...databaseExtension("1", "same-process-value"),
    artifactHash: "sha256:artifact-c",
    configurationHash: "sha256:config-a",
  }]);
  assert.notEqual(
    artifactChanged.manifest.generationId,
    artifactChangedAgain.manifest.generationId,
  );
});

test("extension plans reject missing exact versions, duplicate providers, cycles, and exceeded bounds", () => {
  const databaseV2 = defineRuntimeService("storage.database", "2");
  assert.throws(() => compileRuntimeExtensionPlan([{
    id: "consumer",
    version: "1",
    requires: [databaseV2],
    activate: () => {},
  }]), /requires missing service storage.database@2/);

  assert.throws(() => compileRuntimeExtensionPlan([
    databaseExtension("1", "first"),
    {
      id: "other-database",
      version: "1",
      provides: [DATABASE],
      activate: ({ provide }) => provide(DATABASE, { query: () => "second" }),
    },
  ]), /provided by both database and other-database/);

  assert.throws(() => compileRuntimeExtensionPlan([
    databaseExtension("1", "first"),
    databaseExtension("2", "second"),
  ]), /Duplicate runtime extension database/);

  assert.throws(() => compileRuntimeExtensionPlan([
    databaseExtension("1", "provider"),
    {
      id: "duplicate-requirement",
      version: "1",
      requires: [DATABASE, DATABASE],
      activate: () => {},
    },
  ]), /requirements contains a duplicate exact service version/);

  const serviceA = defineRuntimeService("cycle.a", "1");
  const serviceB = defineRuntimeService("cycle.b", "1");
  assert.throws(() => compileRuntimeExtensionPlan([{
    id: "cycle-a",
    version: "1",
    requires: [serviceB],
    provides: [serviceA],
    activate: () => {},
  }, {
    id: "cycle-b",
    version: "1",
    requires: [serviceA],
    provides: [serviceB],
    activate: () => {},
  }]), /dependency cycle includes: cycle-a, cycle-b/);

  assert.throws(() => compileRuntimeExtensionPlan(
    [databaseExtension("1", "bounded"), repositoryExtension()],
    { maxModules: 1 },
  ), /module count exceeds maximum 1/);
  assert.throws(() => compileRuntimeExtensionPlan(
    [
      databaseExtension("1", "bounded"),
      repositoryExtension(),
      {
        id: "second-consumer",
        version: "1",
        requires: [DATABASE],
        activate: ({ get }) => { get(DATABASE); },
      },
    ],
    { maxDependencies: 1, maxRequiresPerModule: 1, maxProvidesPerModule: 1 },
  ), /dependency count exceeds maximum 1/);
});

test("reconciliation stages a full candidate before atomically committing it", async () => {
  const host = new RuntimeExtensionHost();
  await host.reconcile([databaseExtension("1", "old")]);
  const oldGeneration = host.generation();
  const oldView = host.view({ scopeId: "old", services: [DATABASE] });
  assert.equal(oldView.get(DATABASE).query(), "old");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = host.reconcile([{
    id: "database",
    version: "2",
    provides: [DATABASE],
    activate: async ({ provide }) => {
      await gate;
      provide(DATABASE, { query: () => "new" });
    },
  }, repositoryExtension()]);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(host.generation(), oldGeneration);
  assert.equal(host.view({ scopeId: "during" }).get(DATABASE).query(), "old");
  release();
  const result = await pending;

  assert.equal(result.changed, true);
  assert.deepEqual(result.activated, ["database", "repository"]);
  assert.notEqual(host.generation().generationId, oldGeneration.generationId);
  assert.equal(host.view({ scopeId: "after" }).get(REPOSITORY).read(), "repo:new");
  assert.throws(() => oldView.get(DATABASE), /stale committed generation/);
});

test("failed staging rolls back local effects and preserves the committed generation", async () => {
  const events: string[] = [];
  const host = new RuntimeExtensionHost();
  await host.reconcile([databaseExtension("1", "stable", events)]);
  const stable = host.generation();

  await assert.rejects(() => host.reconcile([{
    id: "database",
    version: "2",
    provides: [DATABASE],
    activate: ({ provide, scope }) => {
      events.push("activate:failing");
      scope.defer(() => { events.push("dispose:failing"); });
      provide(DATABASE, { query: () => "invalid" });
      throw new Error("activation failed");
    },
  }]), /activation failed/);

  assert.equal(host.generation(), stable);
  assert.equal(host.view({ scopeId: "stable" }).get(DATABASE).query(), "stable");
  assert.deepEqual(events, ["activate:database:1", "activate:failing", "dispose:failing"]);
});

test("withdrawal follows reverse dependency order", async () => {
  const events: string[] = [];
  const host = new RuntimeExtensionHost();
  const searchExtension: RuntimeExtensionDefinition = {
    id: "search",
    version: "1",
    requires: [REPOSITORY],
    provides: [SEARCH],
    activate: ({ get, provide, scope }) => {
      events.push("activate:search");
      const repository = get(REPOSITORY);
      provide(SEARCH, { search: () => repository.read() });
      scope.defer(() => { events.push("dispose:search"); });
    },
  };
  await host.reconcile([
    searchExtension,
    repositoryExtension(events),
    databaseExtension("1", "value", events),
  ]);
  const result = await host.close();

  assert.deepEqual(result.withdrawn, ["search", "repository", "database"]);
  assert.deepEqual(events.slice(-3), [
    "dispose:search",
    "dispose:repository",
    "dispose:database:1",
  ]);
  assert.deepEqual(host.view({ scopeId: "empty" }).services, []);
});

test("service views are generation-scoped and can only attenuate authority", async () => {
  const host = new RuntimeExtensionHost();
  await host.reconcile([databaseExtension("1", "visible"), repositoryExtension()]);

  const databaseOnly = host.view({ scopeId: "task", services: [DATABASE] });
  assert.equal(databaseOnly.has(DATABASE), true);
  assert.equal(databaseOnly.has(REPOSITORY), false);
  assert.throws(() => databaseOnly.get(REPOSITORY), /does not grant storage.repository@1/);

  const attemptedWidening = databaseOnly.attenuate({
    scopeId: "task/step",
    services: [DATABASE, REPOSITORY],
  });
  assert.deepEqual(attemptedWidening.services, [DATABASE]);
  assert.equal(attemptedWidening.get(DATABASE).query(), "visible");
  assert.throws(() => attemptedWidening.get(REPOSITORY), /does not grant storage.repository@1/);
});

test("reconciliation is deterministic and reloads transitive dependents on provider identity change", async () => {
  const events: string[] = [];
  const host = new RuntimeExtensionHost();
  const first = await host.reconcile([
    repositoryExtension(events),
    databaseExtension("1", "one", events),
  ]);
  const unchanged = await host.reconcile([
    databaseExtension("1", "ignored-new-closure", events),
    repositoryExtension(events),
  ]);
  assert.equal(first.changed, true);
  assert.equal(unchanged.changed, false);
  assert.deepEqual(events, ["activate:database:1", "activate:repository"]);

  const changed = await host.reconcile([
    repositoryExtension(events),
    databaseExtension("2", "two", events),
  ]);
  assert.deepEqual(changed.activated, ["database", "repository"]);
  assert.deepEqual(changed.withdrawn, ["repository", "database"]);
  assert.equal(host.view({ scopeId: "current" }).get(REPOSITORY).read(), "repo:two");
  assert.deepEqual(events, [
    "activate:database:1",
    "activate:repository",
    "activate:database:2",
    "activate:repository",
    "dispose:repository",
    "dispose:database:1",
  ]);
});
