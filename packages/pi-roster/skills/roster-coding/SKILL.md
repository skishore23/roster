---
name: roster-coding
description: Use an attached Roster coding run from Pi while keeping Roster authoritative for orchestration, receipts, budgets, topology, Git frontiers, conflicts, and certification.
---

# Roster coding from Pi

Use this skill when the user asks Pi to start, inspect, steer, or stop a Roster
coding run.

## Commands

- `/roster-scan` reviews the bounded repository shape and saves its logical specialist team. Pi also offers this once on the first connected session.
- `/roster-code [--fast|--reviewed|--auto] [--pi|--codex|--claude|--hermes] <objective>` starts a run for the current working directory.
- `/roster-runs` records a durable, UI-only list of recent runs in the Pi session.
- `/roster-attach <run-id>` attaches this Pi session to an existing run.
- `/roster-steer <message>` submits a durable steering command to Roster.
- `/roster-diff` records Roster's bounded run diff summary as UI-only output.
- `/roster-abort` asks for confirmation, then requests cancellation. In a
  non-UI mode, the explicit form is `/roster-abort --yes`.

`/roster-code` defaults to `--auto --pi`. Use `--fast` only for narrow
low-risk text or documentation changes where one worker is enough. Use
`--reviewed` when the operator wants Codex supervisor consensus regardless of
automatic risk classification. Use `--codex` for a Codex CLI mutation worker
or `--claude` for one Claude Code mutation worker, or `--hermes` for one Hermes
Agent mutation worker; Codex Sol/high remains the
review runtime. Pi-specific model, extension, skill, and tool policy are server
configuration, not ad hoc command arguments.

The workspace must have a saved team before `/roster-code` starts a change.
Saved node identities are reused across conversations; Pi, Codex, and Claude
processes remain replaceable runtime bindings for individual tasks.

## Authority boundary

Treat Pi as a control surface. Do not recreate a task graph, spawn replacement
workers, choose artifact winners, certify a diff, or infer completion from Pi
session state. Roster's versioned JSON API and durable receipts are authoritative.
The Pi attachment entry stores only the run ID and API location needed to resume
the UI. Git remains authoritative for source trees and large artifacts.
Roster executes each coding run on a durable `roster/<run-id>` branch and commits
only a certified delta. The operator's current branch is never changed.

Steering is advisory input submitted to Roster; it is not direct instruction to
a particular process or model. An abort command is a cancellation request and
is complete only when the Roster run projection reports a terminal state.
