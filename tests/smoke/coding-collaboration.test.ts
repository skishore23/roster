import assert from "node:assert/strict";
import test from "node:test";

import {
  CODING_COLLABORATION_RESOLUTION_OUTPUT,
  codingCollaborationContributions,
  codingCollaborationEndorsementOutputKey,
  codingCollaborationResponseOutputKey,
  codingPeerResolutionSchema,
  codingResolutionCoverage,
  codingCollaborationStatus,
  parseCodingPeerProposal,
  resolveCodingPeerAmbiguityWithHumanAnswer,
} from "../../src/domains/coding-collaboration.ts";

test("peer proposal prose is normalized without weakening semantic control fields", () => {
  const parsed = parseCodingPeerProposal(JSON.stringify({
    status: "proposal",
    summary: "s".repeat(1_400),
    recommendations: [{
      subjectId: "public-contract",
      recommendation: "r".repeat(1_800),
      rationale: "why ".repeat(500),
      evidence: ["e".repeat(700)],
      confidence: 0.9,
    }],
    questions: ["q".repeat(900)],
  }));

  assert.equal(parsed?.summary.length, 1_200);
  assert.equal(parsed?.recommendations[0]?.recommendation.length, 1_600);
  assert.equal(parsed?.recommendations[0]?.rationale.length, 1_600);
  assert.equal(parsed?.recommendations[0]?.evidence[0]?.length, 500);
  assert.equal(parsed?.questions[0]?.length, 600);
  assert.equal(parseCodingPeerProposal(JSON.stringify({
    status: "proposal",
    summary: "Proposal",
    recommendations: [{
      subjectId: "public-contract",
      recommendation: "Keep the contract",
      rationale: "Compatibility",
      evidence: [],
      confidence: 0.9,
      inventedControl: true,
    }],
    questions: [],
  })), undefined, "unknown control fields must remain invalid");
});

test("certification diagnostics are normalized without losing the endorsed frontier", () => {
  const outputKey = codingCollaborationEndorsementOutputKey("workspace-runtime-87a53521");
  const contributions = codingCollaborationContributions({
    outputKey,
    value: JSON.stringify({
      verdict: "approve",
      frontierHash: "a".repeat(64),
      summary: "s".repeat(1_600),
      evidence: [
        { subject: "frontier", detail: "The exact task delta was reviewed." },
        ...Array.from({ length: 15 }, (_, index) => `${index}: ${"e".repeat(600)}`),
      ],
    }),
    nodeId: "workspace.runtime",
    taskId: "certify-workspace-runtime-87a53521",
  });

  assert.equal(contributions.length, 1);
  assert.equal(contributions[0]?.entry.mode, "append");
  assert.equal(contributions[0]?.entry.references.length, 12);
  assert.ok(contributions[0]?.entry.references.every((reference) => reference.length <= 500));
  assert.match(contributions[0]?.entry.references[0] ?? "", /"subject":"frontier"/);
  assert.equal((contributions[0]?.entry.body as { readonly frontierHash?: string }).frontierHash, "a".repeat(64));
});

test("certification accepts bounded keyed diagnostic evidence from provider output", () => {
  const contributions = codingCollaborationContributions({
    outputKey: codingCollaborationEndorsementOutputKey("workspace-documentation"),
    value: JSON.stringify({
      verdict: "approve",
      frontierHash: "b".repeat(64),
      summary: "The exact remediated frontier is acceptable.",
      evidence: {
        delta: ["Only the requested source and test changed."],
        repositoryValidation: "The authoritative validation report passed.",
        staging: "The staged frontier matches the reported hash.",
      },
    }),
    nodeId: "workspace.documentation",
    taskId: "certify-workspace-documentation",
  });

  assert.equal(contributions.length, 1);
  assert.equal(contributions[0]?.entry.references.length, 3);
  assert.match(contributions[0]?.entry.references[0] ?? "", /"delta"/);
  assert.match(contributions[0]?.entry.references[1] ?? "", /"repositoryValidation"/);
});

test("collaboration status exposes ambiguity instead of reporting false progress", () => {
  const ambiguous = JSON.stringify({
    status: "ambiguous",
    summary: "The repository does not establish the migration policy.",
    decisions: [],
    unresolved: [{
      subjectId: "migration-policy",
      reason: "Both paths are repository-compatible.",
      candidateSummaries: ["backfill", "dual write"],
    }],
  });
  assert.deepEqual(codingCollaborationStatus({
    outputs: { [CODING_COLLABORATION_RESOLUTION_OUTPUT]: ambiguous },
    taskStatuses: { "resolve-collaboration": "completed" },
    peerCount: 4,
    certified: false,
  }), {
    phase: "conflicted",
    proposalCount: 0,
    responseCount: 0,
    endorsementCount: 0,
    peerCount: 4,
    conflictCount: 1,
    resolutionStatus: "ambiguous",
    summary: "The repository does not establish the migration policy.",
  });
});

test("a human answer converts the exact ambiguous subjects into a complete frontier", () => {
  const resolved = resolveCodingPeerAmbiguityWithHumanAnswer(codingPeerResolutionSchema.parse({
    status: "ambiguous",
    summary: "Peers agree on mechanics but need one product choice.",
    decisions: [{
      subjectId: "implementation-approach",
      resolution: "Use semantic tokens",
      rationale: "The repository already exposes them.",
      evidence: ["src/views/agent-shell.ts"],
    }],
    unresolved: [{
      subjectId: "public-contract",
      reason: "Control placement is a product choice.",
      candidateSummaries: ["primary pages", "every page"],
    }],
  }), "Keep the selector in primary chrome; secondary pages apply the saved preference.");

  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.unresolved, []);
  assert.deepEqual(resolved.decisions.map((decision) => decision.subjectId), [
    "implementation-approach",
    "public-contract",
  ]);
  assert.match(resolved.decisions[1]?.resolution ?? "", /primary chrome/);
  assert.match(resolved.decisions[1]?.rationale ?? "", /human participant/i);
});

test("temporary resolution requires unique, internally consistent semantic subjects", () => {
  const duplicate = codingPeerResolutionSchema.safeParse({
    status: "resolved",
    summary: "The repository establishes one contract.",
    decisions: [
      { subjectId: "public-contract", resolution: "Keep v1", rationale: "Compatibility", evidence: [] },
      { subjectId: "public-contract", resolution: "Keep v1", rationale: "Compatibility", evidence: [] },
    ],
    unresolved: [],
  });
  assert.equal(duplicate.success, false);

  const contradictory = codingPeerResolutionSchema.safeParse({
    status: "resolved",
    summary: "One subject remains uncertain.",
    decisions: [],
    unresolved: [{
      subjectId: "migration-policy",
      reason: "No repository policy exists.",
      candidateSummaries: ["backfill", "dual write"],
    }],
  });
  assert.equal(contradictory.success, false);
});

test("resolution coverage uses exact CRDT conflict subject ids", () => {
  const resolution = codingPeerResolutionSchema.parse({
    status: "resolved",
    summary: "Repository evidence resolves one of two subjects.",
    decisions: [{
      subjectId: "public-contract",
      resolution: "Keep v1 compatible",
      rationale: "The compatibility policy is explicit.",
      evidence: ["docs/api.md"],
    }],
    unresolved: [],
  });
  assert.deepEqual(codingResolutionCoverage(resolution, [
    {
      conflictId: "conflict-public",
      kind: "exclusive-value-conflict",
      subjectId: "decision:public-contract",
      candidateUpdateIds: ["update-a", "update-b"],
      candidateHashes: ["hash-a", "hash-b"],
    },
    {
      conflictId: "conflict-delivery",
      kind: "exclusive-value-conflict",
      subjectId: "decision:delivery",
      candidateUpdateIds: ["update-c", "update-d"],
      candidateHashes: ["hash-c", "hash-d"],
    },
  ]), {
    conflictSubjectIds: ["delivery", "public-contract"],
    missingSubjectIds: ["delivery"],
  });

  const ambiguous = codingPeerResolutionSchema.parse({
    status: "ambiguous",
    summary: "The public contract needs human intent.",
    decisions: [],
    unresolved: [{
      subjectId: "public-contract",
      reason: "Both contracts are compatible.",
      candidateSummaries: ["attachment", "inline"],
    }],
  });
  assert.deepEqual(codingResolutionCoverage(ambiguous, [{
    conflictId: "conflict-public",
    kind: "exclusive-value-conflict",
    subjectId: "decision:public-contract",
    candidateUpdateIds: ["update-a", "update-b"],
    candidateHashes: ["hash-a", "hash-b"],
  }]).missingSubjectIds, []);
});

test("dependency-routed peer responses remain append-only collaboration evidence", () => {
  const outputKey = codingCollaborationResponseOutputKey("workspace-api-a1b2c3d4");
  const value = JSON.stringify({
    status: "response",
    summary: "The API boundary answers the UI peer's question.",
    answers: [{
      subjectId: "public-contract",
      response: "Keep the existing authenticated route.",
      rationale: "The API middleware already owns this boundary.",
      evidence: ["src/server.ts"],
      confidence: 0.9,
    }],
    openQuestions: [],
  });
  const contributions = codingCollaborationContributions({
    outputKey,
    value,
    nodeId: "workspace.api",
    taskId: "respond-workspace-api-a1b2c3d4",
  });
  assert.equal(contributions.length, 2);
  assert.ok(contributions.every((contribution) => contribution.entry.mode === "append"));
  assert.deepEqual(codingCollaborationStatus({
    outputs: { [outputKey]: value },
    taskStatuses: { "respond-workspace-api-a1b2c3d4": "running" },
    peerCount: 3,
    certified: false,
  }), {
    phase: "discussing",
    proposalCount: 0,
    responseCount: 1,
    endorsementCount: 0,
    peerCount: 3,
    conflictCount: 0,
  });
});
