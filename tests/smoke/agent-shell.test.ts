import assert from "node:assert/strict";
import test from "node:test";

import {
  agentComposerHtml,
  agentPageHeaderHtml,
  agentReplayBarHtml,
  agentReplayClientControlsHtml,
  agentExampleTabsHtml,
  agentRoomHeaderHtml,
  agentShellCss,
  agentShellFrameHtml,
  agentSidebarRailHtml,
  agentSidebarHtml,
  agentTopNavHtml,
  agentTabsHtml,
  agentTabsScript,
  staticRoomRoster,
} from "../../src/views/agent-shell.ts";
import { frameworkCoordinationHtml } from "../../src/views/agent-framework.ts";

test("shared agent shell renders one consistent accessible layout contract", () => {
  const sidebar = agentSidebarHtml({ active: "canvas", description: "Shared visual studio" });
  const monitorSidebar = agentSidebarHtml({ active: "monitor", description: "Workspace control" });
  const compactTopNav = agentTopNavHtml({ active: "coding", showNavigation: false });
  const statuslessTopNav = agentTopNavHtml({ active: "coding", showStatus: false });
  const historyTopNav = agentTopNavHtml({ active: "replay" });
  const inspectTopNav = agentTopNavHtml({ active: "simulations" });
  const frame = agentShellFrameHtml({
    skipHref: "#demo-main",
    skipLabel: "Skip to demo",
    chromeHtml: `${agentTopNavHtml({ active: "coding", actionsHtml: "<button>Run</button>" })}${agentSidebarRailHtml({ active: "coding", description: "Repository room" })}`,
    mainHtml: "<p>Shared workspace</p>",
    mainId: "demo-main",
    appClass: "demo-agent",
  });
  const header = agentPageHeaderHtml({ eyebrow: "Studio", title: "Canvas Roster", description: "Paint together." });
  const tabs = agentTabsHtml({
    id: "demo-tabs",
    tabs: [
      { id: "workspace", label: "Workspace", content: "<p>Work</p>" },
      { id: "activity", label: "Activity", badge: "12", content: "<p>Events</p>" },
    ],
  });
  const script = agentTabsScript("test-nonce");
  assert.match(script, /data-participant-profile-dialog/);
  assert.match(script, /closest\('\[data-participant-profile\]'\)/);
  assert.doesNotMatch(script, /data-participant-profile-form/);
  const replay = agentReplayBarHtml({
    id: "demo-replay",
    title: "Run history",
    description: "Replay every worker step.",
    content: agentReplayClientControlsHtml({ id: "demo-replay-controls", adapter: "demo" }),
  });
  const room = agentRoomHeaderHtml({
    title: "#shared-studio",
    description: "People and agents keep the work in one continuing conversation.",
    state: "active",
    roster: staticRoomRoster({
      roomId: "shared-studio",
      summary: "You and Roster are here",
      members: [
        { id: "human.operator", name: "You", role: "Partner", kind: "human", presence: "present" },
        { id: "roster", name: "Roster", role: "Facilitator", kind: "system", presence: "working" },
      ],
    }),
  });

  assert.match(sidebar, /data-slot="agent-sidebar"/);
  assert.match(sidebar, /data-slot="agent-top-nav"/);
  assert.doesNotMatch(sidebar, /Multi-agent workspace/);
  assert.equal((sidebar.match(/aria-label="Roster rooms"/g) ?? []).length, 1);
  assert.match(sidebar, /<nav class="top-navbar-links" aria-label="Primary navigation">/);
  assert.match(compactTopNav, /data-slot="agent-top-nav"/);
  assert.doesNotMatch(compactTopNav, /aria-label="Primary navigation"/);
  assert.doesNotMatch(statuslessTopNav, /aria-label="Workspace status"/);
  assert.match(historyTopNav, /top-navbar-link active" href="\/monitor\?tab=history" aria-current="page">History/);
  assert.doesNotMatch(historyTopNav, /top-navbar-link active" href="\/monitor">Rooms/);
  assert.match(inspectTopNav, /top-navbar-link active" href="\/monitor\?tab=inspect" aria-current="page">Inspect/);
  assert.doesNotMatch(inspectTopNav, /top-navbar-link active" href="\/monitor">Rooms/);
  assert.match(monitorSidebar, /href="\/monitor" aria-current="page"/);
  assert.match(sidebar, /href="\/canvas" aria-current="page"/);
  assert.match(sidebar, /aria-current="page"/);
  assert.match(sidebar, /<ul>.*<li><a/s);
  assert.match(frame, /class="agent-app demo-agent" data-slot="agent-shell" data-ui-family="roster-agent"/);
  assert.match(frame, /data-slot="agent-top-nav-actions"/);
  assert.match(frame, /data-slot="agent-sidebar"/);
  assert.match(frame, /id="demo-main" data-slot="agent-main"/);
  assert.match(header, /data-slot="agent-page-header"/);
  assert.match(replay, /data-slot="agent-replay"/);
  assert.match(replay, /<details/);
  assert.match(replay, /How we got here/);
  assert.match(replay, /id="demo-replay-controls"[^>]*data-replay-controls/);
  assert.match(replay, /role="group" aria-label="Replay controls"/);
  assert.match(replay, /data-replay-action="play" aria-pressed="false"/);
  assert.match(replay, /<label class="travel-scrub">/);
  assert.match(replay, /aria-live="polite" aria-atomic="true"/);
  assert.match(room, /data-slot="agent-room-header"/);
  assert.match(room, /#shared-studio/);
  assert.match(room, /You and Roster are here/);
  assert.match(room, /Working together/);
  assert.match(room, /data-thinking-orb data-orb-state="working" data-orb-size="40"/);
  assert.match(room, /data-node-id="human\.operator" data-kind="human" data-presence="present"/);
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /role="tab" aria-selected="true"/);
  assert.match(tabs, /role="tabpanel"[^>]*tabindex="0"/);
  assert.match(tabs, /data-agent-panel="activity"[^>]* hidden/);
  assert.match(script, /nonce="test-nonce"/);
  assert.match(script, /src="\/assets\/roster-shell\.js"/);
  assert.match(script, /ArrowRight/);
  assert.match(script, /MutationObserver/);
  assert.match(script, /observe\(target,\{childList:true,subtree:true\}\)/);
  assert.match(script, /DOMContentLoaded/);
  assert.match(script, /scope\.matches\(selector\)/);
  assert.doesNotMatch(script, /htmx/i);
  assert.match(agentShellCss(), /\.agent-app\{[^}]*grid-template-columns:var\(--shell-rail\) minmax\(0,1fr\)/);
  assert.match(agentShellCss(), /\.agent-top-nav\{/);
  assert.match(agentShellCss(), /\.agent-replay\{/);
  assert.match(agentShellCss(), /\.agent-room-header\{/);
  assert.match(agentShellCss(), /\.agent-message\{[^}]*grid-template-columns:40px minmax\(0,1fr\)/);
});

test("shared rooms use one global human and Roster profile identity", () => {
  const roster = staticRoomRoster({
    roomId: "global-profiles",
    members: [
      { name: "You", role: "Partner", kind: "human", presence: "present" },
      { name: "Roster", role: "Facilitator", kind: "system", presence: "present" },
    ],
  });
  assert.deepEqual(roster.members.map((member) => member.participant.nodeId), ["human.operator", "coordinator"]);
});

test("shared coordination projections expose headings and machine-readable times", () => {
  const html = frameworkCoordinationHtml({
    metricsTitle: "Coordination Status",
    metrics: [{ key: "Agents", value: "2" }],
    contextTitle: "Context",
    contextRows: [{ title: "Brief", content: "Evidence", ts: 1_700_000_000_000 }],
    boardTitle: "Agent Work",
    trail: [{ body: "Research completed", ts: 1_700_000_001_000 }],
  });
  assert.match(html, /<h2 class="fw-summary-title">Coordination Status<\/h2>/);
  assert.match(html, /<h2 class="fw-head">Context<\/h2>/);
  assert.match(html, /<time class="fw-context-when" datetime="[^"]+">/);
  assert.match(html, /<time class="fw-trail-time" datetime="[^"]+">/);
});

test("shared agent tabs reject duplicate normalized IDs", () => {
  assert.throws(() => agentTabsHtml({
    id: "duplicate-tabs",
    tabs: [
      { id: "Agent Team", label: "Team", content: "a" },
      { id: "agent-team", label: "Agents", content: "b" },
    ],
  }), /Duplicate agent tab/);
});

test("agent examples share one conversation, room rail, and contextual work surface", () => {
  const composer = agentComposerHtml({
    id: "canvas-message",
    title: "Brief the studio",
    description: "Send a message to the room.",
    action: "/canvas/run",
    inputName: "prompt",
    inputLabel: "Message",
    placeholder: "Describe the scene…",
    submitLabel: "Send",
    toolsHtml: '<button type="button">Attach</button>',
  });
  const html = agentExampleTabsHtml({
    id: "canvas-example",
    agentId: "canvas",
    workspace: "canvas",
    runs: "runs",
    activity: "activity",
    conversation: "real conversation",
    composer,
    room: {
      title: "#canvas-studio",
      description: "A continuing creative room.",
      roster: staticRoomRoster({
        roomId: "canvas-studio",
        members: [
          { name: "You", role: "Creative partner", kind: "human", presence: "present" },
          { name: "Director", role: "Art Director", kind: "system", presence: "facilitating" },
        ],
      }),
    },
    domainTabs: [{ id: "review", label: "Review", content: "review" }],
  });
  const ids = [...html.matchAll(/data-agent-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ["workspace", "runs", "activity", "review", "architecture"]);
  assert.match(html, /data-agent-tab="workspace"><span>Work<\/span>/);
  assert.match(html, /data-workspace-shell data-layout="room" data-context-open="false" data-slot="workspace-shell"/);
  assert.match(html, /data-slot="workspace-rail"/);
  assert.match(html, /data-workspace-region="rail"/);
  assert.match(html, /data-workspace-region="rail"[^>]*aria-label="Repository rooms and team"/);
  assert.match(html, /data-slot="workspace-conversation"/);
  assert.match(html, /data-workspace-region="conversation"/);
  assert.match(html, /data-workspace-region="conversation"[^>]*aria-label="Room conversation"/);
  assert.match(html, /data-slot="conversation-feed">real conversation/);
  assert.match(html, /data-slot="composer-dock">/);
  assert.match(html, /data-slot="workspace-composer"/);
  assert.match(html, /class="coding-composer agent-composer"/);
  assert.match(html, /data-slot="composer-input"/);
  assert.match(html, /data-slot="composer-tools"/);
  assert.match(html, /data-composer-advanced/);
  assert.match(html, /Enter to send · Shift\+Enter for a new line/);
  assert.equal((html.match(/<textarea/g) ?? []).length, 1);
  assert.match(html, /data-slot="composer-submit"/);
  assert.equal((html.match(/data-slot="workspace-composer"/g) ?? []).length, 1);
  assert.equal((html.match(/data-slot="composer-input"/g) ?? []).length, 1);
  assert.match(html, /Brief the studio/);
  assert.match(html, /data-slot="workspace-context"[^>]* hidden/);
  assert.match(html, /data-workspace-region="context"/);
  assert.match(html, /real conversation/);
  assert.match(html, /data-room-roster/);
  assert.match(html, /data-slot="agent-room-workspace"[\s\S]*#canvas-studio[\s\S]*data-slot="workspace-context"/);
  assert.match(html, /<span>Shared artifact<\/span><strong>Owned vector patches in a Yjs scene/);
  assert.ok(html.indexOf('data-slot="workspace-rail"') < html.indexOf('data-slot="workspace-conversation"'));
  assert.ok(html.indexOf('data-slot="conversation-feed"') < html.indexOf('data-slot="composer-dock"'));
  assert.ok(html.indexOf('data-slot="workspace-conversation"') < html.indexOf('data-slot="workspace-context"'));
  assert.match(html, /Distributed Visual Frontier/);
  assert.match(html, /How agents are formed/);
  assert.match(html, /When work is accepted/);
  assert.match(html, /model-planned-team/);
  assert.match(html, /peer-certification/);
  assert.match(agentShellCss(), /--shell-rail:248px/);
});
