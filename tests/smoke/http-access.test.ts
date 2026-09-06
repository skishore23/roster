import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createRosterHttpAccess, rosterHttpConfiguration } from "../../src/runtime/http-access.ts";

test("local server binds only to loopback and remote configuration fails closed", async () => {
  assert.equal(rosterHttpConfiguration({}).hostname, "127.0.0.1");
  assert.throws(() => rosterHttpConfiguration({ ROSTER_HTTP_HOST: "0.0.0.0" }), /requires/);
  assert.throws(() => rosterHttpConfiguration({ ROSTER_HTTP_HOST: "0.0.0.0", ROSTER_API_TOKEN: "secret" }), /requires/);
  const server = serve({ fetch: () => new Response("ok"), port: 0, ...rosterHttpConfiguration({}) });
  try {
    await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "127.0.0.1");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("browser and API routes share authentication, session expiry and origin protection", async () => {
  let now = 1_000;
  const env = { ROSTER_API_TOKEN: "launch-secret" };
  let mutations = 0;
  const app = new Hono();
  app.use("*", createRosterHttpAccess({ environment: () => env, now: () => now }));
  app.get("*", (c) => c.text("private repository"));
  app.post("*", (c) => { mutations += 1; return c.json({ ok: true }); });
  for (const path of ["/coding", "/coding/workspaces/browse", "/coding/runs/run/collaboration.md", "/api/v2/coding/runs", "/jobs", "/memory/scopes"]) {
    assert.equal((await app.request(path)).status, 401, path);
    assert.equal((await app.request(path, { headers: { Authorization: "Bearer launch-secret" } })).status, 200, path);
  }
  assert.equal((await app.request("/readyz")).status, 200);
  const login = await app.request("/auth");
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("referrer-policy"), "no-referrer");
  assert.match(login.headers.get("content-security-policy")!, /sha256-/);
  const connected = await app.request("/auth", { method: "POST", headers: { Authorization: "Bearer launch-secret", Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" } });
  assert.equal(connected.status, 200);
  const cookie = connected.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.ok(!cookie.includes(env.ROSTER_API_TOKEN));
  assert.equal((await app.request("/coding", { headers: { Cookie: cookie } })).status, 200);
  for (const headers of [
    { Origin: "https://untrusted.example" },
    { Origin: "http://localhost:9999" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site" },
  ]) {
    const response = await app.request("/coding/run", { method: "POST", headers: { Cookie: cookie, ...headers } });
    assert.equal(response.status, 403);
  }
  assert.equal(mutations, 0);
  assert.equal((await app.request("/coding/run", { method: "POST", headers: { Cookie: cookie, Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" } })).status, 200);
  assert.equal(mutations, 1);
  assert.equal((await app.request("http://localhost:9999/coding", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await app.request("http://rebound.example/coding", { headers: { Cookie: cookie } })).status, 403);
  env.ROSTER_API_TOKEN = "replacement-secret";
  assert.equal((await app.request("/coding", { headers: { Cookie: cookie } })).status, 401);
  env.ROSTER_API_TOKEN = "launch-secret";
  now += 8 * 60 * 60 * 1_000;
  assert.equal((await app.request("/coding", { headers: { Cookie: cookie } })).status, 401);
});

test("local trust still rejects cross-origin browser mutations and rebinding", async () => {
  const app = new Hono();
  app.use("*", createRosterHttpAccess({ environment: () => ({}) }));
  app.all("*", (c) => c.text("ok"));
  assert.equal((await app.request("/coding/run", { method: "POST" })).status, 200);
  assert.equal((await app.request("/coding/run", { method: "POST", headers: { Origin: "null" } })).status, 403);
  assert.equal((await app.request("http://rebound.example/coding")).status, 403);
});

test("configured public origin supports TLS termination without trusting forwarded headers", async () => {
  const app = new Hono();
  app.use("*", createRosterHttpAccess({ environment: () => ({
    ROSTER_HTTP_HOST: "0.0.0.0", ROSTER_PUBLIC_ORIGIN: "https://roster.example", ROSTER_API_TOKEN: "secret",
  }) }));
  app.all("*", (c) => c.text("ok"));
  const headers = { Authorization: "Bearer secret", Origin: "https://roster.example" };
  const response = await app.request("http://roster.example/auth", { method: "POST", headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie")!, /; Secure/);
  assert.equal((await app.request("http://roster.example/coding", { method: "POST", headers })).status, 200);
  assert.equal((await app.request("http://untrusted.example/coding", { headers: { ...headers, "X-Forwarded-Host": "roster.example" } })).status, 403);
  assert.equal((await app.request("http://roster.example/coding", { method: "POST", headers: { ...headers, Origin: "http://roster.example" } })).status, 403);
});
