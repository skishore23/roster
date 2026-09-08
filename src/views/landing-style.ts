import { agentWorkspaceThemeTokens } from "./agent-shell.js";

// Share the application palette; the landing page has no external font or script dependency.
export const landingCss = `
:root { ${agentWorkspaceThemeTokens}; color-scheme:dark; }
* { box-sizing:border-box; }
html { scroll-behavior:smooth; scroll-padding-top:100px; }
body { margin:0; background:var(--surface-canvas); color:var(--text-primary); font:16px/1.6 var(--font-ui); -webkit-font-smoothing:antialiased; }
a { color:inherit; text-underline-offset:4px; }
a:hover { color:var(--accent); }
:focus-visible { outline:2px solid var(--focus-ring); outline-offset:5px; }
::selection { color:var(--surface-canvas); background:var(--accent); }
h1,h2,h3,p { margin:0; }
h1,h2,h3 { line-height:1.1; text-wrap:balance; }
main,.site-header,.site-footer { width:min(1180px,calc(100% - 64px)); margin-inline:auto; }
.skip-link { position:fixed; z-index:100; top:10px; left:10px; padding:12px 20px; transform:translateY(-160%); color:var(--action-primary-foreground); background:var(--accent); }
.skip-link:focus { transform:none; }
.site-header { min-height:88px; display:flex; align-items:center; justify-content:space-between; gap:24px; border-bottom:1px solid var(--border-subtle); }
.brand { display:inline-flex; align-items:center; gap:10px; font-size:19px; font-weight:700; text-decoration:none; letter-spacing:-.04em; }
.brand>span { display:grid; place-items:center; width:30px; height:30px; border-radius:8px; background:var(--accent); color:var(--surface-canvas); }
nav { display:flex; align-items:center; flex-wrap:wrap; gap:24px; }
nav a { display:inline-flex; align-items:center; min-height:44px; font-size:13px; text-decoration:none; }
.button { display:inline-flex; align-items:center; justify-content:center; gap:16px; min-height:48px; padding:12px 20px; border:1px solid var(--border-strong); border-radius:var(--radius-control); font-size:14px; font-weight:650; text-decoration:none; background:var(--surface-panel); }
.button:hover { border-color:var(--accent); color:var(--text-primary); }
.button.primary { background:var(--action-primary); color:var(--action-primary-foreground); border-color:var(--action-primary); }
.button.primary:hover { background:var(--action-primary-hover); }
.button.small { min-height:40px; padding:8px 14px; font-size:12px; }
.hero { display:grid; grid-template-columns:1.1fr 1fr; align-items:center; gap:64px; padding:100px 0 80px; }
.eyebrow { color:var(--accent); font:500 11px/1.5 var(--font-mono); letter-spacing:.09em; text-transform:uppercase; }
.status-dot { display:inline-block; width:6px; height:6px; margin-right:8px; border-radius:50%; background:var(--accent); }
h1 { margin-top:24px; font-size:clamp(42px,4.8vw,64px); font-weight:600; letter-spacing:-.055em; }
h1 span { color:var(--accent); }
.intro { max-width:520px; margin-top:26px; color:var(--text-secondary); font-size:18px; line-height:1.65; }
.actions { display:flex; flex-wrap:wrap; gap:12px; margin-top:32px; }
.preview-note { max-width:460px; margin-top:20px; color:var(--text-secondary); font-size:12px; }
.workflow-preview { min-width:0; margin:0; border:1px solid var(--border-default); border-radius:14px; background:var(--surface-panel); box-shadow:var(--shadow-card); }
.workflow-preview figcaption { display:grid; gap:12px; padding:26px; border-bottom:1px solid var(--border-subtle); }
.workflow-preview figcaption strong { font-size:19px; font-weight:550; letter-spacing:-.02em; }
.workflow-preview ol { list-style:none; margin:0; padding:12px 24px; }
.workflow-preview li { min-height:92px; display:flex; align-items:center; gap:16px; }
.workflow-preview li+li { border-top:1px solid var(--border-subtle); }
.step-mark { display:grid; place-items:center; width:32px; height:32px; flex:none; border:1px solid var(--border-strong); border-radius:50%; color:var(--accent); font:11px var(--font-mono); }
.workflow-preview li>div { min-width:0; flex:1; }
.workflow-preview li strong { font-size:14px; font-weight:550; }
.workflow-preview li p { margin-top:4px; font-size:12px; color:var(--text-secondary); }
.flow-tag { color:var(--text-secondary); font:10px var(--font-mono); }
.diagram-note { padding:14px 24px; border-top:1px solid var(--border-subtle); color:var(--text-secondary); font:10px/1.6 var(--font-mono); }
.runtime-strip { padding:28px 0; display:flex; align-items:center; justify-content:space-between; gap:24px; border-block:1px solid var(--border-subtle); }
.runtime-strip p { color:var(--text-secondary); font-size:12px; }
.runtime-strip ul { list-style:none; display:flex; flex-wrap:wrap; gap:30px; padding:0; margin:0; font-size:15px; font-weight:550; }
.section { padding:80px 0; }
.section-heading { max-width:600px; }
h2 { margin-top:16px; font-size:clamp(30px,3vw,42px); font-weight:550; letter-spacing:-.04em; }
.section-heading>p:not(.eyebrow) { margin-top:20px; color:var(--text-secondary); }
.workflow-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); list-style:none; gap:28px; padding:0; margin:42px 0 0; }
.workflow-grid li { border-top:1px solid var(--border-default); padding-top:20px; }
.step-number { color:var(--accent); font:12px var(--font-mono); }
h3 { font-size:18px; font-weight:550; letter-spacing:-.02em; }
.workflow-grid h3 { margin-top:24px; }
.workflow-grid p,.capability-grid p { margin-top:14px; color:var(--text-secondary); font-size:14px; }
.capabilities { border-block:1px solid var(--border-subtle); }
.capability-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:40px; margin-top:36px; }
.get-started { display:grid; grid-template-columns:1fr 1fr; gap:64px; }
.text-link { display:inline-flex; gap:12px; align-items:center; min-height:44px; margin-top:24px; color:var(--accent); font-size:14px; }
.setup { min-width:0; }
pre { max-width:100%; margin:0; overflow-x:auto; padding:24px; border:1px solid var(--border-default); border-radius:10px; background:var(--surface-inset); font-size:12px; line-height:1.9; }
code { font-family:var(--font-mono); }
.setup>p { margin-top:16px; color:var(--text-secondary); font-size:12px; overflow-wrap:anywhere; }
.questions { border-top:1px solid var(--border-subtle); display:grid; grid-template-columns:1fr 1fr; gap:64px; }
.question-list details { border-bottom:1px solid var(--border-default); }
.question-list summary { padding:20px 0; min-height:48px; cursor:pointer; font-size:15px; }
.question-list details p { padding-bottom:20px; color:var(--text-secondary); font-size:14px; }
.question-list a { color:var(--accent); }
.site-footer { min-height:120px; padding-block:28px; display:flex; flex-wrap:wrap; align-items:center; gap:24px; border-top:1px solid var(--border-subtle); }
.site-footer p { flex:1; font-size:12px; color:var(--text-secondary); }
.site-footer nav { gap:20px; }
@media(max-width:1000px) {
  .hero { gap:32px; padding-top:70px; }
  .flow-tag { display:none; }
  .runtime-strip { align-items:flex-start; flex-direction:column; }
  .workflow-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .get-started,.questions { gap:32px; }
}
@media(max-width:700px) {
  main,.site-header,.site-footer { width:calc(100% - 36px); }
  .site-header { min-height:76px; gap:12px; }
  .site-header nav { gap:12px; }
  .site-header nav>a:first-child { display:none; }
  .hero { grid-template-columns:1fr; padding:52px 0 40px; gap:36px; }
  h1 { font-size:clamp(39px,9vw,58px); }
  .intro { font-size:16px; }
  .actions .button { flex-grow:1; }
  .workflow-preview figcaption { padding:22px; }
  .workflow-preview ol { padding-inline:20px; }
  .runtime-strip ul { gap:14px 22px; font-size:14px; }
  .section { padding:52px 0; }
  .workflow-grid { gap:28px 20px; }
  .workflow-grid h3 { font-size:16px; }
  .capability-grid,.get-started,.questions { grid-template-columns:1fr; gap:28px; }
  .capability-grid { margin-top:28px; }
  .site-footer { gap:12px 20px; }
  .site-footer nav { width:100%; }
}
@media(prefers-reduced-motion:reduce) { html { scroll-behavior:auto; } }
`;
