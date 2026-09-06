# Contributing to Roster

Start with the [README](README.md) and [repository guide](docs/repository-guide.md).
For bugs, include reproduction steps, expected and actual behavior, OS, Node and
SpacetimeDB versions, and a small sanitized example. Never attach credentials,
private repository contents, or complete agent transcripts to a public issue.

## Development

Use Node.js 22.19 or newer and SpacetimeDB CLI 2.6.1. Install locked dependencies:

```bash
npm ci
npm --prefix spacetimedb ci
npm --prefix packages/pi-roster ci
```

Follow the local startup instructions in the README. Keep one logical change per
pull request. Read the nearest domain, reducer, runtime, view, and smoke test
before editing. `AGENTS.md` and the repository's workspace-node skill document
architecture constraints for both human and automated contributions.

Run targeted tests while iterating, then `npm run verify` before submitting.
Changes to the Pi integration also require its tests and typecheck. Desktop
changes require `npm --prefix apps/desktop ci` and `npm run desktop:verify` on a
machine with Rust and Tauri prerequisites. Explain any checks you could not run.

A pull request should describe the problem, resulting behavior, and relevant
validation. Update public contract documentation when a node, runtime,
authorization, or task boundary changes. Generated bindings are produced by the
repository's generation script; browser bundles and installers are build outputs.

## Project boundaries

- A workspace node owns durable identity; processes and sandboxes are replaceable.
- Roster owns scheduling, topology, budgets, receipts, and acceptance.
- Runtime adapters own inner-loop execution.
- Preserve explicit conflicts and exact artifact provenance.
- Bound concurrency, retries, task expansion, context, time, and cost.

Do not commit `.env` files, tokens, private deployment configuration, generated
studies, recordings, or installers. Contribution of code and documentation is
under the existing [MIT license](LICENSE); retain third-party attribution and
only contribute material you have the right to share.

Please be respectful, make criticism specific to the work, and keep discussions
focused on reproducible behavior and evidence. Report security issues through
[the private disclosure process](SECURITY.md), not a public bug report.
