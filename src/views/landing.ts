import { esc } from "./agent-framework.js";
import { landingCss } from "./landing-style.js";

const REPOSITORY = "https://github.com/skishore23/roster";

const workflow = [
  { label: "Choose a repository", detail: "Open a local Git repository and select the coding agents you have installed." },
  { label: "Describe the change", detail: "Give the room a task. Roster coordinates bounded work and retains the shared context." },
  { label: "Follow the work", detail: "Read agent updates, inspect tasks, and add guidance when the work needs your attention." },
  { label: "Review and merge", detail: "Inspect the diff and verification evidence. Merge the certified commit into your local target branch when ready." },
] as const;

export const landingPageHtml = (nonce: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#11120f" />
  <meta name="description" content="Coordinate coding agents around one reviewed change. Local repositories, durable tasks, shared context, and explicit review." />
  <meta property="og:title" content="Roster — Coding agents, working together" />
  <meta property="og:description" content="A shared workspace for coding agents, from the first task to a reviewed change." />
  <meta property="og:type" content="website" />
  <title>Roster — Coding agents, working together</title>
  <style nonce="${esc(nonce)}">${landingCss}</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="/" aria-label="Roster home"><span aria-hidden="true">r.</span>Roster</a>
    <nav aria-label="Primary navigation">
      <a href="#workflow">How it works</a>
      <a href="${REPOSITORY}#run-locally">Docs</a>
      <a class="button small" href="/coding">Open Coding <span aria-hidden="true">↗</span></a>
    </nav>
  </header>
  <main id="main" tabindex="-1">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> Open source · Developer preview</p>
        <h1 id="hero-title">Coding agents.<br /><span>Working together.</span></h1>
        <p class="intro">One workspace for your repository, your agents, and the change you want to make. Follow the work from the first task to a reviewed diff.</p>
        <div class="actions"><a class="button primary" href="/coding">Open coding workspace <span aria-hidden="true">→</span></a><a class="button" href="${REPOSITORY}">View source</a></div>
        <p class="preview-note">An early preview for a single trusted operator. Runs locally with your own coding agents and their authentication.</p>
      </div>
      <figure class="workflow-preview" aria-labelledby="preview-title">
        <figcaption><span class="eyebrow">The coding workflow</span><strong id="preview-title">One change. A shared path to review.</strong></figcaption>
        <ol>
          <li><span class="step-mark" aria-hidden="true">01</span><div><strong>Your repository</strong><p>Source, context, and a target branch</p></div><span class="flow-tag">Git</span></li>
          <li><span class="step-mark" aria-hidden="true">02</span><div><strong>Your agents</strong><p>Selected runtimes with bounded tasks</p></div><span class="flow-tag">Roster</span></li>
          <li><span class="step-mark" aria-hidden="true">03</span><div><strong>A proposed change</strong><p>Updates, a diff, and verification evidence</p></div><span class="flow-tag">Review</span></li>
          <li><span class="step-mark" aria-hidden="true">04</span><div><strong>Your decision</strong><p>Merge locally or keep the branch</p></div><span class="flow-tag">You</span></li>
        </ol>
        <p class="diagram-note">Workflow illustration · your live runs appear in Coding</p>
      </figure>
    </section>
    <section class="runtime-strip" aria-label="Supported coding runtimes">
      <p>Bring the agents you already use</p><ul><li>Codex</li><li>Claude</li><li>Pi</li><li>Hermes</li><li>Custom runtimes</li></ul>
    </section>
    <section class="section" id="workflow" aria-labelledby="workflow-title">
      <div class="section-heading"><p class="eyebrow">From repository to review</p><h2 id="workflow-title">Keep the whole change in view.</h2><p>Roster coordinates the work around your agents. You choose the repository, follow progress, and review the result.</p></div>
      <ol class="workflow-grid">${workflow.map((step, index) => `<li><span class="step-number">0${index + 1}</span><h3>${esc(step.label)}</h3><p>${esc(step.detail)}</p></li>`).join("")}</ol>
    </section>
    <section class="section capabilities" aria-labelledby="capabilities-title">
      <div class="section-heading"><p class="eyebrow">A workspace with a memory</p><h2 id="capabilities-title">Context stays with the work.</h2></div>
      <div class="capability-grid">
        <article><h3>Shared context</h3><p>Tasks, findings, and decisions stay connected to the run, even when the executing runtime changes.</p></article>
        <article><h3>Bounded execution</h3><p>Task dependencies, retries, leases, and budgets are part of coordination. Progress and failures remain visible.</p></article>
        <article><h3>Explicit handoff</h3><p>Review the proposed code and its evidence before merging. Integration fast-forwards the certified commit locally; it does not push it.</p></article>
      </div>
    </section>
    <section class="section get-started" id="get-started" aria-labelledby="start-title">
      <div class="section-heading"><p class="eyebrow">Start on your machine</p><h2 id="start-title">Your repository.<br />Your local workspace.</h2><p>Use Node.js 22.19 or newer and SpacetimeDB CLI 2.6.1. Install and authenticate the coding runtime you want to use.</p><a class="text-link" href="${REPOSITORY}#run-locally">Full setup instructions <span aria-hidden="true">↗</span></a></div>
      <div class="setup"><pre tabindex="0" aria-label="Local setup commands"><code>git clone https://github.com/skishore23/roster.git
cd roster
npm ci
npm --prefix spacetimedb ci
spacetime version install 2.6.1 --use --yes
cp .env.example .env
npm run cli -- up</code></pre><p>Then open <code>http://127.0.0.1:8787/coding</code>. Packages are currently consumed from source.</p></div>
    </section>
    <section class="section questions" aria-labelledby="questions-title">
      <div class="section-heading"><p class="eyebrow">Before you start</p><h2 id="questions-title">What is in this preview?</h2></div>
      <div class="question-list">
        <details><summary>Does Roster replace my coding agent?</summary><p>No. Codex, Claude, Pi, Hermes, or a custom runtime executes the coding work. Roster owns the surrounding tasks, shared context, progress, and review workflow.</p></details>
        <details><summary>Is this a hosted team service?</summary><p>This release is for a single trusted operator. Shared application-user permissions and tenant isolation are not implemented. The browser app and desktop shell use an operator-configured control plane.</p></details>
        <details><summary>What are the other rooms?</summary><p>Writer, Canvas, and the proof workflows are reference examples of the coordination framework. <a href="/monitor">Browse the rooms</a> or read the <a href="${REPOSITORY}/blob/main/docs/README.md">example documentation</a>. <a href="/simulations">Simulations</a> are developer tools for testing coordination behavior.</p></details>
        <details><summary>How is the source licensed?</summary><p>Roster source is MIT licensed. Dependencies and external runtimes have separate terms, including the SpacetimeDB server. Read the <a href="${REPOSITORY}/blob/main/THIRD_PARTY_NOTICES.md">third-party notices</a>.</p></details>
      </div>
    </section>
  </main>
  <footer class="site-footer"><a class="brand" href="/" aria-label="Roster home">Roster</a><p>Coding agents, working together.</p><nav aria-label="Project links"><a href="${REPOSITORY}">GitHub</a><a href="${REPOSITORY}/blob/main/CONTRIBUTING.md">Contribute</a><a href="${REPOSITORY}/security/advisories/new">Report a vulnerability</a></nav></footer>
</body>
</html>`;

export const landingSecurityHeaders = (nonce: string): Readonly<Record<string, string>> => ({
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'none'",
    `style-src 'self' 'nonce-${nonce}'`,
  ].join("; "),
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});
