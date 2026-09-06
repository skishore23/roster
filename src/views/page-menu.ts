import { esc } from "./agent-framework.js";
import {
  coordinationExamples,
  type CoordinationExampleNavigationId,
} from "../engine/orchestration/architecture-catalog.js";

export type PageMenuId =
  | "monitor"
  | "simulations"
  | "replay"
  | CoordinationExampleNavigationId;

type PageMenuItem = {
  readonly id: PageMenuId;
  readonly label: string;
  readonly pattern: string;
  readonly href: string;
};

const PAGE_MENU_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly items: ReadonlyArray<PageMenuItem>;
}> = [
  {
    label: "Rooms",
    items: [
      { id: "monitor", label: "Lobby", pattern: "All people, agents, and rooms", href: "/monitor" },
      ...coordinationExamples().map((example) => ({
        id: example.navigationId as CoordinationExampleNavigationId,
        label: example.roomName ?? `#${example.navigationId}`,
        pattern: `${example.name} · ${example.navigationSummary ?? example.coordinationLabel}`,
        href: example.routePath ?? "/monitor",
      })),
    ],
  },
  {
    label: "System",
    items: [
      { id: "replay", label: "History", pattern: "Reconstruct past decisions", href: "/replay" },
      { id: "simulations", label: "Inspect", pattern: "Stress coordination policies", href: "/simulations" },
    ],
  },
];

export const pageMenuCss = (): string => `
  .page-menu { display:grid; gap:18px; margin:22px 0 18px; }
  .page-menu-group,.page-menu-group ul { display:grid; gap:5px; }.page-menu-group ul{list-style:none;margin:0;padding:0}
  .page-menu-label { padding:0 8px 3px; color:var(--muted); font:700 9px/1.2 "IBM Plex Mono",ui-monospace,monospace; text-transform:uppercase; letter-spacing:.08em; }
  .page-menu a { min-width:0; min-height:44px; display:grid; grid-template-columns:8px minmax(0,1fr); align-items:center; gap:10px; padding:6px 9px; border:1px solid transparent; border-radius:var(--radius-sm,9px); color:var(--muted); text-decoration:none; background:transparent; }
  .page-menu a:hover { color:var(--ink); border-color:var(--line); background:var(--raised,#171c22); }
  .page-menu a:focus-visible { outline:2px solid var(--blue,var(--accent,#64b5f6)); outline-offset:2px; }
  .page-menu a.active { color:var(--ink); border-color:color-mix(in srgb,var(--blue,var(--accent,#64b5f6)) 38%,var(--line)); background:color-mix(in srgb,var(--blue,var(--accent,#64b5f6)) 9%,var(--panel)); }
  .page-menu-marker { width:7px; height:7px; border-radius:50%; background:var(--line); box-shadow:0 0 0 3px color-mix(in srgb,var(--line) 45%,transparent); }
  .page-menu a.active .page-menu-marker { background:var(--blue,var(--accent,#64b5f6)); box-shadow:0 0 0 4px color-mix(in srgb,var(--blue,var(--accent,#64b5f6)) 12%,transparent); }
  .page-menu-copy { min-width:0; display:grid; gap:2px; }
  .page-menu-copy strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:inherit; font-size:11px; line-height:1.2; }
  .page-menu-copy small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); font:9px/1.2 "IBM Plex Mono",ui-monospace,monospace; }
`;

export const pageMenuHtml = (active?: PageMenuId): string => `
  <nav class="page-menu" aria-label="Roster workspace">
    ${PAGE_MENU_GROUPS.map((group, index) => `<section class="page-menu-group" aria-labelledby="page-menu-group-${index}">
      <h2 class="page-menu-label" id="page-menu-group-${index}">${esc(group.label)}</h2>
      <ul>${group.items.map((item) => {
        const isActive = item.id === active;
        return `<li><a class="${isActive ? "active" : ""}" href="${item.href}"${isActive ? ' aria-current="page"' : ""}>
          <span class="page-menu-marker" aria-hidden="true"></span>
          <span class="page-menu-copy"><strong>${esc(item.label)}</strong><small>${esc(item.pattern)}</small></span>
        </a></li>`;
      }).join("")}</ul>
    </section>`).join("")}
  </nav>`;

/**
 * Compact operating navigation for the persistent top bar. Coordination
 * examples keep their richer, grouped navigation in the workspace rail.
 */
export const pageTopNavHtml = (active?: PageMenuId): string => {
  const items: ReadonlyArray<PageMenuItem> = [
    { id: "monitor", label: "Rooms", pattern: "Open rooms", href: "/monitor" },
    { id: "monitor", label: "Attention", pattern: "Needs you", href: "/monitor?tab=attention" },
    { id: "replay", label: "History", pattern: "Past decisions", href: "/monitor?tab=history" },
    { id: "simulations", label: "Inspect", pattern: "System tools", href: "/monitor?tab=inspect" },
  ];
  return `<nav class="top-navbar-links" aria-label="Primary navigation"><ul>${items.map((item) => {
    const isActive = (item.label === "Rooms" && active !== undefined && active !== "replay" && active !== "simulations")
      || (item.label === "History" && active === "replay")
      || (item.label === "Inspect" && active === "simulations");
    return `<li><a class="top-navbar-link${isActive ? " active" : ""}" href="${item.href}"${isActive ? ' aria-current="page"' : ""}>${esc(item.label)}</a></li>`;
  }).join("")}</ul></nav>`;
};
