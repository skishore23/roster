import assert from "node:assert/strict";
import test from "node:test";

import { projectRoomRoster, roomParticipant } from "../../src/engine/workspace/room.ts";
import { roomRosterHtml } from "../../src/views/room-roster.ts";

test("room roster orders people, facilitators, and active agents deterministically", () => {
  const roster = projectRoomRoster({
    roomId: "code",
    label: "Code room",
    summary: "Ada and two agents are here",
    members: [
      roomParticipant({ nodeId: "reviewer", displayName: "Zed", role: "Reviewer", kind: "agent", presence: "waiting" }),
      roomParticipant({ nodeId: "builder", displayName: "Mira", role: "Builder", kind: "agent", presence: "working" }),
      roomParticipant({ nodeId: "facilitator", displayName: "Roster", role: "Facilitator", kind: "system", presence: "facilitating" }),
      roomParticipant({ nodeId: "human", displayName: "Ada", role: "Owner", kind: "human", presence: "present" }),
    ],
  });

  assert.deepEqual(roster.members.map((member) => member.participant.nodeId), [
    "human",
    "facilitator",
    "builder",
    "reviewer",
  ]);
});

test("room roster exposes named social state without runtime or task placement", () => {
  const html = roomRosterHtml(projectRoomRoster({
    roomId: "canvas",
    label: "Canvas studio",
    summary: "Two members are shaping one scene",
    context: "New specialists appear when invited",
    members: [
      roomParticipant({
        nodeId: "human",
        displayName: "<You>",
        role: "Creative partner",
        kind: "human",
        presence: "present",
      }),
      roomParticipant({
        nodeId: "director",
        displayName: "Mara",
        role: "Art Director",
        kind: "system",
        presence: "facilitating",
        contribution: {
          kind: "proposal",
          summary: "Assigning the foreground",
          updatedAt: 1_700_000_000_000,
        },
      }),
    ],
  }));

  assert.match(html, /In this room/);
  assert.match(html, /&lt;You&gt;/);
  assert.match(html, /Mara/);
  assert.match(html, /Art Director/);
  assert.match(html, /Facilitating/);
  assert.match(html, /Assigning the foreground/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /data-participant-profile="human"/);
  assert.match(html, /data-participant-profile="director"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /codex|claude|runtime|session|lease|task/i);
  assert.equal((html.match(/aria-live=/g) ?? []).length, 1);
});

test("room roster keeps overflow members accessible behind native disclosure", () => {
  const html = roomRosterHtml({
    roomId: "large-room",
    label: "Large room",
    summary: "Eight members are here",
    members: Array.from({ length: 8 }, (_, index) => roomParticipant({
      nodeId: `agent-${String(index)}`,
      displayName: `Agent ${String(index)}`,
      role: "Specialist",
      kind: "agent",
      presence: index < 2 ? "working" : "joined",
    })),
  }, { visibleCount: 3 });

  assert.match(html, /Show 5 more members/);
  assert.match(html, /<details/);
  assert.match(html, /Agent 7/);
});
