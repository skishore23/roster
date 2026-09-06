import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const COOKIE = "roster_session";
const SESSION_MS = 8 * 60 * 60 * 1_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const equalSecret = (left: string, right: string): boolean => timingSafeEqual(
  createHash("sha256").update(left).digest(),
  createHash("sha256").update(right).digest(),
);

export const validRosterApiToken = (
  authorization: string | undefined,
  token = process.env.ROSTER_API_TOKEN,
): boolean => Boolean(token && authorization?.startsWith("Bearer ")
  && equalSecret(authorization.slice(7), token));

export const rosterHttpConfiguration = (env: NodeJS.ProcessEnv = process.env): {
  readonly hostname: string;
  readonly publicOrigin?: string;
} => {
  const hostname = env.ROSTER_HTTP_HOST?.trim() || "127.0.0.1";
  const publicOrigin = env.ROSTER_PUBLIC_ORIGIN?.trim();
  if (!LOOPBACK_HOSTS.has(hostname) && (!env.ROSTER_API_TOKEN || !publicOrigin)) {
    throw new Error("Remote HTTP binding requires ROSTER_API_TOKEN and ROSTER_PUBLIC_ORIGIN");
  }
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== publicOrigin) {
      throw new Error("ROSTER_PUBLIC_ORIGIN must be an exact HTTP(S) origin");
    }
  }
  return { hostname, ...(publicOrigin ? { publicOrigin } : {}) };
};

const signature = (token: string, origin: string, expiry: string): string =>
  createHmac("sha256", token).update(`roster.http-session.v1\n${origin}\n${expiry}`).digest("base64url");

const sessionValid = (cookie: string | undefined, token: string, origin: string, now: number): boolean => {
  const value = cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value) return false;
  const [expiry, mac, extra] = value.split(".");
  const expiresAt = Number(expiry);
  return extra === undefined && Boolean(mac) && Number.isSafeInteger(expiresAt)
    && expiresAt > now && expiresAt <= now + SESSION_MS
    && equalSecret(mac!, signature(token, origin, expiry!));
};

// The native handoff carries its secret in a fragment, never a request URL.
// Clear it before exchanging it for an origin-bound HttpOnly cookie.
const loginPage = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Open Roster</title>
<h1>Open Roster</h1><form><label>Access token <input name="token" type="password" autocomplete="off" required></label>
<button>Open workspace</button></form><p role="status"></p>
<script>
const form = document.querySelector('form');
const status = document.querySelector('[role=status]');
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', '/auth');
async function connect(value) {
  const response = await fetch('/auth', {method: 'POST', headers: {Authorization: 'Bearer ' + value}});
  if (response.ok) location.replace('/');
  else status.textContent = 'The access token was not accepted.';
}
form.addEventListener('submit', event => { event.preventDefault(); void connect(form.elements.token.value); });
if (token) void connect(token);
</script></html>`;
const loginScript = loginPage.split("<script>")[1]!.split("</script>")[0]!;
const scriptHash = createHash("sha256").update(loginScript).digest("base64");

/** One authority for browser and API requests; domain routes retain scope checks. */
export const createRosterHttpAccess = (options: {
  readonly environment?: () => NodeJS.ProcessEnv;
  readonly now?: () => number;
} = {}): MiddlewareHandler => async (c, next) => {
  const env = options.environment?.() ?? process.env;
  const configuration = rosterHttpConfiguration(env);
  const url = new URL(c.req.url);
  const origin = configuration.publicOrigin ?? url.origin;
  // A TLS-terminating proxy can forward HTTP locally. Only the explicitly
  // configured origin sets browser authority; forwarded headers are not trusted.
  if (configuration.publicOrigin ? url.host !== new URL(origin).host : !LOOPBACK_HOSTS.has(url.hostname)) {
    return c.text("Unrecognized request host", 403);
  }
  const requestOrigin = c.req.header("Origin");
  const fetchSite = c.req.header("Sec-Fetch-Site");
  if (fetchSite === "cross-site" || (requestOrigin !== undefined && requestOrigin !== origin)) {
    return c.text("Cross-origin requests are not allowed", 403);
  }
  const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  // Browser same-site requests can originate on another port/subdomain.
  if (!safeMethod && fetchSite && fetchSite !== "same-origin") {
    return c.text("Browser changes require the workspace origin", 403);
  }
  const token = env.ROSTER_API_TOKEN;
  const now = options.now?.() ?? Date.now();
  const authorization = c.req.header("Authorization");
  const bearer = validRosterApiToken(authorization, token);
  if (c.req.path === "/auth") {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", `default-src 'none'; script-src 'sha256-${scriptHash}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    if (c.req.method === "GET") return c.html(loginPage);
    if (c.req.method !== "POST" || !bearer || !token) return c.text("Unauthorized", 401);
    const expiry = String(now + SESSION_MS);
    c.header("Set-Cookie", `${COOKIE}=${expiry}.${signature(token, origin, expiry)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1_000}${new URL(origin).protocol === "https:" ? "; Secure" : ""}`);
    return c.json({ ok: true });
  }
  const probe = safeMethod && ["/healthz", "/readyz"].includes(c.req.path);
  if (!probe && token && !bearer
    && (authorization !== undefined || !sessionValid(c.req.header("Cookie"), token, origin, now))) {
    c.header("Cache-Control", "no-store");
    c.header("WWW-Authenticate", "Bearer");
    return c.text("Unauthorized. Open /auth to sign in.", 401);
  }
  await next();
};
