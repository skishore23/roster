# Writer Roster Walkthrough

Writer Roster is the easiest complete example for learning Roster. Its team follows
a familiar dependency pipeline: research, structure, drafting, critique, editing,
and final composition.

## Start a run

Open `/writer`, enter a writing brief, and select **Start Writing Run**. A useful
brief names the audience, deliverable, evidence expectations, and tone. Leave the
parallel cap on Auto unless you are testing a specific resource boundary.

The model can vary the number of researchers, but Roster validates every named
node, capability assignment, task dependency, and concurrency limit before work
runs.

## Read the workspace

The page has five stable views:

- **Workspace** shows the brief, current artifacts, and final document.
- **Runs** lets you select a durable run.
- **Architecture** explains how the team coordinates and when work is accepted.
- **Activity** shows streams, prompts, receipts, and failures.
- **Replay** above the tabs moves through the exact receipt history.

Connection messages appear beside Replay. The result panels are normal browsable
content, so realtime replacement does not repeatedly announce the entire document
to assistive technology.

## Follow the team

The default pipeline is:

1. Researchers gather independent evidence, counterpoints, examples, and audience
   needs.
2. The architect turns accepted research into an outline.
3. The drafter writes from that exact outline and evidence frontier.
4. Logic and style critics review independently.
5. The editor reconciles actionable criticism without hiding disagreement.
6. The synthesizer composes the accepted final document.

Tasks become ready from artifact dependencies, not from timing. Retrying or
replaying a run therefore preserves why each downstream stage was allowed to
start.

## Continue or replay

Select an existing run and use **Continue Current Run** to append new context.
Use the replay controls to inspect how the document changed. **Live** returns to
the current frontier; selecting a historical step does not stop the active run.

## Use it as an extension example

Start in `src/domains/writer.ts` for named nodes, capabilities, and limits. The
workflow implementation in `src/agents/writer.ts` supplies capability handlers.
Authored seed work and model-generated expansions pass through the same
platform-v3 graph validation before execution.

When building another staged roster, keep the reusable boundary small:

- declare the team and bounds with `defineRosterPlatform`;
- seed the graph with `createRosterRootTask`;
- let the coordinator expand structure, not runtime authority;
- implement bounded capability handlers;
- publish versioned artifacts;
- define an explicit acceptance condition.

For lower-level mechanics, continue with [Workspace nodes](./workspace-nodes.md)
and [Orchestration kernel](./orchestration-kernel.md).
