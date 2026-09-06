# Roster Desktop

This directory is an isolated Tauri v2 shell for Roster's repository agent. It
does not make the renderer a second orchestration authority:

- SpacetimeDB remains the durable coordination authority.
- The bundled runtime owns local repository access and agent process execution.
- The renderer receives only a native directory picker and narrow Rust
  commands; it cannot execute arbitrary shell commands.
- A workspace node remains distinct from the replaceable local process that
  executes it.

The packaged sidecar is fail-closed to the repository surface. It registers
only the `coding-agent` route module, claims only `coding-agent` jobs, serves
only `/coding`, `/api/v2/coding/*`, their required scripts, and health probes,
and an `/auth` session bootstrap, and redirects `/` to `/coding`. Proof, Writer, Canvas, inspector, simulation,
generic job, memory, and improvement HTTP surfaces are unavailable in the
desktop package. Shared engine code remains an implementation dependency; it
does not create another product route or worker authority.

The native shell creates a fresh 256-bit access token for every sidecar launch.
It opens `/auth` with a token fragment, which is cleared before exchanging the
token for an origin-bound HttpOnly cookie. The HTTP listener binds only to
loopback and rejects cross-origin browser mutations. Every private route
requires the session or bearer token, including repository pages and streams.

Automatic resume preserves the saved default runtime and complete runtime
selection. If any saved runtime disappears or fails its readiness probe, the
runtime picker stays open so the operator can select the available runtimes.

## Prerequisites

- Node.js 22.19 or newer (also required by the packaged Roster runtime)
- Rust 1.77.2 or newer
- Tauri's platform prerequisites
- A local SpacetimeDB server for development, or a published Maincloud module

Install and validate the frontend/configuration:

```bash
npm install
npm run test
npm run build:web
npm run test:native
npm run tauri:info
```

`npm run verify` runs the deterministic frontend/configuration and native Rust
tests. `tauri info` remains an environment diagnostic because missing optional
platform tooling must not turn an otherwise valid desktop build into a hanging
test gate.

Run a local SpacetimeDB and publish the module without consuming Maincloud
credits:

```bash
spacetime start
npm run spacetime:publish:local
```

Then run the desktop application. Development builds select the local backend
internally:

```bash
npm run tauri:dev
```

The staging task builds Roster, copies the current Node executable as a
target-named Tauri sidecar, and installs locked production dependencies into
the signed resource tree. Users do not need Node.js after installation.

Publish the production module and create the installer:

```bash
npm run spacetime:publish:production
npm run tauri:build
```

Both development and self-built release apps default to the local backend:
`http://127.0.0.1:3000`, database `roster-local`. To use your own remote backend,
set `ROSTER_SPACETIME_MODE=production` and provide both
`ROSTER_SPACETIME_PRODUCTION_URI` and `ROSTER_SPACETIME_PRODUCTION_DATABASE`.
Production mode fails closed when either is absent. Local overrides are
`ROSTER_SPACETIME_LOCAL_URI` and `ROSTER_SPACETIME_LOCAL_DATABASE`.

`npm run spacetime:publish:production` reads those explicit production variables
(and the root `.env` when invoked there). It never selects a maintainer database
and retains the SpacetimeDB CLI's own publish confirmation.

`ROSTER_NODE_BIN` can explicitly select a Node executable for cross-platform
release packaging. If omitted, staging uses the current absolute
`process.execPath`.

## Identity and onboarding

Roster does not require a username or password. On first launch it creates a
random 192-bit installation id for display and workspace namespacing.
SpacetimeDB independently issues the anonymous identity token used to
authenticate reducer calls. Identity tokens are stored separately per
control-plane URI and database, so switching between local development and
Maincloud cannot reuse an incompatible token. These values are persisted in
the application data directory with owner-only permissions; no hardware
identifiers are read.

Onboarding:

1. Canonicalizes the selected folder and requires the exact Git root.
2. Looks for Codex, Claude Code, Pi, and Hermes using fixed executable names.
3. Runs only bounded `--version` probes and never reads agent credentials.
4. Asks the user which installed adapters join this repository.
5. Starts the existing Roster coding runtime on a random loopback port.

After the first successful launch, Roster reads the saved onboarding document,
revalidates the exact Git root, rediscovers the saved runtime IDs, and opens the
room automatically with the same explicitly selected default agent. If the
repository moved or a selected runtime disappeared,
the app keeps onboarding available instead of trusting stale paths or commands.

The shell reuses a running sidecar only when the repository, complete selected
agent roster, default agent, SpacetimeDB URI, and database are unchanged and the
sidecar's `/readyz` response confirms an attached control plane. A TCP listener
alone is never treated as application readiness; stale or differently configured
sidecars are terminated and replaced. Normal application exit explicitly stops
the sidecar, while a parent-process watchdog also stops it after a crash or forced
termination so repository access cannot outlive the desktop application.

The saved desktop profile is provider-neutral configuration, not a workspace
node, lease, process, session, worktree, or credential. Adding another agent
requires a discovery descriptor plus a runtime adapter; the node and
orchestration contracts do not change.

## Distribution

Release CI must provide one signed runtime executable per target, stage it
before `tauri build`, and then sign/notarize the final installer. Automatic
updates are deliberately disabled until a signed update endpoint and public
key are configured; shipping an unsigned updater is not a production fallback.

Anonymous identity removes account friction, not abuse risk. A public
Maincloud deployment still needs service-side quotas, enrollment throttles,
observability, and a recovery/export path before broad distribution. Deleting
the local token intentionally creates a new identity.
