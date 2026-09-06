# Roster for Pi

`@roster/pi` is the terminal control surface for Roster coding runs. Pi owns the
operator experience; Roster remains authoritative for topology, tasks, receipts,
runtime bindings, budgets, Git frontiers, conflicts, and certification.

The Roster package and protocol start at v2. Earlier package names, commands,
environment variables, API discriminators, and persistence schemas are not
accepted or translated. Install `@roster/pi`, use the `/roster-*` commands and
`ROSTER_*` variables below, and create new development runs after upgrading.

## Install for local development

Install Pi 0.80.6 or later, then load the package from this checkout:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install ./packages/pi-roster
```

For a one-session smoke test without installing it:

```bash
pi --no-extensions -e ./packages/pi-roster
```

Start SpacetimeDB and Roster before launching a run. The package connects to
`http://127.0.0.1:8787` by default. Override it with `ROSTER_API_URL`. If the
server has `ROSTER_API_TOKEN` configured, provide the same value to Pi; the token
is kept in process environment only and is never written to Pi session entries.

On the first connection to a repository, open `/coding` and choose **Scan repo
and create agents**. Roster saves that repository-reviewed team once; subsequent
Pi coding commands reuse the saved logical agents and create only replaceable
runtime sessions for each change.

## Try the Coding Roster

1. Run `/roster-scan` to scan the repository and save a named specialist team.
2. Ask for a small change in Pi chat (or use `/roster-code`), then let Roster run it.
3. Review the assigned agents and models in the Pi/Roster run inspector.
4. After certification, explicitly integrate the certified local branch; it is
   not merged into your current branch automatically.

## Pi as an attached agent

The terminal package controls a Roster room; it does not imply that every
member runs through Pi. Roster authors can attach Pi to any durable member with
the public SDK while other members in the same Coding or Canvas workflow use
Codex, Claude Code, Hermes, an envelope-speaking command, A2A, or a custom
registered adapter:

```ts
import {
  attachPi,
  defineRosterMember,
  defineRuntimePlacementPolicy,
  rosterAgentRuntime,
} from "roster/runtime";

const implementer = defineRosterMember({
  id: "implementation-peer",
  name: "Mira",
  role: "implementation",
  capabilities: ["implement"],
  attachment: attachPi({
    provider: "openai",
    model: "gpt-5.6-luna",
    thinking: "high",
    projectTrust: "approve",
    tools: ["read", "edit"],
  }),
});

const placement = defineRuntimePlacementPolicy({
  version: "coding-placement-v1",
  profiles: [{
    id: "pi-write",
    label: "Pi mutation peer",
    access: ["workspace-write"],
    runtime: (context) => rosterAgentRuntime(attachPi({
      provider: "openai",
      model: "gpt-5.6-luna",
      workingDirectory: context.workingDirectory,
      projectTrust: "approve",
    })),
  }],
  select: () => ({
    profileId: "pi-write",
    reason: "Saved mutation-agent preference",
  }),
});
```

Call `resolveRuntimePlacement` when enqueueing or binding work, then apply the
result with `attachRuntimePlacement`. Persist it with
`createRuntimePlacementBinding`, which records the roster and policy versions,
profile ID, reason, runtime, topology version, and monotonic epoch. Later
environment or preference changes then affect only new work.
`NodeRuntimeProfile.available` is a UI/enqueue hint, not replay authority.

`attachPi` describes non-secret execution configuration. Pi credentials and the
trusted child-process environment stay in
`createPiAgentNodeRuntimeAdapter`/`createStandardNodeRuntimeRegistry`
construction and never enter the node, placement profile, receipt, or
`roster.node-execution.v5` envelope.

## Commands

```text
/roster-scan
/roster-code [--fast|--reviewed|--auto] [--pi|--codex|--claude] <objective>
/roster-runs
/roster-attach <run-id>
/roster-steer <message>
/roster-diff
/roster-abort
```

`/roster-scan` is the explicit version of the first-connection prompt. Roster
selects a bounded allowlisted roster from deterministic repository evidence,
then Pi loads `@cortexkit/aft-pi` with only read/search/outline/zoom,
AST-grep-search, semantic-search, and LSP diagnostic tools to discover each
specialist's structural scope and dependencies. Mutation-capable Pi tools and
shell execution are excluded from onboarding.

`/roster-code` defaults to `--auto --pi` because the command is initiated from
an active Pi session. Auto uses one selected mutation peer for
narrow low-risk text and documentation changes, and escalates to reviewed mode
when the objective mentions broader code, tests, API, data, security, runtime,
or other risky work. `--fast` forces the one-peer path. `--reviewed` runs
evidence-backed peer proposals, dependency-routed peer responses when needed,
conflict-scoped resolution, independent Codex Sol/high review, and same-frontier
endorsement. It creates no permanent lead. `--codex` binds the mutation
peer to Codex CLI; `--claude` binds it to Claude Code.

These command flags are the package's current Coding convenience surface, not
the framework's runtime-kind union. Hermes, command, A2A, and custom members are
attached through the Roster SDK and execute through the same task graph.

Pi mutation-peer model, provider, extensions, skills, and tool policy are configured
on the Roster server with `ROSTER_CODING_PI_*` environment variables, not passed
through this public command. Roster normalizes and snapshots those non-secret
values when the durable job is enqueued, so a later server restart or environment
change cannot alter a queued execution. Roster's default Pi mutation model is
`openai-codex/gpt-5.6-luna`, so mutation work does not inherit the active Pi session's
Claude model by accident. Useful local overrides are:

```bash
ROSTER_CODING_PI_MODEL=openai-codex/gpt-5.6-luna
ROSTER_CODING_PI_PROJECT_TRUST=approve
```

Qualified model IDs determine the Pi provider automatically. If
`ROSTER_CODING_PI_PROVIDER` is also set, it must match the model qualifier;
Roster rejects conflicting provider/model pairs before enqueueing the job.

Tracked repository skills are inherited automatically on every run. Put shared
skills under `.agents/skills/<name>/SKILL.md`; Roster also recognizes
provider-specific `.pi/skills`, `.codex/skills`, and `.claude/skills` trees.
Discovery happens from the exact run checkout, so existing named specialists
pick up committed skill changes on their next task without being recreated or
rescanned. `ROSTER_CODING_PI_SKILLS` remains additive for machine-local Pi
skills that do not belong in the repository.

Roster loads `@cortexkit/aft-pi` by default for Pi coding workers. That package
adds the AST/search/LSP-backed AFT tools, including structural search,
semantic search, fuzzy edits, call-graph navigation, conflict inspection,
and diagnostics. Keep this default for daily-driver coding unless the extra
tool surface is causing a package conflict.

The autonomous workspace enrichment pass records provider-neutral tool
requirements independently for each saved specialist. When a specialist later
binds to Pi, requirements such as LSP, diagnostics, structural search, or
semantic search are satisfied by this installed allowlisted package and its
package assignment is visible in the node profile. Enrichment never runs
`npm install` or
accepts a model-invented package name. Add or replace packages at the server
boundary below; repository skills and learned specialist instructions remain
separate from executable extension code.

Extension package loading is dynamic at the Roster boundary:

```bash
# Use the curated default package set. This is the default.
ROSTER_CODING_PI_ENABLE_DEFAULT_EXTENSIONS=1

# Replace the package set with specific installed Pi extension packages.
ROSTER_CODING_PI_EXTENSION_PACKAGES=@cortexkit/aft-pi,pi-shazam

# Add explicit extension entrypoints or local packages after package defaults.
ROSTER_CODING_PI_EXTENSIONS=./packages/pi-roster

# Disable curated defaults and rely only on explicit Pi config or paths.
ROSTER_CODING_PI_ENABLE_DEFAULT_EXTENSIONS=0
```

Other useful Pi code-intelligence packages available in the current ecosystem:

- `pi-lens`: real-time LSP, linter, formatter, type-checking, and structural
  feedback.
- `pi-shazam`: codebase awareness tools for overview, lookup, impact,
  verification, changes, formatting, and symbol rename.
- `pi-lsp-extension`: narrower LSP integration with diagnostics, hover,
  definitions, references, symbols, rename, completion, overview, search, and
  rewrite tools.
- `@hypabolic/pi-hypa`: context-aware compressed file/search tools for reducing
  large-output noise.

Do not enable every package by default. `@cortexkit/aft-pi` and `pi-lens`
overlap heavily around LSP and structural analysis; start with AFT, then add
one additional package only when the workflow clearly needs it.

`/roster-abort` confirms in the TUI. A non-UI invocation must explicitly pass
`--yes`. The extension restores its most recent attachment from the active Pi
session branch, polls only while that session is active, and clears its polling
loop on shutdown or reload.

## API boundary

The package consumes the versioned `/api/v2/coding` JSON API. Every response
uses `schema: "roster.coding.v2"`. The server exposes bounded task, node,
output, event, and run-scoped Git-diff projections; it never transfers
orchestration authority to Pi. The Git patch is capped at 256 KiB and reports
truncation.

There is no fallback parser or dual-write mode. Earlier session attachments and
queued runs are outside this API contract.

The server is repository-scoped. A requested working directory must resolve to
the repository in which Roster is running, preventing the control API from being
used to select an arbitrary writable directory.
Each run creates a run-scoped branch from a clean repository. Roster uses a
temporary checkout while the agents work, commits only the certified delta to
that branch, and never changes the operator's current branch.

## Development checks

```bash
npm --prefix packages/pi-roster install
npm --prefix packages/pi-roster test
npm --prefix packages/pi-roster run typecheck
(cd packages/pi-roster && npm pack --dry-run)
```

Pi extensions run with the user's full system permissions. Install this package
only from a trusted source and use Roster's sandbox or isolated checkout placement for
concurrent or untrusted mutation work.
