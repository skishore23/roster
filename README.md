# Roster

A workspace for coordinating coding agents around one reviewed change.

Roster gives Codex, Claude, Pi, Hermes, and custom runtimes durable tasks,
shared context, bounded execution, and an auditable path from proposed output
to accepted work. A logical workspace node keeps its identity when its runtime
or worktree changes.

**Status:** early developer preview for a single trusted operator. The repository
includes the TypeScript SDK, browser application, desktop shell, SpacetimeDB
module, and reference workflows for coding, writing, visual composition, and
proof search. Shared application-user permissions and tenant isolation are not
implemented.

- [Get started](#run-locally)
- [Architecture](docs/production-architecture.md)
- [Create an agent or roster](docs/create-agent.md)
- [Contribute](CONTRIBUTING.md)
- [Report a security issue](SECURITY.md)

## Run locally

Requirements: Node.js **22.19 or newer**, npm, Git, and the
[SpacetimeDB CLI](https://spacetimedb.com/install) pinned to **2.6.1**. Coding
runtimes need their own installed CLI and authentication. Native model-backed
examples use `OPENAI_API_KEY`; deterministic tests do not require paid model calls.

```bash
git clone https://github.com/skishore23/roster.git
cd roster
npm ci
npm --prefix spacetimedb ci
spacetime version install 2.6.1 --use --yes
cp .env.example .env
npm run cli -- up
```

Open [Roster Coding](http://127.0.0.1:8787/coding). The `up` command starts a local
database when needed, builds and publishes the local module, builds Roster,
and supervises the server. Stop it with Ctrl+C.

The HTTP listener defaults to loopback. Set `ROSTER_API_TOKEN` in `.env` to
require authentication and sign in at `/auth`. Remote binding requires both an
API token and `ROSTER_PUBLIC_ORIGIN`; see
[HTTP access](docs/production-architecture.md#http-access).

Packages are currently consumed from this source checkout. The unscoped npm
name `roster` belongs to another project; **do not install it from npm** expecting
this application. Package publication stays disabled until an owned namespace
is selected. `npm run cli -- …` works without a global installation.

## What Roster owns

| Responsibility | Mechanism |
| --- | --- |
| Task dependencies, retries, leases, budgets, and acceptance | Durable SpacetimeDB reducers and receipts |
| Independently authored findings, proposals, and conflicts | Bounded Yjs shared-workspace entries |
| Source changes and large artifacts | Git worktrees, commits, and artifact references |
| Model or command execution | Replaceable runtime adapters |

Runtime adapters execute one bounded turn. They do not decide topology,
scheduling, artifact acceptance, or certification. Compatible contributions can
merge; conflicting decisions remain explicit until the domain resolves them.

See [Workspace nodes](docs/workspace-nodes.md) for the public contract and
[Dynamic agent platform](docs/dynamic-agent-platform.md) for the task graph.

## Create an agent

```bash
npm run cli -- new my-agent --template basic
npm run cli -- new research-roster --template adaptive-graph
```

The first command generates a receipt-driven agent. The second generates a
bounded roster with named nodes, capabilities, and a root task. Public APIs are
exported through `roster/authoring`, `roster/orchestration`, `roster/workspace`,
`roster/runtime`, and `roster/capabilities` within the built package.

[The authoring guide](docs/create-agent.md) covers custom handlers, acceptance,
headless runs, and consumer projects.

## Desktop

```bash
npm --prefix apps/desktop ci
npm run desktop:dev
```

Desktop development starts an isolated local control plane. Self-built release
apps also default to local configuration. A remote deployment must be explicitly
configured by its operator; this checkout does not connect to a maintainer's
production database by default.

See [Desktop development and packaging](apps/desktop/README.md) for Rust/Tauri
requirements and build instructions. Generated installers belong in release
assets, not the source repository.

## Verify

```bash
npm --prefix packages/pi-roster ci
npm run verify
npm --prefix packages/pi-roster test
npm --prefix packages/pi-roster run typecheck
npm run desktop:verify
```

`npm run verify` creates an isolated local SpacetimeDB instance, checks module
upgrades, builds the application, checks architecture boundaries, and runs the
deterministic and smoke suites. Desktop verification additionally requires Rust
and platform prerequisites. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository map

| Directory | Contents |
| --- | --- |
| `src/sdk` | Public authoring and runtime APIs |
| `src/engine` | Orchestration, execution, shared workspace, and artifact contracts |
| `src/agents`, `src/domains` | Applications and domain-specific acceptance |
| `src/adapters` | Control-plane and provider integrations |
| `src/browser`, `src/views` | Browser clients and server-rendered views |
| `spacetimedb` | Durable tables, reducers, views, and authorization |
| `apps/desktop` | Tauri shell and packaged sidecar |
| `packages/pi-roster` | Pi integration |
| `tests`, `docs` | Verification and contributor documentation |

Research runners are included, but generated study outputs, private run
recordings, and installers are not shipped. See [the documentation index](docs/README.md)
for the reference workflows and evaluation methods.

## License

Roster's source is available under the [MIT license](LICENSE). Existing copyright
attribution is retained. Dependencies and external runtimes have their own
licenses; in particular, the SpacetimeDB server is licensed separately from its
TypeScript SDK. See [third-party notices](THIRD_PARTY_NOTICES.md).
