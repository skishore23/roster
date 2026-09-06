# Roster Outcome Evaluation Strategy

## Executive decision

Roster should not try to prove that multi-agent systems are generally better.
The evidence does not support that claim. Roster should prove a narrower,
falsifiable claim:

> For tasks with the right structure, Roster produces more verified successful
> work, or the same verified work with lower cost, latency, context exposure, or
> operational risk, than the strongest compute-matched single-agent baseline.

The primary product result is therefore not a standalone benchmark score. It is
the paired task-level delta between:

- one strong agent;
- the same agent running through one Roster node;
- adaptive Roster coordination;
- adaptive Roster coordination with reference-first context and RLM tools; and
- a compute-matched strong single agent allowed to spend the complete team
  budget.

This program must be willing to conclude that one agent is the correct
topology for a task family. Routing easy or tightly sequential work to one node
is a successful Roster result, not a failure of the multi-agent thesis.

## What the existing system already proves

The deterministic simulations, system verification, runtime acceptance, and
smoke suites prove mechanics:

- bounded task and topology growth;
- exact receipt and entropy replay;
- stale-worker fencing and runtime rebinding;
- duplicate and reordered shared-state convergence;
- explicit semantic conflicts;
- process, persistence, worktree, and desktop recovery;
- provider-neutral execution surfaces across Codex, Claude, Pi, and Hermes.

They do not establish answer quality, economic value, or uplift over one strong
agent. Those are the responsibility of this evaluation program.

## Research conclusion

Recent primary evidence is a warning against unconditional agent spawning:

- A matched-compute study across 260 configurations found results ranging from
  a large multi-agent gain on decomposable financial analysis to severe
  degradation on sequential planning. The single-agent baseline was the
  strongest robust predictor of whether coordination helped. The study matched
  prompts, tools, and per-system compute rather than giving teams free extra
  inference. See [Capable language models can outgrow the benefits of
  collaboration](https://www.nature.com/articles/s42256-026-01268-y).
- [CooperBench](https://cooperbench.com/) reports a coordination penalty when
  two coding agents must deliver independently assigned features that can
  conflict.
- [TeamBench](https://teambench.github.io/) finds that team value is
  conditional, verifier roles can add overhead, and pass rate can hide role
  collapse. Its OS-enforced separation is especially relevant to Roster's
  distinction between identity, access, execution, and certification.
- [Recursive Language Models](https://arxiv.org/abs/2512.24601) provides
  evidence that keeping large inputs in an external environment and inspecting
  them programmatically can outperform direct long-context and compaction
  baselines at comparable cost. That supports testing Roster's context
  architecture, but it does not prove Roster's implementation.
- OpenAI's 2026 audits found contamination and task-quality problems in
  SWE-bench Verified and estimated that roughly 30% of SWE-Bench Pro tasks were
  broken. Neither should be Roster's headline proof. See the
  [Verified audit](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
  and [Pro audit](https://openai.com/index/separating-signal-from-noise-coding-evaluations/).

The practical conclusion is to measure task-architecture fit. Hardness alone is
not enough. The likely winning tasks have separable work, heterogeneous
information or tools, large external context, independent evidence, or real
fault exposure.

## Claims and falsifiable hypotheses

### H1: Coordination uplift

On hard, decomposable tasks, adaptive Roster improves environment-verified
success over the compute-matched single-agent baseline.

Reject H1 for a task family if the paired confidence interval includes a
material negative result or if the gain disappears after matching total tokens
and tool calls.

### H2: One-node overhead

One Roster node preserves single-agent task quality without material
orchestration overhead.

This separates the cost of Roster's control plane from the cost of spawning a
team.

### H3: Context externalization

Reference-first context and RLM tools reduce peak model-visible context and
aggregate repeated context without reducing verified success.

Moving the same corpus into several child prompts is not a win. Aggregate input
across every model call is part of the result.

### H4: Verification value

A verifier reduces ground-truth failures more than it adds false acceptance,
false rejection, latency, and cost.

A verifier saying "pass" is not evidence. The environment grader remains
authoritative.

### H5: Durable recovery value

Under process, tool, persistence, or stale-runtime faults, Roster preserves
accepted work and completes more tasks with fewer duplicate effects than a
non-durable baseline.

This is the only claim for which fault-injected trials, rather than clean
benchmark trials, are primary evidence.

## Benchmark portfolio

No single benchmark covers these claims. Use a small portfolio, with each
benchmark owning a distinct decision.

| Priority | Benchmark | Decision it supports | Initial use |
| --- | --- | --- | --- |
| 1 | [DeepSWE](https://github.com/datacurve-ai/deep-swe) | Does Roster improve original, long-horizon repository work? | Primary coding A/B. Start with a stratified subset, then expand. |
| 1 | [TeamBench](https://teambench.github.io/) | Do separated planner, executor, and verifier roles causally help? | Preserve official ablations and add adaptive Roster as another condition. |
| 1 | [CodeScaleBench](https://github.com/sourcegraph/CodeScaleBench) | Does reference-first retrieval improve work in large and multi-repository codebases? | Compare local context, retrieval tools, RLM, and Roster composition. |
| 2 | [Terminal-Bench 2.0](https://github.com/harbor-framework/terminal-bench-2) | Does the result generalize to terminal, systems, security, and scientific workflows? | Use an audited subset through Harbor after the coding pilot. |
| 2 | [SlopCodeBench](https://arxiv.org/abs/2603.24755) | Does durable external state slow code-quality erosion across repeated change? | Run complete trajectories only after single-change uplift is understood. |
| 2 | [CooperBench](https://cooperbench.com/) | Can Roster prevent the coordination penalty on independently owned but conflicting features? | Direct two-worker collaboration diagnostic. |
| 3 | [OOLONG](https://arxiv.org/abs/2511.02817) and [BrowseComp-Plus](https://github.com/texttron/BrowseComp-Plus) | Does RLM preserve dense or multi-hop information outside the context window? | Context architecture evaluation independent of code generation. |
| 3 | [ToolSandbox](https://github.com/apple/ToolSandbox) or [AppWorld](https://appworld.dev/) | Do composable tools produce correct state without forbidden collateral effects? | Add when stateful connected-system workflows become a product focus. |
| 3 | [tau-bench](https://arxiv.org/abs/2406.12045) | Does interactive policy-following remain reliable over repeated trials? | Adopt its `pass^k` reliability framing; integrate the workload later. |

DeepSWE is currently the best primary coding benchmark because its tasks are
original, long-horizon, multi-file work with executable functional verifiers.
CodeScaleBench is the best direct fit for Roster's context claim because it
already compares coding with and without external retrieval in large and
multi-repository settings. TeamBench is the most direct public falsification
test for role composition.

SWE-bench Verified, SWE-Bench Pro, BFCL, RULER, and MultiAgentBench may be
useful compatibility or diagnostic suites. They are not primary evidence of
Roster product value.

## Roster-native benchmark

Public benchmarks are development signals and will eventually be exposed to
training or harness tuning. Maintain a private confirmation suite of 50–100
tasks drawn from real work.

Initial task families:

1. Cross-module coding changes with held-out behavioral tests.
2. Large-repository investigation spanning source, history, documentation, and
   traces.
3. Incident response spanning logs, runbooks, cloud state, and a bounded
   remediation.
4. Citation-grounded research over a frozen large corpus.
5. Stateful cross-system workflows with explicit permissions and forbidden
   collateral effects.

Every case must include:

- a content-addressed starting snapshot;
- a user-facing task statement;
- an implementation-independent success contract;
- allowed tools, effects, and network policy;
- forbidden changes or side effects;
- a deterministic grader where possible;
- partial requirement checks;
- a strong single-agent difficulty estimate;
- at least one hidden, parameterized variant;
- task author and independent reviewer approval.

The suite must retain a development split and an untouched confirmation split.
Do not tune routing thresholds against the confirmation split.

## Creative collaboration

Creativity requires a separate paired evaluation because environment-verified
success alone cannot capture novelty, and unconstrained novelty can hide poor
quality. Roster records quality, novelty, diversity, provenance, collaboration,
and cost as separate dimensions.

The initial conditions compare a neutral solo agent, a divergence-prompted solo
agent, a shared-first team, an independent-first team, and an independent team
with a generative challenge phase. Initial exploration must be isolated by the
context plane; prompt text alone cannot prevent anchoring if peer proposals are
already visible.

The runnable contract, prompts, starter cases, external benchmark portfolio,
and decision gates are defined in
[Creativity evaluation for Roster](./creativity-evaluation.md).

## Experimental conditions

Use the same task image, prompt, model version, reasoning effort, tool schemas,
permissions, network policy, timeout, and seed in every paired condition.

| ID | Condition | Purpose |
| --- | --- | --- |
| A0 | Native strong single agent | Current product alternative. |
| A1 | Same agent through one Roster node | Isolate Roster control-plane tax. |
| A2 | Compute-matched single agent with a second pass or self-consistency | Prevent free team inference from creating a false uplift. |
| A3 | Static planner → worker → verifier | Conventional role pipeline baseline. |
| A4 | Adaptive Roster, direct/compacted context | Isolate coordination without RLM. |
| A5 | Single-agent RLM, reference-first context | Isolate RLM without distributed topology. |
| A6 | Adaptive Roster plus reference-first context and RLM | Complete system. |
| A7 | A6 without verifier | Measure verifier value and false decisions. |
| A8 | A6 under declared faults | Measure durable recovery. |

The critical comparisons are:

- A1 versus A0: Roster overhead.
- A6 versus A2: complete system versus compute-matched solo.
- A5 versus A2: RLM value without multi-agent composition.
- A6 versus A5: topology value beyond RLM.
- A6 versus A4: context externalization value.
- A6 versus A7: verifier value.
- A8 versus clean A6 and a faulted A2: recovery value.

Run at least three trials per task during calibration and five for a decision
result. Reuse task seeds across conditions. Randomize condition order to reduce
provider drift and transient load bias.

## Measurement contract

Introduce one versioned `roster.benchmark-result.v1` record. It is an
observational result, not orchestration authority.

### Identity

- suite, suite version, case, case version, variant, trial, and seed;
- repository/image/input snapshot hashes;
- Roster code revision;
- run, trace, and artifact references;
- provider, model, runtime, reasoning, prompt, policy, roster, and tool-catalog
  versions;
- start time and environment fingerprint.

### Outcome

- environment-verified success;
- partial requirement score;
- grader checks and evidence references;
- regression and security failures;
- collateral file or state changes;
- false-success claim;
- human correction minutes for non-binary artifacts.

### Reliability

- `pass^1`, `pass^2`, and `pass^4`, where `pass^k` means all repeated attempts
  succeed, not at least one;
- run-to-run score variance;
- recovery rate and recovery overhead;
- duplicate side effects;
- stale publication attempts;
- verifier false accepts and false rejects.

### Economics and latency

- total input, cached-input, cache-write, output, reasoning, and aggregate
  tokens across all nodes;
- reported and estimated dollars;
- dollars per attempted and verified-successful task;
- provider, tool, retry, and wasted call counts;
- end-to-end p50/p95;
- critical-path time;
- achieved parallel speedup;
- human intervention count and minutes.

### Context and RLM

- source corpus bytes or estimated tokens;
- peak input visible to any one model call;
- aggregate input across all calls;
- context amplification: aggregate model input divided by source size;
- manifest/reference descriptor bytes;
- unique resolved bytes and repeated resolved bytes;
- catalog search, describe, function, and pipeline counts;
- evidence precision and recall where a gold evidence set exists;
- recursion count, depth, fan-out, and marginal score per subcall.

### Coordination

- verified uplift over A2;
- spawned, useful, idle, failed, retried, and accepted nodes;
- accepted artifacts per spawned node;
- redundant-work fraction;
- messages and communication bytes;
- time to first useful artifact;
- blocked and idle node time;
- conflicts, revisions, and rework;
- planner precision and recall against work ultimately required;
- router regret against the best measured condition for that task.

### Safety and control

- unauthorized function and mutation attempts;
- policy violations;
- destructive or collateral effects;
- correct refusal under missing information or authority;
- preserved versus silently overwritten semantic conflicts;
- receipt, artifact, and trajectory coverage;
- exact replayability of supported control state.

## Grading rules

Prefer environment state, executable tests, and deterministic checks. A model
or verifier's own completion claim is never the primary grader.

For subjective outputs:

1. use a rubric written before the runs;
2. blind reviewers to the condition;
3. require two independent ratings;
4. report disagreement;
5. keep factual/citation checks deterministic where possible;
6. measure human correction time, not only preference.

Audit benchmark tasks before blaming the agent. A failed task with a broken,
overly strict, underspecified, misleading, or low-coverage grader must be
quarantined and reported separately.

## Statistics and reporting

- Pre-register one primary outcome per task family.
- Use paired task-level deltas and paired bootstrap confidence intervals.
- Cluster repeated trials by task.
- Report the full distribution, not only a macro average.
- Stratify by solo difficulty, task decomposability, file/repository count,
  context size, tool count, and sequential depth.
- Report total system compute. Never compare a team with a smaller-budget solo
  baseline.
- Freeze and publish prompts, tool schemas, policies, model identifiers, run
  dates, and aggregation logic.
- Keep failures and excluded benchmark cases visible.

The core product metric is:

```text
verified utility =
  verified outcome value
  - model and tool cost
  - latency cost
  - human intervention cost
  - collateral-risk penalty
```

Report each component separately. Do not hide tradeoffs in a single weighted
number until product data can calibrate the weights.

## Initial operating gates

These are provisional decision thresholds, not claims of statistical truth.
Calibrate them after the pilot.

- A1 must be non-inferior to A0 within 2 percentage points of verified success.
- Enable multi-node routing for a task stratum only when A6 improves verified
  success by at least 5 percentage points over A2, or is non-inferior while
  reducing verified-success cost or latency by at least 20%.
- Do not ship a verifier role if its false-accept rate exceeds the correction
  gain it creates against the environment grader.
- Claim context efficiency only when peak model-visible input falls by at least
  50%, aggregate context amplification does not increase, and verified success
  remains within 2 percentage points.
- Claim useful parallelism only when critical-path time improves by at least
  25% without increasing merge/conflict failure.
- A fault-recovery claim requires no duplicate irreversible effects and at
  least 95% preservation of already accepted work.

If a stratum fails its gate, route it to one node and keep collecting evidence.

## Repository implementation plan

### Phase 0: make measurements trustworthy

1. Carry normalized provider usage through the trusted runtime/acceptance seam
   into `AcceptedTaskOutcome`.
2. Keep usage authority out of model-visible `executionOptions`.
3. Test that graph snapshots and durable outcomes retain provider tokens, cost,
   and duration.
4. Inventory usage coverage by runtime; report missing usage as missing, never
   zero.

The first three items are implemented. Broader cross-runtime coverage
reporting remains.

### Phase 1: common result and runner

1. Add `src/evals/benchmark.ts` with bounded
   `roster.benchmark-result.v1` types and validation.
2. Add a manifest-driven runner that executes paired variants over identical
   case/seed/budget inputs.
3. Write per-trial JSONL plus a content-addressed aggregate report.
4. Reuse `runCodingAgent`, current runtime adapters, task receipts, trajectory
   normalization, and existing graders. Do not add another scheduler.
5. Store full trajectories and large grader artifacts outside receipts; retain
   references and hashes in the result.

### Phase 2: calibration pilot

Run a small, stratified matrix:

- 12 DeepSWE cases;
- 12 TeamBench cases across official ablations plus adaptive Roster;
- 12 CodeScaleBench dual-verifier cases;
- 6 Terminal-Bench cases.

Use A0, A1, A2, A4, A5, and A6 with three trials. Use the results to validate
the harness, estimate variance and cost, and reduce the next matrix. Do not
publish capability claims from this calibration sample.

### Phase 3: decision study

Expand only the task strata with plausible signal. Use five trials, paired
confidence intervals, pre-registered primary outcomes, and an untouched
private confirmation set.

The output must identify:

- where adaptive Roster wins;
- where RLM alone wins;
- where one agent remains best;
- which roles add value;
- which routing features predict the winning topology;
- the cost and latency of choosing incorrectly.

### Phase 4: product learning loop

1. Record benchmark-compatible outcome, resource, context, and intervention
   summaries for consented production runs.
2. Keep product telemetry separate from benchmark labels.
3. Propose routing-policy changes from historical evidence.
4. Evaluate changes offline against fixed suites.
5. Promote a policy only after confirmation-set improvement.
6. Never let an active run silently rewrite its own routing policy.

## Stop conditions

Do not build more orchestration or simulator abstractions until Phase 2 reports
paired outcome data.

Stop or narrow multi-agent investment for a task family when:

- A6 repeatedly loses to A2 after compute matching;
- gains exist only on public cases but not the private confirmation split;
- verifier decisions do not correlate with environment correctness;
- aggregate context or cost grows faster than outcome quality;
- routing cannot predict useful decomposition better than always selecting one
  node.

The goal of this program is not to defend the architecture. It is to discover
the smallest set of use cases where the architecture creates measurable value.

## Primary evidence

- [DeepSWE paper](https://arxiv.org/abs/2607.07946)
- [DeepSWE repository](https://github.com/datacurve-ai/deep-swe)
- [TeamBench paper](https://arxiv.org/abs/2605.07073)
- [CooperBench paper](https://arxiv.org/abs/2601.13295)
- [Terminal-Bench 2.0 paper](https://arxiv.org/abs/2601.11868)
- [CodeScaleBench repository](https://github.com/sourcegraph/CodeScaleBench)
- [SlopCodeBench paper](https://arxiv.org/abs/2603.24755)
- [Recursive Language Models paper](https://arxiv.org/abs/2512.24601)
- [METR task-completion time horizons](https://metr.org/time-horizons/)
- [tau-bench paper](https://arxiv.org/abs/2406.12045)
- [OpenAI audit of SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
- [OpenAI audit of SWE-Bench Pro](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)
