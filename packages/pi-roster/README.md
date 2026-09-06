# @roster/pi

A Pi package that provides a terminal control surface for Roster coding runs.
Pi owns commands, session attachment, and status rendering. Roster remains the
sole authority for workspace nodes, runtime bindings, topology, task receipts,
budgets, shared frontiers, conflicts, and certification.

## Install

Pi packages execute with the user's system permissions. Review this package,
then install it from a checkout:

```bash
pi install ./packages/pi-roster
```

For one session without installation:

```bash
pi -e ./packages/pi-roster/extensions/roster.ts
```

Node 22.19 or newer and Pi 0.80.6 or a compatible later release are expected.

## Configure

The extension reads:

- `ROSTER_API_URL` — Roster server origin; defaults to `http://127.0.0.1:8787`.
- `ROSTER_API_TOKEN` — optional bearer token.

All calls use JSON with the `roster.coding.v2` schema and the `/api/v2/coding`
namespace. The expected endpoints are:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/workspace` | Read the saved repository team or onboarding state |
| `POST` | `/workspace/scan` | Review the repository and save its specialist agents |
| `POST` | `/workspace/rescans` | Queue a visible, branchless team rescan (additive async contract) |
| `POST` | `/runs` | Start a run |
| `GET` | `/runs?limit=10` | List runs |
| `GET` | `/runs/:id` | Project current run state |
| `GET` | `/diff?runId=:id` | Read the bounded run diff summary |
| `POST` | `/runs/:id/steer` | Submit steering |
| `POST` | `/runs/:id/abort` | Request cancellation |

Responses must include `schema: "roster.coding.v2"`. The extension rejects
unversioned and incompatible responses rather than guessing their meaning.

## Commands

```text
/roster-scan
/roster-code [--fast|--reviewed|--auto] [--pi|--codex|--claude|--hermes] <objective>
/roster-runs
/roster-attach <run-id>
/roster-steer <message>
/roster-diff
/roster-abort
```

`/roster-code` defaults to `--auto --pi`, which keeps narrow text and
documentation changes on the one-worker fast path and escalates broader work to
reviewer consensus. Use `--fast` to force one worker, or `--reviewed` to force
Codex Sol/high supervisor review. Use `--codex` to request a Codex mutation
worker or `--claude` to request one Claude Code mutation
worker, or `--hermes` to attach a Hermes Agent worker; server-side
`ROSTER_CODING_PI_*` and `ROSTER_CODING_HERMES_*` variables choose model, provider,
extensions, skills, and tool policy.
Roster snapshots that non-secret Pi configuration when it creates the durable
job, so queued work is not changed by a later server restart or environment edit.
Roster defaults Pi mutation workers to `openai-codex/gpt-5.6-luna` so worker runs do not
inherit an interactive Claude session by accident. Set `ROSTER_CODING_PI_MODEL`
to override that route.
Roster's curated default Pi worker extension package is `@cortexkit/aft-pi` for
AST/search/LSP-backed AFT tools. Override it with
`ROSTER_CODING_PI_EXTENSION_PACKAGES` or disable it with
`ROSTER_CODING_PI_ENABLE_DEFAULT_EXTENSIONS=0`.

`/roster-scan` uses the same Pi runtime with the curated AFT package, but fixes
the onboarding tool surface to read/search/outline/zoom, AST search, semantic
search, and LSP diagnostics. Shell and mutation tools are excluded while Roster
validates the deterministic specialist roster and saved dependency graph.

An attachment is persisted with `pi.appendEntry()` and restored from the active
Pi session branch. It contains only the run ID and API URL—never the bearer
token. Active runs are polled for UI
projection; polling stops when the session shuts down or Roster reports a
terminal state.

Roster executes each run on a `roster/<run-id>` branch, captures the run patch,
and commits it to that branch only after certification. It does not change the
operator's current branch.

## Develop

```bash
npm install
npm test
npm run typecheck
```

The package intentionally contains no scheduler, worker launcher, lease state,
or certification logic.
