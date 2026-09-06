import assert from "node:assert/strict";
import test from "node:test";

import {
  CODING_AGENT_TURN_HARD_POLICY,
  clampCodingAgentTurnPolicy,
  codingAgentTurnTags,
  codingAgentTurnSchema,
  createCodingAgentTurn,
  planCodingAgentTurns,
  type CodingAgentTurn,
  type CodingAgentTurnPolicy,
} from "../../src/domains/coding-agent-turn.ts";
import {
  codingControlDeliveriesFromEvents,
  codingControlDeliveryAttemptsFromEvents,
  codingControlDeliveryEvent,
  createCodingControlIngressAuthorization,
  pendingCodingControlMessages,
} from "../../src/domains/coding-control-ingress.ts";
import { createCodingConversationMessage } from "../../src/domains/coding-conversation.ts";
import type { CodingWorkspaceDependency } from "../../src/domains/coding-workspace.ts";
import type { WorkspaceNode } from "../../src/engine/orchestration/types.ts";

const AUTHOR = "workspace.implementation";
const QUALITY = "workspace.quality";

test("agent turns expose canonical descriptive tags without encoding node authority", () => {
  const turn = createCodingAgentTurn({
    kind: "question",
    authorNodeId: AUTHOR,
    recipients: [QUALITY],
    subjectId: "schema-boundary",
    originatingTaskId: "implement",
    responseRequirement: "all",
    body: "Does this preserve the public schema?",
    evidence: ["src/domains/coding-agent-turn.ts"],
  });

  assert.deepEqual(codingAgentTurnTags(turn), [
    "protocol:agent-turn",
    "turn:question",
    "routing:node",
    "response:all",
    "content:evidence",
  ]);
  assert.ok(!codingAgentTurnTags(turn).some((tag) =>
    tag.includes(AUTHOR) || tag.includes(QUALITY)));
});
const QUALITY_B = "workspace.quality-b";
const DOCS = "workspace.documentation";
const SECURITY = "workspace.security";
const TASK = "implement";
const HUMAN = "human.operator";

const nodes: ReadonlyArray<WorkspaceNode> = [
  { id: AUTHOR, name: "Kai", capabilities: ["implement", "respond"] },
  { id: QUALITY, name: "Mira", capabilities: ["review", "respond"] },
  { id: QUALITY_B, name: "Mira B", capabilities: ["review", "respond"] },
  { id: DOCS, name: "Nia", capabilities: ["review"] },
  { id: SECURITY, name: "Zara", capabilities: ["review", "respond"] },
  {
    id: HUMAN,
    name: "You, Workspace Participant",
    capabilities: ["clarify"],
    metadata: { participantKind: "human" },
  },
];

const dependencies: ReadonlyArray<CodingWorkspaceDependency> = [
  { nodeId: AUTHOR, dependsOnNodeId: QUALITY, reason: "Quality review is upstream of mutation." },
  { nodeId: AUTHOR, dependsOnNodeId: QUALITY_B, reason: "A second quality peer is also upstream of mutation." },
  { nodeId: AUTHOR, dependsOnNodeId: DOCS, reason: "Docs peer provides missing context." },
];

const openPolicy: CodingAgentTurnPolicy = clampCodingAgentTurnPolicy({
  maxNodes: 8, maxTasks: 16, maxParallel: 4, maxDepth: 4,
});

const question = (overrides: Partial<Parameters<typeof createCodingAgentTurn>[0]> = {}) => createCodingAgentTurn({
  kind: "question",
  authorNodeId: AUTHOR,
  recipients: [QUALITY],
  subjectId: "delivery-contract",
  originatingTaskId: TASK,
  responseRequirement: "any",
  body: "Should delivery remain in-session or use a signed URL?",
  ...overrides,
});

test("turnId is content-derived and converges across field reordering while diverging on content", () => {
  const a = question();
  const b = createCodingAgentTurn({
    kind: "question",
    authorNodeId: AUTHOR,
    recipients: [QUALITY], // same single recipient, reordering is moot with one entry
    subjectId: "delivery-contract",
    originatingTaskId: TASK,
    responseRequirement: "any",
    body: "Should delivery remain in-session or use a signed URL?",
  });
  assert.equal(a.turnId, b.turnId, "identical semantic content must converge on one turnId");

  const reorderedRecipients = createCodingAgentTurn({
    kind: "question",
    authorNodeId: AUTHOR,
    recipients: [DOCS, QUALITY],
    subjectId: "delivery-contract",
    originatingTaskId: TASK,
    responseRequirement: "all",
    body: "Should delivery remain in-session or use a signed URL?",
  });
  const sameRecipientsDifferentOrder = createCodingAgentTurn({
    kind: "question",
    authorNodeId: AUTHOR,
    recipients: [QUALITY, DOCS],
    subjectId: "delivery-contract",
    originatingTaskId: TASK,
    responseRequirement: "all",
    body: "Should delivery remain in-session or use a signed URL?",
  });
  assert.equal(reorderedRecipients.turnId, sameRecipientsDifferentOrder.turnId, "recipient order must not affect identity");
  assert.deepEqual(reorderedRecipients.recipients, [DOCS, QUALITY], "recipients are normalized to sorted order");

  const differentBody = question({ body: "A materially different question." });
  assert.notEqual(a.turnId, differentBody.turnId, "different content must diverge");
});

test("recipients per turn are capped at the hard ceiling regardless of caller policy", () => {
  assert.throws(() => createCodingAgentTurn({
    kind: "question",
    authorNodeId: AUTHOR,
    recipients: [QUALITY, DOCS, SECURITY, "workspace.extra"],
    subjectId: "s",
    originatingTaskId: TASK,
    responseRequirement: "all",
    body: "Too many recipients.",
  }));
  assert.throws(() => createCodingAgentTurn({
    kind: "question",
    authorNodeId: AUTHOR,
    recipients: [AUTHOR],
    subjectId: "s",
    originatingTaskId: TASK,
    responseRequirement: "none",
    body: "Self-addressed.",
  }), /author cannot address itself/);
});

test("caller may lower a hard ceiling but never raise it", () => {
  const lowered = clampCodingAgentTurnPolicy(
    { maxNodes: 8, maxTasks: 16, maxParallel: 4, maxDepth: 4 },
    { recipientsPerTurn: 1, turnsPerOriginatingTask: 2 },
  );
  assert.equal(lowered.recipientsPerTurn, 1);
  assert.equal(lowered.turnsPerOriginatingTask, 2);

  const attemptedRaise = clampCodingAgentTurnPolicy(
    { maxNodes: 8, maxTasks: 16, maxParallel: 4, maxDepth: 4 },
    { recipientsPerTurn: 99, followUpRounds: 99 },
  );
  assert.equal(attemptedRaise.recipientsPerTurn, CODING_AGENT_TURN_HARD_POLICY.recipientsPerTurn);
  assert.equal(attemptedRaise.followUpRounds, CODING_AGENT_TURN_HARD_POLICY.followUpRounds);

  const malformedOverride = clampCodingAgentTurnPolicy(
    { maxNodes: 8, maxTasks: 16, maxParallel: 4, maxDepth: 4 },
    { recipientsPerTurn: -1 },
  );
  assert.equal(malformedOverride.recipientsPerTurn, 0, "invalid explicit bounds fail closed");

  const budgetConstrained = clampCodingAgentTurnPolicy({ maxNodes: 2, maxTasks: 1, maxParallel: 1, maxDepth: 0 });
  assert.equal(budgetConstrained.recipientsPerTurn, 1);
  assert.equal(budgetConstrained.turnsPerOriginatingTask, 1);
  assert.equal(budgetConstrained.followUpRounds, 0);
});

test("sparse dependency routing accepts a connected peer and rejects an unconnected one", () => {
  const toQuality = question();
  const toSecurity = question({ recipients: [SECURITY] });
  const plan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [toQuality, toSecurity],
  });
  assert.deepEqual(plan.acceptedTurnIds, [toQuality.turnId]);
  assert.deepEqual(plan.rejected, [{ turnId: toSecurity.turnId, reason: "invalid-recipient" }]);
  // A turn naming both a connected and an unconnected recipient never partially routes.
  const mixed = question({ recipients: [QUALITY, SECURITY], responseRequirement: "all" });
  const mixedPlan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [mixed],
  });
  assert.deepEqual(mixedPlan.acceptedTurnIds, []);
  assert.equal(mixedPlan.rejected[0]?.reason, "invalid-recipient");
});

test("a fresh turn against the reverse of a saved edge is rejected, but the reply direction is allowed", () => {
  // Only the edge {nodeId: AUTHOR, dependsOnNodeId: QUALITY} exists: AUTHOR may ask QUALITY, but
  // QUALITY may not open a fresh (non-reply) turn to AUTHOR over that same edge.
  const reversedFreshTurn = createCodingAgentTurn({
    kind: "question",
    authorNodeId: QUALITY,
    recipients: [AUTHOR],
    subjectId: "reverse-routing",
    originatingTaskId: TASK,
    responseRequirement: "none",
    body: "QUALITY should not be able to open a fresh turn against the reverse of its edge.",
  });
  const reversedPlan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [reversedFreshTurn],
  });
  assert.deepEqual(reversedPlan.acceptedTurnIds, []);
  assert.equal(reversedPlan.rejected[0]?.reason, "invalid-recipient");

  // A genuine reply along the reverse of the same edge remains valid.
  const forward = question({ subjectId: "reverse-routing" });
  const reply = createCodingAgentTurn({
    kind: "answer",
    authorNodeId: QUALITY,
    recipients: [AUTHOR],
    subjectId: "reverse-routing",
    replyToTurnId: forward.turnId,
    originatingTaskId: TASK,
    responseRequirement: "none",
    body: "The reply direction is the reverse of the forward edge and remains valid.",
  });
  const replyPlan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [forward, reply],
  });
  assert.deepEqual(replyPlan.acceptedTurnIds.sort(), [forward.turnId, reply.turnId].sort());
});

test("a reply cannot settle another peer's obligation by addressing a different connected peer", () => {
  const dependenciesWithQualityChain: ReadonlyArray<CodingWorkspaceDependency> = [
    ...dependencies,
    { nodeId: QUALITY_B, dependsOnNodeId: QUALITY, reason: "QUALITY_B may also route through QUALITY." },
  ];
  const initial = question({ subjectId: "misdirected", responseRequirement: "any" });
  const misdirectedReply = createCodingAgentTurn({
    kind: "answer",
    authorNodeId: QUALITY,
    recipients: [QUALITY_B], // addresses QUALITY_B instead of the obligated recipient, AUTHOR
    subjectId: "misdirected",
    replyToTurnId: initial.turnId,
    originatingTaskId: TASK,
    responseRequirement: "none",
    body: "This reply is routed to the wrong peer and must not settle AUTHOR's obligation.",
  });
  const plan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies: dependenciesWithQualityChain,
    policy: openPolicy, turns: [initial, misdirectedReply],
  });
  assert.deepEqual(plan.acceptedTurnIds, [initial.turnId]);
  assert.deepEqual(plan.rejected, [{ turnId: misdirectedReply.turnId, reason: "stale-reply" }]);
  assert.equal(plan.unresolvedObligations.length, 1, "AUTHOR's obligation remains unresolved");
  assert.equal(plan.settledObligations.length, 0);
});

test("a forged or corrupted turnId is rejected at the schema boundary", () => {
  const original = question();
  const forged = { ...original, body: "A materially different body than what turnId was derived from." };
  const result = codingAgentTurnSchema.safeParse(forged);
  assert.equal(result.success, false, "content must not diverge from its declared turnId");
});

test("evidence references are canonical: reordering converges, post-truncation duplicates collapse", () => {
  const reordered = question({ evidence: ["b-reference", "a-reference"] });
  const sameReordered = question({ evidence: ["a-reference", "b-reference"] });
  assert.equal(reordered.turnId, sameReordered.turnId, "evidence order must not affect identity");
  assert.deepEqual(reordered.evidence, ["a-reference", "b-reference"]);

  const longPrefix = "x".repeat(500);
  const collidingAfterTruncation = question({
    evidence: [`${longPrefix}-one`, `${longPrefix}-two`],
  });
  assert.deepEqual(
    collidingAfterTruncation.evidence,
    [longPrefix],
    "two references identical after 500-character truncation collapse to one canonical entry",
  );
});

test("any selects one deterministic peer; all requires every named peer to respond", () => {
  const any = question({ recipients: [QUALITY, QUALITY_B], responseRequirement: "any" });
  const anyPlan = planCodingAgentTurns({ originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [any] });
  assert.equal(anyPlan.unresolvedObligations.length, 1);
  assert.equal(anyPlan.unresolvedObligations[0]?.recipientNodeId, QUALITY, "lexicographically smallest eligible recipient wins");

  const all = question({ recipients: [QUALITY, DOCS], responseRequirement: "all" });
  const allPlan = planCodingAgentTurns({ originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [all] });
  assert.equal(allPlan.unresolvedObligations.length, 0, "all never silently drops an incapable recipient");
  assert.equal(allPlan.responseTasks.length, 0);
  assert.equal(allPlan.humanEscalation?.reason, "no-eligible-peer");

  const none = question({ responseRequirement: "none" });
  const nonePlan = planCodingAgentTurns({ originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [none] });
  assert.equal(nonePlan.unresolvedObligations.length, 0);
  assert.equal(nonePlan.responseTasks.length, 0);
});

test("reordered and duplicated turn delivery converges on an identical projection", () => {
  const initial = question();
  const answer = createCodingAgentTurn({
    kind: "answer",
    authorNodeId: QUALITY,
    recipients: [AUTHOR],
    subjectId: "delivery-contract",
    replyToTurnId: initial.turnId,
    originatingTaskId: TASK,
    responseRequirement: "none",
    body: "Use the existing authenticated route.",
  });
  const forward = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [initial, answer],
  });
  const reorderedDuplicated = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy,
    turns: [answer, initial, answer, initial, answer],
  });
  assert.deepEqual(forward, reorderedDuplicated, "delivery order and duplication must not change the projection");
});

test("a caller-lowered fanout ceiling rejects a turn that the hard ceiling alone would allow", () => {
  const belowHardCeiling = clampCodingAgentTurnPolicy(
    { maxNodes: 8, maxTasks: 16, maxParallel: 4, maxDepth: 4 },
    { recipientsPerTurn: 1 },
  );
  const twoRecipients = question({ recipients: [QUALITY, QUALITY_B], responseRequirement: "all" });
  const plan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: belowHardCeiling, turns: [twoRecipients],
  });
  assert.deepEqual(plan.acceptedTurnIds, []);
  assert.equal(plan.rejected[0]?.reason, "excess-fanout");
  // The turn required a response and was dropped purely by a bound, not by malformed content, so
  // the plan must not silently report full settlement and a continuation for it.
  assert.equal(plan.continuationId, undefined);
  assert.equal(plan.humanEscalation?.reason, "bounded-path-exhausted");
});

test("a bound-rejected turn that required no response does not trigger escalation", () => {
  const belowHardCeiling = clampCodingAgentTurnPolicy(
    { maxNodes: 8, maxTasks: 16, maxParallel: 4, maxDepth: 4 },
    { recipientsPerTurn: 1 },
  );
  const twoRecipients = question({ recipients: [QUALITY, QUALITY_B], responseRequirement: "none" });
  const plan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: belowHardCeiling, turns: [twoRecipients],
  });
  assert.deepEqual(plan.acceptedTurnIds, []);
  assert.equal(plan.rejected[0]?.reason, "excess-fanout");
  assert.equal(plan.humanEscalation, undefined);
});

test("a caller-lowered zero turns-per-task ceiling escalates instead of fabricating a continuation", () => {
  const zeroTurnCeiling = clampCodingAgentTurnPolicy(
    { maxNodes: 8, maxTasks: 16, maxParallel: 4, maxDepth: 4 },
    { turnsPerOriginatingTask: 0 },
  );
  const required = question({ responseRequirement: "any" });
  const plan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: zeroTurnCeiling, turns: [required],
  });
  assert.deepEqual(plan.acceptedTurnIds, []);
  assert.deepEqual(plan.rejected, [{ turnId: required.turnId, reason: "turns-per-task-exceeded" }]);
  assert.equal(plan.continuationId, undefined);
  assert.equal(plan.humanEscalation?.reason, "bounded-path-exhausted");
});

test("the planner clamps a policy passed directly, bypassing clampCodingAgentTurnPolicy", () => {
  const forgedPolicy: CodingAgentTurnPolicy = {
    recipientsPerTurn: 99,
    turnsPerOriginatingTask: 99,
    followUpRounds: 99,
    generatedResponseTasks: 99,
    unresolvedObligations: 99,
  };
  const overCeilingTurns = Array.from({ length: 13 }, (_, index) => question({
    subjectId: `bulk-${index}`, responseRequirement: "none",
  }));
  const plan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: forgedPolicy, turns: overCeilingTurns,
  });
  assert.equal(plan.acceptedTurnIds.length, CODING_AGENT_TURN_HARD_POLICY.turnsPerOriginatingTask);
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.rejected[0]?.reason, "turns-per-task-exceeded");

  const respondingTurns = Array.from({ length: 8 }, (_, index) => question({
    subjectId: `respond-${index}`, responseRequirement: "any",
  }));
  const responsePlan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: forgedPolicy, turns: respondingTurns,
  });
  assert.equal(responsePlan.responseTasks.length, CODING_AGENT_TURN_HARD_POLICY.generatedResponseTasks);
  assert.equal(responsePlan.humanEscalation?.reason, "bounded-path-exhausted");
});

test("bounds reject excess turns and excess follow-up rounds", () => {
  const boundedPolicy = clampCodingAgentTurnPolicy(
    { maxNodes: 8, maxTasks: 16, maxParallel: 4, maxDepth: 4 },
    { turnsPerOriginatingTask: 2 },
  );
  const overTurns = [
    question({ subjectId: "s1", responseRequirement: "none" }),
    question({ subjectId: "s2", responseRequirement: "none" }),
    question({ subjectId: "s3", responseRequirement: "none" }),
  ];
  const turnsPlan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: boundedPolicy, turns: overTurns,
  });
  assert.equal(turnsPlan.acceptedTurnIds.length, 2);
  assert.equal(turnsPlan.rejected.length, 1);
  assert.equal(turnsPlan.rejected[0]?.reason, "turns-per-task-exceeded");

  const round0 = question({ subjectId: "chain", responseRequirement: "any" });
  const round1 = createCodingAgentTurn({
    kind: "answer", authorNodeId: QUALITY, recipients: [AUTHOR], subjectId: "chain",
    replyToTurnId: round0.turnId, originatingTaskId: TASK, responseRequirement: "any", body: "Follow-up one.",
  });
  const round2 = createCodingAgentTurn({
    kind: "objection", authorNodeId: AUTHOR, recipients: [QUALITY], subjectId: "chain",
    replyToTurnId: round1.turnId, originatingTaskId: TASK, responseRequirement: "any", body: "Follow-up two.",
  });
  const round3 = createCodingAgentTurn({
    kind: "answer", authorNodeId: QUALITY, recipients: [AUTHOR], subjectId: "chain",
    replyToTurnId: round2.turnId, originatingTaskId: TASK, responseRequirement: "none", body: "Follow-up three.",
  });
  const chainPlan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [round0, round1, round2, round3],
  });
  assert.deepEqual(chainPlan.acceptedTurnIds.sort(), [round0.turnId, round1.turnId, round2.turnId].sort());
  assert.equal(chainPlan.rejected.length, 1);
  assert.equal(chainPlan.rejected[0]?.turnId, round3.turnId);
  assert.equal(chainPlan.rejected[0]?.reason, "exceeds-follow-up-rounds");
});

test("a reply cycle is rejected without infinite recursion", () => {
  // A genuine two-turn replyToTurnId cycle can never have self-consistent content-derived IDs
  // (A's hash depends on B's turnId and vice versa), so content-hash validation makes it
  // impossible to construct one through the public schema. Build typed fixtures directly to
  // exercise the planner's own cycle defense, matching the trust boundary planCodingAgentTurns
  // already assumes for its `turns` input (pre-validated CodingAgentTurn values).
  const shared = {
    schema: "coding-agent-turn/v1" as const,
    subjectId: "cycle",
    originatingTaskId: TASK,
    responseRequirement: "none" as const,
    body: "Cycle probe body.",
    evidence: [] as ReadonlyArray<string>,
    policyVersion: "coding-agent-turn-policy/v1",
  };
  const turnA = {
    ...shared,
    turnId: "coding_turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    kind: "question",
    authorNodeId: AUTHOR,
    recipients: [QUALITY],
    replyToTurnId: "coding_turn_bbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  } as CodingAgentTurn;
  const turnB = {
    ...shared,
    turnId: "coding_turn_bbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    kind: "answer",
    authorNodeId: QUALITY,
    recipients: [AUTHOR],
    replyToTurnId: "coding_turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  } as CodingAgentTurn;
  const plan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [turnA, turnB],
  });
  assert.deepEqual(plan.acceptedTurnIds, []);
  assert.equal(plan.rejected.length, 2);
  assert.ok(plan.rejected.every((item) => item.reason === "reply-cycle"));
});

test("a stale reply to an already-settled obligation is rejected", () => {
  const initial = question({ responseRequirement: "any" });
  const firstAnswer = createCodingAgentTurn({
    kind: "answer", authorNodeId: QUALITY, recipients: [AUTHOR], subjectId: "delivery-contract",
    replyToTurnId: initial.turnId, originatingTaskId: TASK, responseRequirement: "none", body: "First answer.",
  });
  const secondAnswer = createCodingAgentTurn({
    kind: "answer", authorNodeId: QUALITY, recipients: [AUTHOR], subjectId: "delivery-contract",
    replyToTurnId: initial.turnId, originatingTaskId: TASK, responseRequirement: "none", body: "Second, stale answer.",
  });
  const plan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [initial, firstAnswer, secondAnswer],
  });
  // Acceptance is decided by sorted content identity, not by construction order, so only
  // assert the invariant: exactly one reply settles the obligation and the other is stale.
  const [settledTurnId, staleTurnId] = firstAnswer.turnId.localeCompare(secondAnswer.turnId) <= 0
    ? [firstAnswer.turnId, secondAnswer.turnId]
    : [secondAnswer.turnId, firstAnswer.turnId];
  assert.deepEqual(plan.acceptedTurnIds.sort(), [initial.turnId, settledTurnId].sort());
  assert.deepEqual(plan.rejected, [{ turnId: staleTurnId, reason: "stale-reply" }]);
  assert.equal(plan.settledObligations.length, 1);
  assert.equal(plan.settledObligations[0]?.settledByTurnId, settledTurnId);
});

test("peer-only settlement produces exactly one continuation identity without touching a human node", () => {
  const initial = question({ responseRequirement: "any" });
  const answer = createCodingAgentTurn({
    kind: "answer", authorNodeId: QUALITY, recipients: [AUTHOR], subjectId: "delivery-contract",
    replyToTurnId: initial.turnId, originatingTaskId: TASK, responseRequirement: "none", body: "Settled by a peer.",
  });
  const plan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [initial, answer],
  });
  assert.equal(plan.unresolvedObligations.length, 0);
  assert.equal(plan.settledObligations.length, 1);
  assert.equal(plan.responseTasks.length, 0, "settled work is not returned as a pending response task");
  assert.equal(plan.humanEscalation, undefined);
  assert.ok(plan.continuationId);
});

test("exactly-once continuation identity is stable across reordered and duplicated replans", () => {
  const initial = question({ responseRequirement: "any" });
  const answer = createCodingAgentTurn({
    kind: "answer", authorNodeId: QUALITY, recipients: [AUTHOR], subjectId: "delivery-contract",
    replyToTurnId: initial.turnId, originatingTaskId: TASK, responseRequirement: "none", body: "Settled by a peer.",
  });
  const planOne = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [initial, answer],
  });
  const planTwo = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy,
    turns: [answer, answer, initial, initial, answer],
  });
  assert.ok(planOne.continuationId);
  assert.equal(planOne.continuationId, planTwo.continuationId);
});

test("human escalation is projected only when no eligible peer exists or the bounded path is exhausted", () => {
  const noPeer = question({ recipients: [DOCS], responseRequirement: "any" });
  const noPeerPlan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [noPeer],
  });
  assert.equal(noPeerPlan.acceptedTurnIds.length, 1, "the turn itself is still accepted content");
  assert.equal(noPeerPlan.unresolvedObligations.length, 0);
  assert.equal(noPeerPlan.humanEscalation?.reason, "no-eligible-peer");
  assert.equal(noPeerPlan.continuationId, undefined);

  const exhaustedPolicy = clampCodingAgentTurnPolicy({ maxNodes: 8, maxTasks: 16, maxParallel: 4, maxDepth: 0 });
  const exhausted = question({ responseRequirement: "any" });
  const exhaustedPlan = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: exhaustedPolicy, turns: [exhausted],
  });
  assert.equal(exhaustedPlan.humanEscalation?.reason, "bounded-path-exhausted");
  assert.equal(exhaustedPlan.continuationId, undefined);
});

test("human clarification requires an exact versioned control-ingress authorization", () => {
  const turn = createCodingAgentTurn({
    kind: "clarification",
    authorNodeId: HUMAN,
    recipients: [AUTHOR],
    subjectId: "human-message-1",
    originatingTaskId: TASK,
    responseRequirement: "none",
    body: "Keep the response additive and replay compatible.",
  });
  const authorization = createCodingControlIngressAuthorization({
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    runId: "run-1",
    messageId: "message-1",
    turnId: turn.turnId,
    jobId: "job-1",
    jobAttempt: 1,
    topologyVersion: "topology-1",
    authorNodeId: HUMAN,
    recipientTaskId: TASK,
    recipientNodeId: AUTHOR,
  });
  const withoutIngress = planCodingAgentTurns({
    originatingTaskId: TASK, nodes, dependencies, policy: openPolicy, turns: [turn],
  });
  assert.equal(withoutIngress.rejected[0]?.reason, "invalid-recipient");

  const accepted = planCodingAgentTurns({
    originatingTaskId: TASK,
    nodes,
    dependencies,
    policy: openPolicy,
    turns: [turn],
    ingressAuthorizations: [authorization],
    ingressScope: {
      workspaceId: authorization.workspaceId,
      conversationId: authorization.conversationId,
      runId: authorization.runId,
      jobId: authorization.jobId,
      jobAttempt: authorization.jobAttempt,
      topologyVersion: authorization.topologyVersion,
    },
  });
  assert.deepEqual(accepted.acceptedTurnIds, [turn.turnId]);

  const wrongRun = planCodingAgentTurns({
    originatingTaskId: TASK,
    nodes,
    dependencies,
    policy: openPolicy,
    turns: [turn],
    ingressAuthorizations: [authorization],
    ingressScope: {
      workspaceId: authorization.workspaceId,
      conversationId: authorization.conversationId,
      runId: "another-run",
      jobId: authorization.jobId,
      jobAttempt: authorization.jobAttempt,
      topologyVersion: authorization.topologyVersion,
    },
  });
  assert.equal(wrongRun.rejected[0]?.reason, "invalid-recipient");

  const settled = planCodingAgentTurns({
    originatingTaskId: TASK,
    nodes,
    dependencies,
    policy: openPolicy,
    turns: [turn],
    ingressAuthorizations: [authorization],
    ingressScope: {
      workspaceId: authorization.workspaceId,
      conversationId: authorization.conversationId,
      runId: authorization.runId,
      jobId: authorization.jobId,
      jobAttempt: authorization.jobAttempt,
      topologyVersion: authorization.topologyVersion,
    },
    settledTaskIds: [TASK],
  });
  assert.equal(settled.rejected[0]?.reason, "invalid-recipient");
});

test("delivery attempts converge under duplication and reordering and recover on continuation", () => {
  const turn = createCodingAgentTurn({
    kind: "clarification",
    authorNodeId: HUMAN,
    recipients: [AUTHOR],
    subjectId: "human-message-1",
    originatingTaskId: TASK,
    responseRequirement: "none",
    body: "Keep the response additive and replay compatible.",
  });
  const authorization = createCodingControlIngressAuthorization({
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    runId: "run-1",
    messageId: "message-1",
    turnId: turn.turnId,
    jobId: "job-1",
    jobAttempt: 1,
    topologyVersion: "topology-1",
    authorNodeId: HUMAN,
    recipientTaskId: TASK,
    recipientNodeId: AUTHOR,
  });
  const queued = codingControlDeliveryEvent("run-1", HUMAN, {
    schema: "coding-control-delivery/v1", authorization, state: "queued",
  });
  const consumed = codingControlDeliveryEvent("run-1", HUMAN, {
    schema: "coding-control-delivery/v1", authorization, state: "consumed", turn,
  });
  const forward = codingControlDeliveriesFromEvents([queued, consumed]);
  const reordered = codingControlDeliveriesFromEvents([consumed, queued, consumed, queued]);
  assert.deepEqual(reordered, forward);
  assert.equal(forward.get("message-1")?.state, "consumed");
  assert.equal(forward.get("message-1")?.runId, "run-1");

  const message = {
    ...createCodingConversationMessage({
    conversationId: authorization.conversationId,
    author: { kind: "user", id: HUMAN, name: "You" },
    source: { kind: "ui" },
    text: turn.body,
    tags: ["delivery:queued"],
    }),
    messageId: authorization.messageId,
  };
  const pending = (recipientTaskCompleted: boolean, currentJobId = "job-2") =>
    pendingCodingControlMessages({
      messages: [message],
      deliveryAttempts: codingControlDeliveryAttemptsFromEvents([queued, consumed]),
      currentJobId,
      currentJobAttempt: 1,
      recipientTaskCompleted: () => recipientTaskCompleted,
    });
  assert.deepEqual(pending(true), [], "a completed recipient in an older execution stays consumed");
  assert.deepEqual(pending(false), [message], "a failed recipient is eligible for one continuation attempt");
  assert.deepEqual(pending(false, "job-1"), [], "the current consuming attempt is never delivered twice");

  const exhausted = codingControlDeliveryEvent("run-1", HUMAN, {
    schema: "coding-control-delivery/v1", authorization, state: "superseded", reason: "boundary settled",
  });
  const continuationTurn = createCodingAgentTurn({
    kind: "clarification",
    authorNodeId: HUMAN,
    recipients: [AUTHOR],
    subjectId: "human-message-1",
    originatingTaskId: "continue-implement",
    responseRequirement: "none",
    body: turn.body,
  });
  const continuationAuthorization = createCodingControlIngressAuthorization({
    workspaceId: authorization.workspaceId,
    conversationId: authorization.conversationId,
    runId: "run-2",
    messageId: authorization.messageId,
    turnId: continuationTurn.turnId,
    jobId: "job-2",
    jobAttempt: 2,
    topologyVersion: authorization.topologyVersion,
    authorNodeId: authorization.authorNodeId,
    recipientTaskId: "continue-implement",
    recipientNodeId: authorization.recipientNodeId,
  });
  const continuationQueued = codingControlDeliveryEvent("run-2", HUMAN, {
    schema: "coding-control-delivery/v1", authorization: continuationAuthorization, state: "queued",
  });
  const recovered = codingControlDeliveriesFromEvents([continuationQueued, exhausted, queued]);
  assert.equal(recovered.get("message-1")?.state, "queued");
  assert.equal(recovered.get("message-1")?.deliveryAttemptId, continuationAuthorization.deliveryAttemptId);

  const continuationConsumed = codingControlDeliveryEvent("run-2", HUMAN, {
    schema: "coding-control-delivery/v1",
    authorization: continuationAuthorization,
    state: "consumed",
    turn: continuationTurn,
  });
  assert.deepEqual(pendingCodingControlMessages({
    messages: [message],
    deliveryAttempts: codingControlDeliveryAttemptsFromEvents([
      queued,
      consumed,
      continuationQueued,
      continuationConsumed,
    ]),
    currentJobId: "job-3",
    currentJobAttempt: 1,
    recipientTaskCompleted: (delivery) => delivery.jobId === "job-2",
  }), [], "a later successful continuation settles an older failed consumption");
});
