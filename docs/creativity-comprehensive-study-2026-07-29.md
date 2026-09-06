# Collaborative Creativity Comprehensive Study — 2026-07-29

## Verdict

The current collaborative topology is useful for exploration and harmful as a
default final-answer policy.

Across 28 compute-matched pairs, role-specialized independent workers explored
more different material than repeated generic workers on every task family.
That breadth did not survive composition. Final quality fell by 2.09 points,
originality did not improve, and only 57.1% of team artifacts combined material
from more than one node.

This is evidence for keeping independent node exploration as an optional tool.
It is evidence against automatically routing creative work through the current
challenge-and-compose pipeline.

The raw artifact is
`artifacts/evals/creativity-comprehensive-2026-07-29.json`.

## Question tested

The predeclared comparison was:

> Does independent, role-specialized exploration followed by a challenge and
> bounded composition produce a more original, useful, and diverse artifact
> than the same amount of repeated generic exploration?

This isolates prompt/topology diversity. It does not isolate separate model
weights: all workers within a condition used the same generator model.

## Experimental design

The matrix contained:

- 7 tasks across divergent thinking, creative writing, product design,
  scientific ideation, creative problem solving, and creative mathematics;
- 2 real coding-agent runtimes: Codex with `gpt-5.6-sol` and Claude Code with
  `claude-sonnet-5`;
- 2 replication nonces per task and runtime;
- 28 matched baseline/treatment pairs;
- 5 generation calls per condition: 3 isolated explorers, 1 challenger, and 1
  composer;
- 2 blinded judge families, each evaluating both candidate orders.

The completed matrix represents 280 logical generation calls and 112 judge
calls. Both conditions had exactly the same number of calls. Explorers saw only
the task. Challengers and composers saw bounded, labeled contributions rather
than a shared transcript.

### Task portfolio

| Task | Domain | Source |
| --- | --- | --- |
| Offline neighborhood cooling | Product ideation | Roster held-out |
| Broken bridge signaling | Resource-constrained problem solving | Roster held-out |
| Unusual uses for a key | Divergent thinking | CreativityPrism `23_unusual` |
| Consequences of no sleep | Divergent thinking | CreativityPrism `1_consequences` |
| Periodic-table research idea | Scientific ideation | LiveIdeaBench keyword task |
| Five-sentence distant-word story | Creative writing | CreativityPrism `organ-empire-comply` |
| Novel 2-adic divisibility proof | Creative mathematics | CreativityPrism `2016_AMC_8_Problems_15` |

The CreativityPrism tasks came from its Apache-2.0 repository at revision
`4705a830501e47b999481a0ec0c62ac2cca10c86`. The LiveIdeaBench task came from
its MIT repository at revision
`6fc8285269c7679ed427b20864d1f1b127b1a228`.

## Primary results

Treatment deltas are team minus compute-matched solo-divergent.

| Measure | Baseline | Team | Delta | 95% paired bootstrap CI | Sign-flip p |
| --- | ---: | ---: | ---: | ---: | ---: |
| Final quality | 87.35 | 85.25 | **−2.09** | **[−4.12, −0.32]** | 0.037 |
| Judged originality | 78.08 | 75.71 | −2.37 | [−6.20, +0.83] | 0.218 |
| Exploration spread | 0.785 | 0.811 | **+0.026** | **[+0.015, +0.038]** | <0.001 |
| Final mechanism coverage | 0.216 | 0.185 | −0.031 | [−0.067, +0.004] | 0.097 |

Quality is the mean of usefulness, coherence, and constraint satisfaction.
Originality remains separate; there is no synthetic creativity total.

The trial-level quality result could be overconfident because four observations
share each task. Treating task as the generalization cluster produces the same
conclusion:

| Task-clustered measure | Delta | 95% cluster bootstrap CI | Exact sign-flip p |
| --- | ---: | ---: | ---: |
| Quality | **−2.09** | **[−3.88, −0.75]** | 0.031 |
| Originality | −2.37 | [−7.39, +1.78] | 0.453 |
| Exploration spread | **+0.026** | **[+0.016, +0.039]** | 0.016 |
| Mechanism coverage | −0.031 | [−0.075, +0.011] | 0.250 |

Exploration spread increased in all 7 task clusters and in 23 of 28 individual
pairs. Quality decreased in 6 of 7 task clusters and in 19 of 28 pairs.

## Runtime interaction

The effect was not provider invariant.

| Generator | Quality delta | 95% CI | Originality delta | Exploration-spread delta |
| --- | ---: | ---: | ---: | ---: |
| Codex | −0.31 | [−1.63, +1.04] | +1.23 | **+0.032** |
| Claude | **−3.88** | **[−7.35, −0.70]** | −5.96 | **+0.020** |

For Codex, collaboration widened exploration without a detectable final-quality
change. For Claude, the same topology widened exploration but materially
degraded the final artifact. A provider-neutral orchestration contract is
therefore necessary but insufficient: placement policy must be validated per
runtime and task family.

Generation accounting was closely matched:

| Generator | Baseline input/output tokens | Team input/output tokens | Recorded generation cost |
| --- | ---: | ---: | ---: |
| Codex | 1,227,238 / 29,760 | 1,228,018 / 28,926 | Account-authenticated; CLI reported no dollars |
| Claude | 322,632 / 44,421 | 321,289 / 43,815 | $1.365 baseline / $1.379 team |

Judge tokens and costs were not retained by v1 of the live runner. The economic
comparison is valid between generation conditions, but total study cost is
underreported. This must be fixed before a production cost claim.

## Where it helped

The best use case was divergent ideation.

- The unusual-key task gained 6.63 originality points and exploration spread
  increased in all four runtime/seed cells.
- The no-sleep task gained 1.19 originality points and exploration spread
  increased in all four cells.
- These are promising strata, not independent leaderboard wins: each has only
  four pairs, so the smallest possible two-sided exact sign-flip p-value is
  0.125.

The practical product implication is to return or preserve a portfolio of
candidate mechanisms for brainstorming. Forcing immediate convergence into one
answer discards much of the measured benefit.

## Where it failed

### Composition discarded exploration

The team composer selected material from 57.1% of available node sources on
average. Only 57.1% of team artifacts represented more than one node.
Generator-labeled mechanism coverage fell from 21.6% to 18.5%.

This is the same failure seen in the first live pilot: the explorer layer did
its job, while the composer acted mostly as a winner selector.

### Challenge could introduce invalid assumptions

The largest quality losses occurred in Claude's two broken-bridge trials:
−18.25 and −13.17 points. One treatment artifact selected a challenger that
required assigning roles “before full separation,” although the task starts
with the group already split. It also treated a chalk marker at a former shared
location as a misunderstanding detector that both separated sides could use.

The composition layer preserved novelty and confidence while losing temporal
feasibility. A deterministic or domain-specific constraint gate should have
rejected that contribution before composition.

### Challenge could collapse novelty

In both Claude creative-math trials, the team composer selected only the
challenger's direct-computation/repeated-halving proof. The baseline used LTE
or modular residues. Both team answers were correct, but mean originality fell
15.06 points for that task.

The challenger found a safer answer, not a more creative one. “Challenge” is
not automatically equivalent to productive divergence.

### Writing did not recover the claim

On the five-sentence CreativityPrism story task, quality was effectively tied
(−0.27) while originality favored baseline by 4.44 points with a wide interval.
Exploration spread increased by 0.020. Narrative generation therefore repeated
the overall pattern: broader drafts, no demonstrated final gain.

## Constraint audit

All 40 machine-checkable final-artifact checks passed:

- exactly 12 items for both divergent-list tasks;
- no more than 100 words for LiveIdeaBench;
- required words and no more than five sentences for the short story;
- the correct value `32` for creative mathematics.

These checks do not establish semantic validity. The order-balanced rubric
judges gave a full constraint pass to 22/28 baseline artifacts and 23/28 team
artifacts. Mean pass rate was 94.6% baseline and 92.9% team because several
team failures were judged more severe.

The bridge example demonstrates why semantic or executable checks must remain
outside the generator context wherever possible.

## Judge reliability

Pairwise winner votes were too biased to certify the result:

- Codex produced an order-stable preference on 19/28 pairs (67.9%) and chose
  the first candidate in 33 of 53 decisive judgments.
- Claude was stable on 12/28 pairs (42.9%) and chose the second candidate in 32
  of 46 decisive judgments.
- Both families were stable on only 9 pairs; they agreed on 5 and disagreed on
  4.

Winner votes were therefore treated as diagnostics. Numeric rubric scores were
averaged across both candidate orders before paired analysis. Even then, judge
families differed: Codex scored team quality −3.51 and originality −3.73;
Claude scored team quality −0.68 and originality −1.00.

This agrees with [LitBench](https://aclanthology.org/2026.eacl-long.362/),
which reports only 73% human-preference agreement for its strongest
off-the-shelf creative-writing judge, and with
[Rethinking Creativity Evaluation](https://aclanthology.org/2026.eacl-long.297/),
which finds that creativity metrics disagree across domains.

## Public benchmark status

This study used public benchmark tasks, but it did not produce an official
leaderboard score.

- [CreativityPrism](https://github.com/joeyhou/CreativityPrism) contains nine
  tasks and twenty task-specific metrics. This study used three adapted tasks,
  added hard constraints, and used a different generation and judge harness.
- [LiveIdeaBench](https://github.com/x66ccff/liveideabench) evaluates many
  keywords and its own originality, feasibility, clarity, fluency, and
  flexibility pipeline. This study used one exact keyword format with
  different judges.
- [EQ-Bench Creative Writing v3](https://github.com/EQ-bench/creative-writing-bench)
  was audited but not run. A comparable score requires 32 prompts × 3
  iterations, the prescribed judge, historical matchup data, and Glicko
  normalization. A composite CLI agent is not a drop-in model endpoint.
- [MacGyver](https://aclanthology.org/2024.naacl-long.297/) was not run because
  its full physical-validity evaluation was not integrated.

Therefore there is no honest claim that Roster beat a public leaderboard or
state of the art. It beat its compute-matched baseline on exploration spread.
It did not beat that baseline on final creativity.

The 2026 paper
[Multi-agent AI systems outperform human teams in creativity](https://arxiv.org/abs/2605.17885)
reports a large effect across thousands of ideas and six tasks. It is evidence
that multi-agent creativity can work, not that every multi-agent topology
works. This implementation currently reproduces the wider-search mechanism but
not the final-artifact advantage.

## Adversarial infrastructure findings

An initial concurrency-3 stress pass launched up to eighteen CLI model calls at
once. Most cells failed because Codex intermittently received no supplied task
and Claude had been invoked in plan-only coding mode, causing appropriate
rejection of non-code tasks. The runner was corrected to:

- invoke Claude in default no-tool mode;
- use direct task framing instead of experimental role-play language;
- retry structured envelopes;
- repair JSON-invalid LaTeX backslashes;
- normalize provider-specific cache accounting;
- checkpoint after every pair;
- run one pair at a time while retaining within-pair phase parallelism.

The corrected run completed all 28 pairs with zero missing cells. This is a
real runtime-neutrality result, but it also shows that concurrency and
invocation mode belong in provider adapters rather than in logical node
topology.

## What the architecture proved

The composable node/artifact design was worth building for control and
measurement:

- task-only explorer contexts made independence real rather than rhetorical;
- contributions stayed outside later model context until explicitly selected;
- the same logical experiment ran through two coding-agent runtimes;
- contribution IDs exposed composition loss;
- checkpoints made partial failures resumable;
- ordered judgments exposed opposite position biases;
- raw artifacts allow replay and reanalysis without rerunning generation.

It did not prove that more agents create a better answer. The category-theory
intuition—compose bounded transformations over external values instead of
placing all state in one prompt—is useful infrastructure. Composition laws do
not guarantee semantic quality. Each morphism still needs preconditions,
postconditions, and an acceptance boundary.

## Decision and action plan

### Ship now

1. Keep independent exploration, bounded artifacts, provenance, replay, and
   provider-neutral runtime adapters in the core.
2. Expose collaborative ideation as an opt-in strategy that returns multiple
   candidates or a frontier.
3. Keep position-balanced judging and paired uncertainty in the evaluation
   core.

### Do not ship as a default

1. Do not route every creative request through challenge-and-compose.
2. Do not advertise a creativity uplift or public-benchmark win.
3. Do not accept a challenger contribution merely because it is different.
4. Do not use raw LLM winner votes as certification.

### Next implementation experiment

Compare three composition policies on the frozen 28 pairs without changing
exploration:

1. **Validated selector:** reject contributions that fail deterministic or
   domain checks, then select the best remaining artifact.
2. **Coverage-constrained synthesis:** require at least two compatible source
   nodes and explain every discarded mechanism.
3. **Portfolio output:** skip convergence and return the top three distinct,
   qualified candidates.

Pre-register these gates:

- quality non-inferiority lower bound no worse than −1 point;
- no reduction in semantic constraint-pass rate;
- originality lower confidence bound above zero for an uplift claim;
- exploration spread remains positive by task cluster;
- at least 75% cross-node synthesis for synthesis mode;
- at least 50% retained mechanism coverage after blinded relabeling;
- at least 80% order-stable judges and 70% cross-family agreement, or use
  blinded humans/specialized reward models;
- full generation and judge token/cost accounting.

If portfolio mode preserves the divergent-thinking originality gains while
validated selection protects convergent tasks, the architecture has a clear
routing use case. If not, compute-matched solo divergence should remain the
default.

## Implemented composition-policy follow-up

The action plan above is now implemented in the provider-neutral orchestration
core.

- Task intent routes explicitly to portfolio, validated selection, or
  coverage-constrained synthesis.
- Candidates carry immutable artifact references, evidence, quality scores,
  constraint status, source candidate IDs, and declared mechanism IDs. Artifact
  bodies remain outside the policy context.
- Synthesis provenance is derived from actual referenced candidates. Unknown
  sources and mechanisms absent from those candidates are rejected.
- Every candidate receives inspectable rejection reasons.
- Collaboration falls back to a separately validated solo-divergent result;
  if that result is also invalid, the policy fails closed.
- Certification records the policy decision and selected candidate IDs.

Replaying the original 28 pairs through the frozen default gates accepted zero
team artifacts and retained all 28 baselines. This is not evidence of an
improvement. It shows that the old composer contract was incompatible with
validated synthesis: all 28 outputs missed 50% exact mechanism retention, 15
missed 75% source coverage, 22 claimed at least one mechanism absent from their
selected sources, 13 regressed by more than one quality point, and three failed
the constraint supermajority. The replay prevented those regressions, but
fallback alone only restores the baseline.

The live protocol was therefore revised without increasing calls per condition.
The composer must copy stable mechanism tags, retain at least half, integrate at
least three of four sources, and may reject the challenger. A fresh real-model
acceptance sample ran four pairs:

- tasks: broken-bridge emergency planning and creative 2-adic mathematics;
- generators: Codex CLI `gpt-5.6-sol` low and Claude Code
  `claude-sonnet-5` low;
- one new seed per generator/task cell;
- zero generation or judge failures.

Before policy selection, treatment quality was +0.40 points
(95% bootstrap interval −7.15 to +6.96) and originality was +3.88
(+1.13 to +7.75). Mechanism retention improved by +0.182 and all four
treatments used multiple nodes. The sample is too small for an uplift claim.

The policy accepted both Codex treatments, fell back from the Claude math
treatment after a 10.5-point quality regression, and returned
`no-qualified-output` for the Claude bridge pair because the treatment retained
42.1% of mechanisms while its baseline failed the constraint supermajority.
Across the three qualified outputs, selected quality was +0.92
(−0.17 to +2.92) and selected originality was +4.0 (0 to +9.5). These are
acceptance-test signals, not conclusive benchmark results.

The honest conclusion is narrower than “multi-agent is better”: the topology
can now produce admissible syntheses, and the policy prevented a severe
regression. A full preregistered multi-seed run is still required before
changing the default route.
