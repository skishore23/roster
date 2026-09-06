import assert from "node:assert/strict";
import test from "node:test";

import {
  landingPageHtml,
  landingSecurityHeaders,
} from "../../src/views/landing.ts";

test("marketing landing page explains the AI practice room without the world metaphor", () => {
  const nonce = "landing-test-nonce";
  const page = landingPageHtml(nonce);

  assert.match(page, /<title>Roster Lab — A safe place for your AI to make mistakes<\/title>/);
  assert.match(page, /<main id="main">/);
  assert.match(page, /Let your AI make mistakes/);
  assert.match(page, /We let the AI practice the same job again and again/);
  assert.match(page, /What is one thing your AI must never do twice/);
  assert.match(page, /data-scene-step="base"/);
  assert.match(page, /data-scene-step="branch"/);
  assert.match(page, /data-scene-step="fault"/);
  assert.match(page, /data-scene-step="replay"/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /prefers-reduced-motion:reduce/);
  assert.match(page, /script nonce="landing-test-nonce"/);
  assert.match(page, /style nonce="landing-test-nonce"/);
  assert.doesNotMatch(page, /Effect fence \+ monotonic lease/);
  assert.doesNotMatch(page, /Introduce labeled entropy/);
  assert.doesNotMatch(page, /No faux determinism/);
  assert.doesNotMatch(page, /execution worlds|real-world|parallel worlds/i);
  assert.doesNotMatch(page, /<img\b/);
});

test("marketing landing page security policy admits only its intentional assets", () => {
  const headers = landingSecurityHeaders("landing-test-nonce");
  const policy = headers["Content-Security-Policy"] ?? "";

  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src 'self' 'nonce-landing-test-nonce'/);
  assert.match(policy, /style-src 'self' 'nonce-landing-test-nonce' https:\/\/fonts\.googleapis\.com/);
  assert.match(policy, /font-src 'self' https:\/\/fonts\.gstatic\.com/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
});
