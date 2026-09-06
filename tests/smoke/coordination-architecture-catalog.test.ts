import assert from "node:assert/strict";
import test from "node:test";

import {
  coordinationAgentDefinitions,
  coordinationArchitectures,
  coordinationExamples,
  createCoordinationArchitectureRegistry,
  examplesForArchitecture,
  getCoordinationAgentDefinition,
  getCoordinationArchitecture,
  type CoordinationArchitectureExtension,
} from "../../src/engine/orchestration/architecture-catalog.ts";
import {
  getAgentArchitecture,
  getAgentDisplayName,
  getCommandRunAgentSpec,
} from "../../src/agents/agent-display.ts";
import { architectureCatalogHtml } from "../../src/views/monitor.ts";
import { pageMenuHtml } from "../../src/views/page-menu.ts";

test("coordination examples are typed extensions of five reusable architectures", () => {
  assert.deepEqual(coordinationArchitectures().map((definition) => definition.id), [
    "tool-loop",
    "adaptive-graph",
    "parallel-fanout",
    "staged-dag",
    "visual-dag",
  ]);
  assert.ok(coordinationArchitectures().every((definition) => definition.artifactProtocol === "shared-crdt"));
  assert.deepEqual(coordinationExamples().map((definition) => definition.agentId), [
    "theorem",
    "axiom-roster",
    "coding-agent",
    "axiom-simple",
    "writer",
    "canvas",
  ]);
  assert.equal(getCoordinationAgentDefinition("theorem")?.architectureId, "adaptive-graph");
  assert.equal(getCoordinationAgentDefinition("axiom-roster")?.architectureId, "adaptive-graph");
  assert.equal(getCoordinationAgentDefinition("coding-agent")?.architectureId, "adaptive-graph");
  assert.ok(getCoordinationAgentDefinition("axiom-roster")?.extensions.includes("formal-evidence-required"));
  assert.equal(getCoordinationArchitecture("visual-dag").runtimeAdapter, "distributed-control");
  assert.equal(examplesForArchitecture("tool-loop").length, 0, "tool-loop agents are primitives rather than standalone examples");
});

test("display, navigation, and dispatch resolve through the central catalog", () => {
  assert.equal(getAgentDisplayName("canvas"), "Canvas Roster");
  assert.equal(getAgentArchitecture("writer")?.id, "staged-dag");
  assert.deepEqual(getCommandRunAgentSpec("theorem"), {
    kind: "theorem.run",
    defaultStream: "agents/theorem",
    routePath: "/theorem",
  });
  const menu = pageMenuHtml("adaptive");
  assert.match(menu, /id="page-menu-group-0">Rooms<\/h2>/);
  for (const example of coordinationExamples()) {
    assert.match(menu, new RegExp(example.name));
    assert.match(menu, new RegExp(example.roomName?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "#"));
    assert.match(menu, new RegExp(example.routePath ?? "never"));
  }
});

test("Roster lobby presents application rooms by architecture type", () => {
  const html = architectureCatalogHtml();
  assert.match(html, /id="architecture-catalog-title"/);
  assert.match(html, /data-architecture="adaptive-graph"/);
  assert.match(html, /Adaptive Proof/);
  assert.match(html, /Verified Proof/);
  assert.match(html, /formal evidence/i);
  assert.match(html, /Distributed Visual Frontier/);
  assert.match(html, /href="\/canvas"/);
  assert.match(html, /aria-label="Distributed Visual Frontier rooms"/);
  assert.match(html, /#canvas-studio/);
  assert.match(html, /Open room/);
});

test("extension registry rejects duplicate and cross-wired modules", () => {
  const baseArchitecture = coordinationArchitectures()[0];
  const baseAgent = coordinationAgentDefinitions()[0];
  assert.ok(baseArchitecture && baseAgent);
  const duplicate: ReadonlyArray<CoordinationArchitectureExtension> = [
    { architecture: baseArchitecture, agents: [] },
    { architecture: baseArchitecture, agents: [] },
  ];
  assert.throws(() => createCoordinationArchitectureRegistry(duplicate), /IDs must be unique/);
  assert.throws(() => createCoordinationArchitectureRegistry([{
    architecture: baseArchitecture,
    agents: [{ ...baseAgent, architectureId: "visual-dag" }],
  }]), /must use its extension architecture/);
});

test("package-owned coordination architectures register without core edits", () => {
  const registry = createCoordinationArchitectureRegistry([{
    architecture: {
      id: "expert-roster",
      name: "Expert Roster",
      summary: "A package-owned bounded expert architecture.",
      runtimeAdapter: "acme-expert-runtime",
      topology: "planned",
      population: "Planner-selected experts within declared limits.",
      composition: "Evidence-backed synthesis.",
      artifactProtocol: "shared-crdt",
      acceptance: "Independent review and certification.",
      suitedFor: ["Deep research"],
    },
    agents: [],
  }]);

  assert.equal(registry.architecture("expert-roster").runtimeAdapter, "acme-expert-runtime");
});
