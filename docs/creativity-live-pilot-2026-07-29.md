# Collaborative Creativity Live Pilot — 2026-07-29

## Verdict

This pilot is promising process evidence and failed product proof.

Role-specific independent prompts produced more genuinely different initial
mechanisms than repeated generic sampling. The final composition did not use
that breadth: both conditions converged on nearly identical fixed tactile
handrails, and each composer selected only the challenger contribution.

The averaged rubric scores favor the team artifact, but one of two judge
families exhibited direct first-position bias. With one task and one seed, the
result does not establish a creativity uplift.

Raw prompts, contributions, accepted artifacts, usage, judgments, and derived
scores are retained in
`artifacts/evals/creativity-live-pilot-2026-07-29.json`.

## Frozen design

The task was held out from the repository before generation:

> Design a compact public installation that helps visitors grasp deep
> geological time without screens, projections, speakers, or staff
> facilitation.

Hard constraints required a 4m × 4m footprint, reset below two minutes,
equivalent blind and wheelchair access, no loose item below 5cm, less than
$2,000 in materials, an exact mapping to 4.54 billion years, and an explicit
failure mitigation.

Both conditions used:

- Codex CLI with `gpt-5.6-sol`;
- low reasoning effort;
- no tool calls;
- three isolated proposal calls;
- one challenge call;
- one composition call;
- approximately 99,000 total reported tokens.

The conditions differed only in logical topology and prompts:

- `solo-divergent`: three generic samples owned by one logical node, followed
  by a self-challenge and composition;
- `team-independent-challenge`: scale, accessibility, and operations explorers,
  followed by an independent challenger and composition.

The team was homogeneous: every generating node used the same model. This
isolates role prompting from heterogeneous-model effects.

## Quantitative result

| Measure | Solo divergent | Team independent + challenge | Delta |
| --- | ---: | ---: | ---: |
| Mean quality | 72.67 | 81.83 | +9.16 |
| Judged originality | 64.00 | 71.25 | +7.25 |
| Usefulness | 75.25 | 81.75 | +6.50 |
| Coherence | 76.00 | 85.00 | +9.00 |
| Constraint satisfaction | 66.75 | 78.75 | +12.00 |
| Judge constraint-pass rate | 25% | 75% | +50 pp |
| Lexical exploration spread | 0.740 | 0.772 | +0.032 |
| Explored mechanisms | 13 | 16 | +3 |
| Final mechanism retention | 30.8% | 31.3% | +0.5 pp |
| Selected nodes | 1/1 | 1/4 | — |
| Cross-node synthesis | No | No | — |
| Total reported tokens | 98,998 | 99,254 | +256 |

The score delta is descriptive, not statistically meaningful. There is one
case, one seed, correlated generators, and unstable judges.

## What happened during exploration

All three generic solo samples independently proposed almost the same
mechanism: a hand-cranked tactile belt. Dimensions and details differed, but
the causal idea did not.

The role-specialized team produced:

1. a two-handed table comparing linear and logarithmic tactile scales;
2. a hand-cranked tactile belt designed around nonvisual agency;
3. a self-resetting tactile winch designed for unattended operation.

This is a real breadth improvement that lexical distance only weakly captured.
It supports the hypothesis that explicit search lenses can diversify a shared
model's exploration.

It does not establish that separate node identities caused the gain. The same
model received different prompts; prompt diversity is the active treatment.

## Where collaboration failed

The solo self-challenger and team challenger independently proposed almost the
same fixed handrail. That suggests a strong shared model prior rather than
independent discovery.

Both composers then selected only that challenger contribution:

- solo selected `A4`;
- team selected `B4`;
- neither selected or combined an explorer contribution;
- team source coverage was 25%;
- cross-node synthesis was false.

The team therefore widened the search but discarded the additional search
value at the final boundary. The current composer optimizes for the safest
feasible candidate and treats synthesis as optional. On this task it acted as a
winner selector, not a composer.

This is the primary architecture finding from the run.

## Judge audit

Two blinded judge families evaluated both candidate orders.

### Codex judge

Codex preferred the team artifact in both orders. Its qualitative reason was
consistent: the team's L-shaped layout was more spatially plausible than the
solo artifact's horseshoe layout.

Its absolute scores were not stable. Team constraint satisfaction changed from
72 to 89 across orderings, and its constraint-pass decision changed. In one
ordering it caught a potential inconsistency where two 2.27m straight runs plus
a radiused corner may exceed the claimed 4.54m path; in the other it did not.

The preference is usable as weak evidence. The numeric scores are noisy.

### Claude judge

Claude selected candidate A in both runs. Because candidate order was reversed,
that means it preferred the solo artifact when solo appeared first and the team
artifact when team appeared first.

This is direct first-position bias. Claude's pairwise preference must be
discarded for this pilot. Its rubric scores also moved with position.

### Shared judge finding

Both families found that neither artifact supplied a dimensioned plan proving
the complete wheelchair route, turning circles, rail geometry, supports, and
labels fit within 4m × 4m. The generated budget estimates also omitted labor
and installation, although the prompt specified materials only.

This demonstrates why a deterministic geometry or CAD-derived check is needed
for design tasks. A fluent model judge does not reliably verify spatial claims.

## Measurement weaknesses exposed

1. **Lexical spread overstates semantic diversity.** The three belt proposals
   used different prose and tags, producing a relatively high spread despite
   sharing one mechanism.
2. **Mechanism tags fragment synonyms.** `tactile belt`, `closed-loop belt`,
   `fixed scale`, and `mechanical scale` inflate the raw mechanism count.
3. **Rubric scores are judge- and position-sensitive.** Position reversal must
   be a validity gate, not just another score.
4. **Coding-agent context dominates cost.** Each no-tool creative call carried
   roughly 17,000–20,000 input tokens. The complete pilot consumed about
   198,000 reported generation tokens before judging. A lightweight generation
   surface would be materially cheaper.
5. **One final artifact hides unused search.** Exploration metrics looked
   better for the team, but accepted-artifact provenance correctly revealed
   that the breadth produced no synthesis.

## Honest conclusion

The run supports one limited claim:

> Independent role prompts can make a homogeneous model explore more distinct
> mechanisms than repeated generic sampling.

It does not yet support:

- that multiple nodes are more creative than a compute-matched solo system;
- that collaboration improved the accepted artifact;
- that the observed score delta generalizes;
- that current automatic judges can certify creative quality;
- that the additional orchestration is economically worthwhile.

The design was useful because it made this negative result visible. A
winner-only benchmark would have reported a team score increase and missed the
composition collapse.

## Required next experiment

Before scaling to public benchmarks:

1. Add semantic clustering or blinded human mechanism coding instead of raw
   tag counts.
2. Reject a pairwise judge's preference when it flips solely with candidate
   order.
3. Add deterministic validators for hard spatial, numerical, and budget
   constraints.
4. Compare three composition policies:
   - best-single-candidate selection;
   - explicit cross-node synthesis;
   - composer chooses between both outputs after deterministic checks.
5. Require the composer to state why every unselected mechanism was discarded.
6. Run at least eight tasks across three seeds before interpreting an average.
7. Add a heterogeneous-model condition only after the homogeneous topology
   comparison is stable.
8. Use a minimal no-tool generation runtime so system context does not consume
   most of the experimental budget.

The next pilot should focus on the composer and judge validity, not add more
explorers.
