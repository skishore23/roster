import assert from "node:assert/strict";
import test from "node:test";

import {
  landingPageHtml,
  landingSecurityHeaders,
} from "../../src/views/landing.ts";

test("landing page leads with the implemented local Coding workflow", () => {
  const nonce = "landing-test-nonce";
  const page = landingPageHtml(nonce);

  assert.match(page, /<title>Roster — Coding agents, working together<\/title>/);
  assert.match(page, /<main id="main" tabindex="-1">/);
  assert.match(page, /href="\/coding">Open coding workspace/);
  assert.match(page, /href="https:\/\/github.com\/skishore23\/roster">View source/);
  assert.match(page, /Workflow illustration/);
  assert.match(page, /single trusted operator/);
  assert.match(page, /tenant isolation are not implemented/);
  assert.match(page, /npm run cli -- up/);
  assert.match(page, /Review and merge/);
  assert.match(page, /Reference examples|reference examples/);
  assert.match(page, /prefers-reduced-motion:reduce/);
  assert.match(page, /style nonce="landing-test-nonce"/);
  assert.doesNotMatch(page, /Roster Lab|refund|data-virtual-clock|data-world-|x\.com|<script\b/);
});

test("marketing landing page security policy admits only its intentional assets", () => {
  const headers = landingSecurityHeaders("landing-test-nonce");
  const policy = headers["Content-Security-Policy"] ?? "";

  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src 'none'/);
  assert.match(policy, /style-src 'self' 'nonce-landing-test-nonce'/);
  assert.match(policy, /font-src 'self'/);
  assert.doesNotMatch(policy, /https:|unsafe-inline|unsafe-eval/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
});
