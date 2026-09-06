# TeamBench pilot — 2026-07-30

## Decision

The initial pilot exposed a real cross-node frontier-composition defect. The
implemented fix then passed the same expert TeamBench task end to end:

- Before the fix, the generated solution passed 10/10 grader checks and 15/15
  tests, but Roster failed its certification contract.
- After the fix, Roster completed and the generated solution again passed
  10/10 grader checks and 15/15 tests.
- An independent host index recomputed the exact binary/full-index patch hash
  as `d6af65b7b4ed709d6d4711663e97aea8c7ff3ff2aba9f02f7fbbc92c71d638aa`,
  matching both the mutation report and the read-only certification.

This establishes **solution quality: pass; orchestration correctness after
the fix: pass** for one task and seed. It does **not** yet establish
multi-agent uplift over a compute-matched solo agent.

## Method

| Field | Value |
| --- | --- |
| TeamBench revision | `d185aef1916fd86a9ba554d581fd256319a973af` |
| Task | `CRYPTO1_nonce_reuse` |
| Difficulty | Expert in task metadata; hard in the parameterized generator |
| Seed | `0` |
| Runtime | Codex CLI |
| Model | `gpt-5.6-sol` |
| Reasoning | High |
| Roster policy | Reviewed, focused validation |
| Logical nodes | Implementation and quality |
| Initial candidate run | `20260730_083311_5e85407b` |
| Initial candidate duration | 496,826 ms |
| Fixed candidate run | `20260730_090522_85f911a5` |
| Fixed candidate duration | 384,684 ms |

The unmodified control and candidate used separate, freshly generated
workspaces. This separation matters because TeamBench graders create Python
cache files in the workspace.

The local verifier environment was normalized so `python`, `python3`, `pip`,
`pytest`, and `cryptography` resolved to one dependency-complete interpreter.
Without that normalization, the task grader silently ignores a failed
dependency install and reports missing dependencies as product failures.

## Results

| Condition | TeamBench checks | Pytest | Environment result | Roster result |
| --- | ---: | ---: | --- | --- |
| Unmodified task | 2/10 | 8 passed, 7 failed | Fail | Not applicable |
| Adaptive Roster, before fix | 10/10 | 15 passed, 0 failed | Pass | Fail |
| Adaptive Roster, after fix | 10/10 | 15 passed, 0 failed | Pass | Pass |

Both candidates modified only:

- `crypto_service/encryption.py`
- `crypto_service/key_derivation.py`
- `crypto_service/nonce.py`

It preserved the explicitly protected `crypto_service/utils.py`.

The implementation node produced a patch, the first peer review requested
changes, and the implementation node remediated them. The final source then
passed all external requirements: 12-byte random nonces, at least 100,000
PBKDF2 iterations, full 16-byte GCM tags, tamper rejection, syntax checks, and
the protected salt behavior.

## Root cause of the Roster failure

The runtime creates a private Git index and object directory for every CLI
execution. This correctly isolates concurrent workers, but before this fix the
coding composition policy asked every mutation and certification task to:

1. run `git add -A -- .`;
2. hash `git diff --cached`; and
3. return that hash as its frontier.

The remediator staged the correct worktree in its private index. The
certifier ran in a new read-only execution with a different private index. It
could read the correct source and pass nine focused tests, but it could not
stage into its private index. Its cached diff was empty, so it returned
`changes_requested` with the empty-diff SHA-256. Consensus then failed with
`At least one peer requested changes`.

This is a topology/composition defect. A logical frontier is being transported
implicitly through execution-local Git state even though runtime placement is
supposed to remain separate from logical node identity.

## Implemented fix

Keep private indexes for worker isolation and transport frontier identity
explicitly through accepted artifacts:

1. A mutation task stages only in its private index and publishes its
   provisional `frontierHash` in the accepted final report.
2. Read-only certifiers consume that exact hash as the candidate frontier
   identifier and inspect the shared worktree delta without running `git add`.
3. Repository-wide host validation supplies the candidate hash instead when
   that gate is selected.
4. Endorsements bind to the supplied candidate hash rather than reconstructing
   it from another execution-private index.
5. After graph quiescence, Roster stages the authoritative run index, freezes
   the immutable tree, recomputes the patch hash, and rejects every report or
   endorsement that does not match before the commit/ref compare-and-swap.

The regression test executes mutation and read-only certification through
distinct real private Git indexes, and the simulator now enforces the same
frontier-transport invariant. Future real benchmark runs also recompute the
authoritative host frontier after Roster returns and fail unless
`verifyCodingFrontierEvidence` accepts all reports and endorsements.

## Discovery and execution order

The TeamBench adapter discovers the repository before it executes the graph,
but this is deterministic workspace inspection rather than an unstructured
conversation among agents:

1. `inspectCodingWorkspace` scans the fixture and materializes its logical
   implementation and quality nodes.
2. `discoverCodingRepositorySkills` resolves repository-local capabilities.
3. The adapter selects implementation/review-capable nodes and chooses the
   implementation node as primary.
4. `runCodingAgent` compiles the reviewed task DAG.
5. The implementation node edits and validates the task.
6. The quality node reviews read-only and requests changes.
7. The implementation node remediates and runs the full 15-test task suite
   plus direct security and diff checks.
8. The quality node certifies read-only, using the accepted final report's
   frontier identity and running eight focused adversarial tests.
9. Roster finalizes consensus, the host verifies the authoritative frontier,
   and the external TeamBench grader runs 15 tests and 10 checks.

The agents do not dynamically invent their peers in this run. Roster first
discovers and materializes bounded logical nodes, then schedules validation
at the task stages that own it. Repository-wide host validation is a separate
policy and was not selected for this focused run.

## TeamBench quality observations

The official five-condition mock smoke completed operationally for `oracle`,
`restricted`, `full`, `team_no_plan`, and `team_no_verify`.

The upstream test suite at the pinned revision is not clean: 2,465 passed, 945
failed, and 1,031 skipped. Many failures come from inconsistent task metadata,
optional dependencies, or generator invariants. This makes task-level
quarantine mandatory.

`DIST1_queue_race` was quarantined after a real run because its grader requires
`pytest-timeout` without installing it and checks class/field names that
disagree with the task contract. The bundled historical results contain zero
passes across 38 recorded trials. A prior `CRYPTO1_nonce_reuse` trial was also
discarded because a baseline grade contaminated the candidate workspace with
generated bytecode.

## What this proves—and what it does not

It proves:

- the adapter can run Roster against a real TeamBench workspace;
- the implementation/review/remediation topology can produce a fully correct
  expert-task solution with a precise file boundary;
- a real runtime exposes a frontier-handoff defect that deterministic
  simulations missed;
- explicit frontier transport works across separate private Git indexes while
  retaining independent host recomputation; and
- benchmark harness validation must be treated as part of experimental
  correctness.

It does not prove:

- that multiple nodes outperform one strong agent;
- that the verifier improved the final score;
- reliability across tasks, seeds, or repeated trials; or
- acceptable token, cost, and latency efficiency.

The fixed run used four model turns, 1,082,241 input tokens (927,232 cached),
12,414 output tokens, and 4,745 reasoning-output tokens. Correctness is now
demonstrated for the observed topology, but that input volume is too high to
claim efficiency and should be the next optimization target.

After the frontier fix, run at least five paired trials per task for A1
(one Roster node), A2 (compute-matched strong solo), A6 (adaptive
Roster + reference-first context/RLM), and A7 (A6 without verifier). Record
pass^1, pass^2, pass^4, aggregate uncached and cached input, output/reasoning
tokens, tool calls, wall time, false approvals, false rejections, and
collateral file changes.

The machine-readable record is
`artifacts/evals/teambench-pilot-2026-07-30.json`; the raw initial and fixed
Roster runs are
`artifacts/evals/teambench-roster-crypto1-clean-2026-07-30.json` and
`artifacts/evals/teambench-roster-crypto1-frontier-fix-2026-07-30.json`.
