import { esc } from "./agent-framework.js";
import { selectControlBootstrap, selectControlCss } from "./select-control.js";

export const THEME_STORAGE_KEY = "roster.theme.preference.v2";

export const themeSelectorHtml = (className = "theme-control"): string => `<span class="${esc(className)}"><label for="roster-theme-select">Theme</label><select id="roster-theme-select" data-theme-select data-ui-select aria-label="Theme"><option value="dark" data-description="Roster's default workspace">Dark</option><option value="system" data-description="Follow this device">System</option><option value="light" data-description="Warm light workspace">Light</option></select></span>`;

export const themeBootstrapScript = (nonce?: string): string => {
  const nonceAttribute = nonce ? ` nonce="${esc(nonce)}"` : "";
  return `<script${nonceAttribute}>
(()=>{const key=${JSON.stringify(THEME_STORAGE_KEY)},valid=new Set(['light','dark','system']),media=()=>window.matchMedia?.('(prefers-color-scheme: dark)'),read=()=>{try{const value=localStorage.getItem(key);return value&&valid.has(value)?value:'dark';}catch{return 'dark';}},effective=(preference)=>preference==='system'?(media()?.matches?'dark':'light'):preference,apply=(preference)=>{const resolved=effective(preference),root=document.documentElement;root.dataset.theme=resolved;const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.setAttribute('content',resolved==='dark'?'#11120f':'#f3f0e8');document.querySelectorAll('[data-theme-select]').forEach((select)=>{if(select.value!==preference)select.value=preference;select.dispatchEvent?.(new Event('ui-select-sync'));});},save=(preference)=>{try{localStorage.setItem(key,preference);}catch{}apply(preference);};let preference=read();apply(preference);const query=media(),onMediaChange=()=>{if(preference==='system')apply(preference);};if(query?.addEventListener)query.addEventListener('change',onMediaChange);else query?.addListener?.(onMediaChange);window.addEventListener('storage',(event)=>{if(event.key!==null&&event.key!==key)return;preference=event.newValue&&valid.has(event.newValue)?event.newValue:'dark';apply(preference);});const init=()=>{apply(preference);document.querySelectorAll('[data-theme-select]').forEach((select)=>{select.value=preference;select.dispatchEvent?.(new Event('ui-select-sync'));select.addEventListener('change',()=>{const next=valid.has(select.value)?select.value:'dark';preference=next;save(next);});});};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();})();
${selectControlBootstrap()}
</script>`;
};

export const themeCss = (): string => `
:root[data-theme="dark"]{color-scheme:dark}
:root[data-theme="light"]{color-scheme:light;--bg:#f3f0e8;--panel:#fffdf7;--panel-2:#ece9df;--raised:#e6e4d9;--line:#bfc4b7;--line-soft:#d9ddd1;--ink:#20231c;--muted:#52584c;--faint:#596052;--blue:#365f18;--green:#3f6b2a;--amber:#755700;--red:#9d3b3f;--violet:#624592;--agent-accent-soft:rgba(83,126,45,.12)}
:root[data-theme="light"]{--surface-canvas:#f3f0e8;--surface-sidebar:#ebe9df;--surface-panel:#fffdf7;--surface-raised:#ece9df;--surface-hover:#e2e4d8;--surface-inset:#f7f5ee;--surface-overlay:#fffdf7;--border-subtle:#d7dbcf;--border-default:#bfc4b7;--border-strong:#969f8b;--text-primary:#20231c;--text-secondary:#52584c;--text-tertiary:#596052;--accent:#4c7627;--accent-strong:#365f18;--success:#3f6b2a;--success-surface:#edf5e9;--success-border:#9ebd8c;--warning:#755700;--warning-surface:#fff7df;--warning-border:#d4b868;--danger:#9d3b3f;--danger-surface:#fff0ed;--danger-border:#d39a95;--focus-ring:#4c7627;--action-primary:#20231c;--action-primary-hover:#33392d;--action-primary-foreground:#fffdf7;--shadow-card:0 12px 36px rgba(32,35,28,.12);--shadow-overlay:0 28px 90px rgba(32,35,28,.2)}
:root[data-theme="light"] .coding-page,:root[data-theme="light"] .coding-review-page{--surface-canvas:#f3f0e8;--surface-sidebar:#ebe9df;--surface-panel:#fffdf7;--surface-raised:#ece9df;--surface-hover:#e2e4d8;--surface-inset:#f7f5ee;--surface-overlay:#fffdf7;--border-subtle:#d7dbcf;--border-default:#bfc4b7;--border-strong:#969f8b;--text-primary:#20231c;--text-secondary:#52584c;--text-tertiary:#596052;--accent:#4c7627;--accent-strong:#365f18;--success:#3f6b2a;--success-surface:#edf5e9;--success-border:#9ebd8c;--warning:#755700;--warning-surface:#fff7df;--warning-border:#d4b868;--danger:#9d3b3f;--danger-surface:#fff0ed;--danger-border:#d39a95;--focus-ring:#4c7627;--action-primary:#20231c;--action-primary-hover:#33392d;--action-primary-foreground:#fffdf7}
:root[data-theme="light"] .coding-page .agent-top-nav,:root[data-theme="light"] .coding-page .coding-project-rail{background:var(--surface-sidebar)}
:root[data-theme="light"] .coding-page .coding-menu-panel,:root[data-theme="light"] .coding-page .coding-repository-panel,:root[data-theme="light"] .coding-page .coding-composer,:root[data-theme="light"] .coding-review-page .coding-review-file{background:var(--surface-panel);color:var(--text-primary)}
:root[data-theme="light"] .coding-page .coding-repository-panel p{background:var(--surface-inset)}
:root[data-theme="light"] .coding-page .coding-repository-panel .coding-workspace-settings p{background:transparent}
:root[data-theme="light"] .coding-page .coding-message article p,:root[data-theme="light"] .coding-page .coding-result p,:root[data-theme="light"] .coding-review-page .coding-review-code{color:var(--text-primary)}
:root[data-theme="light"] .coding-page textarea,:root[data-theme="light"] .coding-page input,:root[data-theme="light"] .coding-review-page .coding-review-code tr{background:var(--surface-inset);color:var(--text-primary)}
:root[data-theme="light"] .coding-review-page .coding-review-file>header{background:var(--surface-panel)}
:root[data-theme="light"] .coding-review-page .coding-review-code td:nth-child(1),:root[data-theme="light"] .coding-review-page .coding-review-code td:nth-child(2){border-color:var(--border-subtle);color:var(--text-tertiary)}
:root[data-theme="light"] .coding-review-page .coding-review-code tr[data-kind="addition"]{background:var(--success-surface)}
:root[data-theme="light"] .coding-review-page .coding-review-code tr[data-kind="addition"] td:nth-child(3){color:var(--success)}
:root[data-theme="light"] .coding-review-page .coding-review-code tr[data-kind="deletion"]{background:var(--danger-surface)}
:root[data-theme="light"] .coding-review-page .coding-review-code tr[data-kind="deletion"] td:nth-child(3){color:var(--danger)}
:root[data-theme="light"] .coding-review-page .coding-review-code tr[data-kind="meta"] td:nth-child(3){color:var(--accent-strong);background:var(--surface-raised)}
.theme-control{display:inline-flex;align-items:center;gap:6px;color:var(--muted,var(--text-secondary,#4d5a68));font:700 9px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em}.theme-control select{min-height:32px;width:auto;border:1px solid var(--line,var(--border-default,#c5ced8));border-radius:var(--radius-sm,8px);padding:4px 7px;color:var(--ink,var(--text-primary,#17202a));background:var(--raised,var(--surface-raised,#f1f3f6));font:inherit;text-transform:none;letter-spacing:normal;cursor:pointer}
${selectControlCss()}
.theme-control .ui-select-trigger{min-height:32px;font:700 9px/1 ui-monospace,monospace;text-transform:none;letter-spacing:normal}
`;

export const themeContrastPairs = Object.freeze([
  ["#20231c", "#fffdf7"],
  ["#52584c", "#fffdf7"],
  ["#596052", "#ebe9df"],
  ["#365f18", "#fffdf7"],
  ["#755700", "#fff7df"],
  ["#9d3b3f", "#fff0ed"],
  ["#3f6b2a", "#edf5e9"],
] as const);
