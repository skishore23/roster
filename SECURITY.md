# Security policy

Roster is an early preview for a single trusted operator. Use the current main
branch for security fixes; there is no supported long-term release series yet.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/skishore23/roster/security/advisories/new).
If that form is unavailable, contact the maintainer through their
[GitHub profile](https://github.com/skishore23) to arrange a private channel before
sharing exploit details. Do not open a public issue containing a credential,
private repository data, or an unpatched exploit.

Include the affected commit, reproduction steps, impact, and sanitized evidence.
There is no published response-time guarantee or bug bounty.

## Deployment boundary

The server binds to loopback by default. Authentication protects pages and APIs
when `ROSTER_API_TOKEN` is set; desktop bootstraps a token for each launch.
Use TLS and an explicit public origin for remote access. This is not a
multi-tenant service, and authentication does not sandbox untrusted local
processes or providers. Runtime tools may read or modify the selected repository
within their execution grant and configured sandbox.

Keep provider credentials and SpacetimeDB identity files outside version control.
If a credential is exposed, revoke or rotate it before removing the visible copy;
Git history and existing clones may retain it.
