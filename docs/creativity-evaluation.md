# Creativity Evaluation for Roster

## Decision

Roster should test a narrow claim:

> On creative tasks, independent exploration followed by bounded challenge and
> composition produces more novel, useful, and diverse artifacts than a
> compute-matched single agent, without unacceptable quality, cost, or latency
> loss.

This is not the claim that more agents are inherently more creative. A team can
collapse around the first idea, repeat the same model prior through different
personas, or produce novelty that is unusable. The evaluation keeps quality,
novelty, and diversity separate so those failure modes remain visible.

## What is implemented

`src/evals/creativity-benchmark.ts` provides:

- a bounded `roster.creativity-trial.v1` record;
- three original starter cases;
- five prompt and topology conditions;
- deterministic lexical-spread and provenance metrics;
- independent rubric-judgment ingestion;
- paired bootstrap confidence intervals and sign-flip randomization tests;
- position-balanced judge reliability gates;
- provider usage and per-node model fingerprints;
- condition-level summaries without a single creativity score.

The implementation is provider-neutral. A Codex, Claude, Pi, Hermes, command,
A2A, or Roster-native node can produce the same trial record. The runtime does
not become evaluation authority.

Run the checked-in calibration fixture:

```bash
npm run eval:creativity
```

Score real JSON or JSONL trial records:

```bash
npm run eval:creativity -- --input results/creativity-trials.jsonl
npm run --silent eval:creativity -- --input results/creativity-trials.jsonl --json
```

An input may also be a JSON object containing `benchmark` and `records`. This
keeps a private or held-out case definition beside its trials without adding it
to the public starter registry.

Inspect the exact experimental prompts:

```bash
npm run eval:creativity:prompts
npm run eval:creativity:prompts -- \
  --case museum-after-closing \
  --condition team-independent-challenge
```

The fixture demonstrates the contract and analysis path; its synthetic scores
are not evidence that Roster improves creativity.

Run or resume the live, compute-matched study:

```bash
npm run eval:creativity:live -- \
  --generators codex,claude \
  --seeds 101,202 \
  --concurrency 1
```

The live runner checkpoints every completed pair, launches both coding-agent
CLIs without tools, reverses candidate order for both judge families, and
records public-task provenance. Keep concurrency low: a deliberate stress run
showed that excessive parallel CLI sessions can lose the supplied task context.
The completed July 2026 result and its limitations are documented in
`docs/creativity-comprehensive-study-2026-07-29.md`.

## Experimental conditions

| Condition | Purpose |
| --- | --- |
| `solo-neutral` | Strong single-agent baseline with an ordinary task prompt. |
| `solo-divergent` | Tests whether prompting one agent to explore is enough. |
| `team-shared-first` | Measures the common approach where every node immediately sees the first proposal. |
| `team-independent-first` | Tests whether withholding peer proposals during initial exploration prevents anchoring. |
| `team-independent-challenge` | Adds a generative challenger before composition. |

Run an additional model-placement ablation within team conditions:

- one model and one prompt profile across all nodes;
- one model with distinct prompt profiles;
- heterogeneous model families with the same task and roles.

Per-node model fingerprints in the trial record distinguish real model
diversity from several names attached to the same generator.

Match aggregate generation tokens, tool calls, wall-time ceilings, and number
of candidate attempts. The fair primary comparison is
`team-independent-challenge` against a compute-matched `solo-divergent`, not
against a cheaper one-pass baseline.

## Prompt protocol

Creativity prompting is a control protocol, not a collection of colorful
personas.

### Explore

Each node sees the task and hard constraints but not peer proposals. It must
produce several candidates from different causal mechanisms, perspectives,
structures, or tradeoffs. Cosmetic rewrites do not count.

The `task-only` context policy must be enforced by Roster context selection.
Writing “work independently” while including peer outputs in the prompt does
not create independence.

### Challenge

After independent ideas are published, a challenger receives the prior
frontier and must generate a counterproposal through inversion, distant
analogy, constraint removal, or mechanism combination. It is not asked to rank
or summarize the majority view.

### Compose

The composer receives the complete bounded frontier, selects contribution IDs,
and records which mechanisms survived. Selection is based on artifact quality,
not vote count or repetition. This makes early convergence and idea loss
measurable.

### Judge

Judges receive anonymized final artifacts, the original task, constraints, and
fixed rubric. They do not receive model names, topology, contribution count,
cost, or the generation transcript.

Use at least two independent judge families for calibration and periodically
include blinded human ratings. LLM judges must not certify their own outputs.

## Measurement model

### Quality

- usefulness;
- coherence;
- hard-constraint satisfaction;
- independent preference or human correction time.

### Novelty

- blinded originality judgment;
- distance from a frozen common-answer or reference corpus;
- nearest-neighbor copying and phrase-reuse audit;
- novelty among outputs that pass minimum usefulness and constraints.

Lexical distance is only a diagnostic. Different words can express the same
idea, while similar words can encode a genuinely different mechanism.

### Diversity

- exploration spread across contributions;
- distinct mechanism count;
- domain/category coverage;
- cross-seed output diversity;
- idea-family clustering with a frozen embedding model.

Generator-provided mechanism labels are useful for provenance but can be
gamed. For decision studies, a blinded evaluator should audit or relabel them
before mechanism coverage is treated as evidence.

### Collaboration

- contributing and selected node counts;
- fraction of nodes represented in the final artifact;
- cross-node synthesis;
- retained mechanisms divided by explored mechanisms;
- similarity of later contributions to the first contribution;
- productive pivots and challenged assumptions;
- redundant-work fraction.

### Economics

- aggregate input and output tokens across every node and judge;
- dollars per qualified creative artifact;
- end-to-end and critical-path latency;
- human review and correction time.

Do not collapse these into one headline score. At most, define a
`qualified-novelty` gate: report novelty only for artifacts that pass the
pre-registered quality and constraint floor.

## Public benchmarks

No public suite directly proves Roster's collaborative-creativity claim. Use a
portfolio:

1. [CreativityPrism](https://joeyhou.github.io/CreativityPrism/) is the best
   umbrella framework. It separates quality, novelty, and diversity across
   divergent thinking, creative writing, and logical problem solving. Adapt a
   stratified subset into the five Roster conditions.
2. [EQ-Bench Creative Writing v3](https://github.com/EQ-bench/creative-writing-bench)
   is the quickest external writing experiment. It uses 32 prompts, repeated
   generation, rubrics, and pairwise comparisons. Preserve its position and
   length-bias controls, but add human calibration.
3. [LitBench](https://aclanthology.org/2026.eacl-long.362/) is primarily a
   judge-calibration benchmark. Its results show that general-purpose
   zero-shot judges remain imperfect for creative writing, so use it to select
   or audit judges rather than as the only generation score.
4. [WritingBench](https://github.com/X-PLUG/WritingBench) provides 1,000
   real-world writing tasks across 100 subdomains. Use a smaller stratified
   subset for broader professional and creative writing.
5. [LiveIdeaBench](https://github.com/x66ccff/liveideabench) is the best fit
   for scientific ideation. It covers originality, feasibility, clarity,
   fluency, and flexibility across a large keyword set.
6. [MacGyver](https://arxiv.org/abs/2311.09682) tests constrained creative
   problem solving where usefulness can be evaluated alongside novelty.
7. The [Divergent Association Task](https://www.datcreativity.com/about) and
   Alternate Uses Task are inexpensive divergent-thinking diagnostics. They
   measure only a narrow component and should never be the headline result.
8. [Creation-MMBench](https://github.com/open-compass/Creation-MMBench) is a
   later option for Canvas and multimodal creative understanding.

The 2026 study
[Multi-agent AI systems outperform human teams in creativity](https://arxiv.org/abs/2605.17885)
is especially relevant to experimental design: it reports gains driven by
novelty and analyzes conversation paths through semantic space. Reproduce the
comparison in Roster rather than treating the paper as proof of this
implementation.

## Initial runnable study

Start with 24 cases:

- 6 CreativityPrism divergent-thinking cases;
- 6 EQ-Bench or original constrained-writing cases;
- 6 LiveIdeaBench scientific-keyword cases;
- 6 MacGyver or original resource-constrained problem-solving cases.

Run all five conditions with the same five seeds. That is 600 generation
trials before judge repetitions. Start with 8 cases and three seeds as a
harness calibration, then freeze prompts and expand.

For every case:

1. record a content-addressed task and rubric;
2. execute independent phases with actual context isolation;
3. retain every contribution and its mechanism labels;
4. compose against the exact contribution frontier;
5. remove condition and model identity from judge inputs;
6. score with two position-balanced judge families;
7. send a stratified sample to blinded humans;
8. report paired, seed-matched deltas and confidence intervals.

Treat task as the cluster when generalizing across task families. Trial-level
resampling answers whether the exact sampled cells differ; task-clustered
resampling answers the harder question of whether the result is likely to
transfer to new tasks. Report both, and do not select whichever produces the
preferred p-value.

## Decision gates

The thresholds are provisional and should be calibrated:

- team novelty improves by at least 5 points over compute-matched
  `solo-divergent`;
- usefulness and constraint satisfaction are non-inferior within 2 points;
- independent-first exploration increases mechanism diversity by at least 20%
  over shared-first;
- the final artifact retains useful material from at least two nodes on a
  majority of team trials;
- blind pairwise preference favors the team above chance with a paired
  confidence interval excluding material harm;
- gains survive human calibration and are not explained only by length, model
  mix, or extra inference;
- added cost and latency are reported, not hidden.

If only heterogeneous models win, the result supports model diversity rather
than multi-agent topology. If `solo-divergent` matches the team, route that task
family to one node. If exploration breadth rises but final novelty does not,
the composer—not the explorers—is the likely bottleneck.

## Remaining integration work

The current runner scores versioned trial records and emits the exact prompt
protocols. The next integration should:

1. project contribution records automatically from Roster task artifacts;
2. enforce phase-specific `task-only`, `shared-prior`, and `shared-all`
   selectors through task context manifests;
3. add position-swapped pairwise preference records;
4. add a frozen embedding adapter for semantic spread and clustering;
5. produce paired bootstrap intervals across case/seed groups.

These are evaluation-plane additions. They should reuse Roster's existing task
graph, node identity, context, artifacts, receipts, and usage accounting rather
than create another scheduler.
