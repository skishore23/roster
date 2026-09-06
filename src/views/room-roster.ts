import type {
  RoomRosterMember,
  RoomRosterProjection,
} from "../engine/workspace/room.js";
import { projectRoomRoster } from "../engine/workspace/room.js";
import { esc } from "./agent-framework.js";
import { participantProfileAttributes } from "./participant-profile.js";

const dateTime = (value: number): string => new Date(value).toISOString();

const memberHtml = (member: RoomRosterMember): string => {
  const participant = member.participant;
  const updatedAt = member.contribution?.updatedAt ?? member.presence.updatedAt;
  return `<li class="room-roster-member" data-room-member data-node-id="${esc(participant.nodeId)}" data-kind="${esc(participant.kind)}" data-presence="${esc(member.presence.state)}">
    <button type="button" class="room-roster-profile participant-profile-trigger" ${participantProfileAttributes(participant)} title="Open ${esc(participant.displayName)}’s profile"><span class="room-roster-avatar" aria-hidden="true">${esc(participant.displayName.slice(0, 1).toUpperCase())}</span>
    <span class="room-roster-identity"><strong>${esc(participant.displayName)}</strong><small>${esc(participant.handle)} · ${esc(participant.role)}</small></span></button>
    <span class="room-roster-presence"><i aria-hidden="true"></i>${esc(member.presence.label)}</span>
    ${member.contribution ? `<span class="room-roster-contribution"${member.contribution.kind ? ` data-kind="${esc(member.contribution.kind)}"` : ""}>${esc(member.contribution.summary)}</span>` : ""}
    ${updatedAt !== undefined ? `<time datetime="${dateTime(updatedAt)}">${esc(new Date(updatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))}</time>` : ""}
  </li>`;
};

export const roomRosterHtml = (
  input: RoomRosterProjection,
  options: {
    readonly id?: string;
    readonly compact?: boolean;
    readonly visibleCount?: number;
  } = {},
): string => {
  const roster = projectRoomRoster(input);
  const visibleCount = Math.max(1, options.visibleCount ?? (options.compact ? 4 : 6));
  const visible = roster.members.slice(0, visibleCount);
  const overflow = roster.members.slice(visibleCount);
  const id = options.id ?? `room-roster-${roster.roomId.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
  const empty = roster.members.length === 0
    ? `<p class="room-roster-empty">Invite an agent or teammate to begin.</p>`
    : "";
  return `<section class="room-roster${options.compact ? " room-roster-compact" : ""}" id="${esc(id)}" data-room-roster data-room-id="${esc(roster.roomId)}" aria-labelledby="${esc(id)}-title">
    <header class="room-roster-head"><span><small>In this room</small><strong id="${esc(id)}-title">${esc(roster.label)}</strong></span><p role="status" aria-live="polite" aria-atomic="true">${esc(roster.summary)}</p></header>
    ${roster.context ? `<p class="room-roster-context">${esc(roster.context)}</p>` : ""}
    ${empty}
    ${visible.length > 0 ? `<ul class="room-roster-list">${visible.map(memberHtml).join("")}</ul>` : ""}
    ${overflow.length > 0 ? `<details class="room-roster-overflow" data-details-key="room-roster-overflow"><summary>Show ${overflow.length} more member${overflow.length === 1 ? "" : "s"}</summary><ul class="room-roster-list">${overflow.map(memberHtml).join("")}</ul></details>` : ""}
  </section>`;
};

export const roomRosterCss = (): string => `
  .room-roster{min-width:0;display:grid;align-content:start;gap:10px;padding:14px;border:1px solid var(--border-subtle,var(--line-soft));border-radius:var(--radius-md,14px);background:var(--surface-panel,var(--panel))}
  .room-roster-head{min-width:0;display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.room-roster-head>span{min-width:0;display:grid;gap:3px}.room-roster-head small{color:var(--accent,var(--agent-accent));font:800 8px/1.2 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em}.room-roster-head strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary,var(--ink));font-size:12px}.room-roster-head p{max-width:48ch;margin:0;color:var(--text-secondary,var(--muted));font-size:9px;line-height:1.4;text-align:right}
  .room-roster-context,.room-roster-empty{margin:0;color:var(--text-tertiary,var(--faint));font-size:9px;line-height:1.45}.room-roster-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:7px;margin:0;padding:0;list-style:none}
  .room-roster-member{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"profile presence" "contribution time";align-items:center;gap:2px 9px;padding:9px;border:1px solid var(--border-subtle,var(--line-soft));border-radius:var(--radius-sm,9px);background:var(--surface-inset,var(--panel-2))}.room-roster-profile{grid-area:profile;min-width:0;display:grid;grid-template-columns:32px minmax(0,1fr);gap:9px;align-items:center;text-align:left}
  .room-roster-avatar{width:32px;height:32px;display:grid;place-items:center;border:1px solid var(--border-default,var(--line));border-radius:9px;color:var(--text-primary,var(--ink));background:var(--surface-raised,var(--raised));font-size:9px;font-weight:850}.room-roster-identity{min-width:0}.room-roster-identity strong,.room-roster-identity small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.room-roster-identity strong{color:var(--text-primary,var(--ink));font-size:10px}.room-roster-identity small{margin-top:2px;color:var(--text-tertiary,var(--faint));font-size:8px}
  .room-roster-presence{grid-area:presence;display:inline-flex;align-items:center;gap:5px;color:var(--text-secondary,var(--muted));font:750 7px/1 ui-monospace,monospace;text-transform:uppercase;white-space:nowrap}.room-roster-presence i{width:6px;height:6px;border-radius:50%;background:var(--text-tertiary,var(--faint))}.room-roster-member[data-presence="working"] .room-roster-presence i,.room-roster-member[data-presence="facilitating"] .room-roster-presence i,.room-roster-member[data-presence="present"] .room-roster-presence i{background:var(--success,var(--green))}
  .room-roster-member[data-presence="waiting"] .room-roster-presence i{background:var(--warning,var(--amber))}.room-roster-contribution{grid-area:contribution;min-width:0;overflow:hidden;color:var(--text-secondary,var(--muted));font-size:8px;text-overflow:ellipsis;white-space:nowrap}.room-roster-member time{grid-area:time;color:var(--text-tertiary,var(--faint));font:7px/1 ui-monospace,monospace;white-space:nowrap}
  .room-roster-overflow{border-top:1px solid var(--border-subtle,var(--line-soft));padding-top:8px}.room-roster-overflow>summary{width:max-content;max-width:100%;color:var(--accent,var(--agent-accent));cursor:pointer;font-size:9px;font-weight:750}.room-roster-overflow[open]>summary{margin-bottom:8px}
  .room-roster-compact{border:0;padding:0;background:transparent}.room-roster-compact .room-roster-head>span,.room-roster-compact .room-roster-context{display:none}.room-roster-compact .room-roster-head{justify-content:flex-end}.room-roster-compact .room-roster-head p{font-size:8px}.room-roster-compact .room-roster-list{display:flex;justify-content:flex-end}.room-roster-compact .room-roster-member{width:32px;height:32px;display:block;padding:0;border-radius:50%}.room-roster-compact .room-roster-member+.room-roster-member{margin-left:-8px}.room-roster-compact .room-roster-profile{display:block}.room-roster-compact .room-roster-avatar{width:30px;height:30px;border-radius:50%}.room-roster-compact .room-roster-identity,.room-roster-compact .room-roster-presence,.room-roster-compact .room-roster-contribution,.room-roster-compact time,.room-roster-compact .room-roster-overflow{display:none}
  @media(max-width:640px){.room-roster-head{display:grid}.room-roster-head p{text-align:left}.room-roster-list{grid-template-columns:1fr}}
`;
