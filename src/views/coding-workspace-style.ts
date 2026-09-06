export const codingSlackWorkspaceCss = `
:root{--coding-rail-width:240px;--coding-workbench-width:336px;--coding-room-header-height:56px}
.coding-page.agent-app{height:100dvh;display:block;overflow:hidden;background:var(--surface-sidebar)}
.coding-page>.agent-top-nav{display:none}
.coding-page .agent-main{width:100%;height:100dvh;min-height:0;padding:0;background:var(--surface-sidebar)}
.coding-page .coding-workbench{height:100dvh;min-height:0;display:grid;grid-template-columns:var(--coding-rail-width) minmax(0,1fr);padding:0;background:var(--surface-sidebar)}
.coding-page .coding-project-rail{min-width:0;border-right:1px solid var(--border-subtle);background:var(--surface-sidebar)}
.coding-page .coding-conversation{position:relative;min-width:0;height:100%;display:grid;grid-template-columns:minmax(0,1fr) var(--coding-workbench-width);grid-template-rows:minmax(0,1fr) auto;overflow:hidden;border:0;border-radius:0;background:var(--surface-canvas);box-shadow:none}
:root[data-coding-context-cast="closed"] .coding-page .coding-conversation{grid-template-columns:minmax(0,1fr) 0}
.coding-page .coding-conversation-scroll{min-width:0;min-height:0;grid-column:1;grid-row:1;overflow:auto;overscroll-behavior:contain}
.coding-page .coding-composer-wrap{min-width:0;grid-column:1;grid-row:2}
.coding-page .coding-context-cast[data-layout="rail"]{width:var(--coding-workbench-width);grid-column:2;grid-row:1/-1;height:100%;display:block;overflow:hidden;padding:0;gap:0;border-left:1px solid var(--border-subtle);background:var(--surface-sidebar)}
.coding-page .coding-project-rail[hidden]{display:none}
.coding-page .coding-rail-toggle,.coding-page .coding-rail-close{display:none}
.coding-page .coding-room-context-head{height:56px;padding:0 12px;border-bottom:1px solid var(--border-subtle)}
.coding-page .coding-context-cast>.coding-room-context-head{position:sticky;top:0;margin:0;padding:0 12px}
.coding-page .coding-workbench-tabs{height:40px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));padding:0;border-bottom:1px solid var(--border-subtle)}
.coding-page .coding-workbench-tab{min-width:0;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent}
.coding-page .coding-workbench-tab[aria-selected="true"]{border-bottom-color:var(--accent);background:var(--surface-hover)}
.coding-page .coding-workbench-panel{height:calc(100% - 96px);overflow:auto;padding:12px}
.coding-page .coding-workbench-panel>*{border-radius:0;box-shadow:none}
.coding-page [data-coding-overlay-scrim]{position:absolute;z-index:35;inset:0;background:rgba(0,0,0,.48)}
@media(max-width:1179px){.coding-page .coding-context-cast[data-layout="rail"]{position:absolute;z-index:40;inset:0 0 0 auto;width:min(var(--coding-workbench-width),calc(100vw - 32px));box-shadow:var(--shadow-overlay)}}
@media(max-width:899px){:root{--coding-rail-width:0px}.coding-page .coding-workbench{grid-template-columns:minmax(0,1fr)}.coding-page .coding-project-rail{display:none;position:absolute;z-index:50;inset:0 auto 0 0;width:min(240px,calc(100vw - 48px));box-shadow:var(--shadow-overlay)}:root[data-overlay-open="rail"] .coding-page .coding-project-rail:not([hidden]){display:block}.coding-page :is(.coding-rail-toggle,.coding-rail-close){min-width:44px;min-height:44px;place-items:center;border:1px solid var(--border-strong);border-radius:var(--radius-control);color:var(--text-secondary);background:var(--surface-raised);cursor:pointer}.coding-page .coding-rail-toggle{display:grid}.coding-page .coding-rail-close{position:absolute;z-index:2;top:6px;right:6px;display:grid}.coding-page .coding-project-rail .coding-workspace-switcher>summary{padding-right:56px}}
@media(prefers-reduced-motion:reduce){.coding-page *{scroll-behavior:auto!important;animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}}
.coding-page .coding-workspace-switcher>summary{min-height:48px;padding:6px 12px}
.coding-page .coding-new-room,.coding-page .coding-project-runs a{min-height:34px;border-radius:7px}
.coding-page .coding-room{position:sticky;z-index:20;top:0;min-height:var(--coding-room-header-height);display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;padding:0 20px;border-bottom:1px solid var(--border-subtle);background:color-mix(in srgb,var(--surface-canvas) 94%,transparent);backdrop-filter:blur(16px)}
.coding-page .coding-room-branch,.coding-page .coding-room-kind,.coding-page .coding-room-orb{display:none}
.coding-page .coding-room-empty{display:grid;grid-template-columns:32px minmax(0,1fr);gap:12px;padding:24px 20px;list-style:none}
.coding-page .coding-room-empty h3{margin:0;font-size:16px}.coding-page .coding-room-empty p{margin:4px 0 12px;color:var(--text-secondary);font-size:13px}
.coding-page .coding-room-empty [aria-label="Suggested prompts"]{display:flex;gap:8px;flex-wrap:wrap}
@media(max-width:700px){.coding-page .coding-room{min-height:var(--coding-room-header-height);padding-inline:12px}.coding-page .coding-room-social{display:flex}.coding-page .coding-room-social>:is(.room-roster,.coding-command-trigger){display:none}}
.coding-page [data-coding-room-transcript]{width:100%;max-width:none;margin:0;padding:12px 0 24px;list-style:none}
.coding-page .coding-social-row{width:100%;display:grid;grid-template-columns:32px minmax(0,1fr);gap:10px;padding:5px 20px}
.coding-page .coding-social-row:hover,.coding-page .coding-social-row:focus-within{background:var(--surface-hover)}
.coding-page .coding-social-row .coding-message-avatar{width:32px;height:32px;border-radius:7px}
.coding-page .coding-social-row-continuation{padding-top:2px}.coding-page .coding-social-row-continuation .coding-message-avatar{visibility:hidden}
.coding-page .coding-message-meta{min-height:18px;display:flex;align-items:baseline;gap:6px}
.coding-page .coding-message-meta strong{font-size:13px}.coding-page .coding-message-meta>span,.coding-page .coding-message-meta time{font-size:11px}
.coding-page .coding-social-row .coding-message-body{max-width:880px;margin-top:2px;font-size:14px;line-height:1.45}
.coding-page .coding-message-evidence>summary{opacity:0}.coding-page .coding-social-row:hover .coding-message-evidence>summary,.coding-page .coding-social-row:focus-within .coding-message-evidence>summary{opacity:1}
.coding-page .coding-composer-wrap{width:100%;padding:8px 20px max(12px,env(safe-area-inset-bottom));border-top:1px solid var(--border-subtle);background:var(--surface-canvas)}
.coding-page .coding-composer-grid{width:100%;max-width:none;margin:0}
.coding-page .coding-composer{min-height:76px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:10px;background:var(--surface-raised);box-shadow:none}
.coding-page .coding-composer textarea{min-height:34px;max-height:180px;padding:4px 2px;font-size:14px;line-height:1.45}
.coding-page .coding-composer-help{display:flex;margin:5px 2px 0;font-size:11px}
.coding-page .coding-new-messages{position:relative;z-index:25;grid-column:1;grid-row:1;align-self:end;justify-self:end;margin:0 20px 12px}
.coding-page .coding-human-action{margin:8px 20px;padding:10px 12px;border-radius:8px}
@media(max-width:639px){.coding-page .coding-composer-wrap{padding-inline:12px}.coding-page .coding-composer :is(button,summary){min-height:44px}}
`;
