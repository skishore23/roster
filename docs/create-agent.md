# Create an Agent or Roster

This is the primary developer experience for building agents in Roster.

The default flow is:

1. scaffold a single-file agent
2. edit receipts, view, actions, and goal
3. publish the SpacetimeDB module and run it
4. inspect the durable stream and replay an exact sequence

## Prerequisites

From repo root:

```bash
npm install
npm --prefix spacetimedb install
npm run spacetime:build
npm run spacetime:publish:local
npm run spacetime:generate
npm run build
```

Use either command style:

- `roster ...` (if the `roster` bin is available in your shell)
- `npm run cli -- ...` (always works in this repo)

## 1) Scaffold an agent

```bash
roster new my-agent --template basic
```

Available templates:

- `basic`
- `assistant-tool`
- `human-loop`
- `merge`
- `adaptive-graph` — a bounded multi-agent application using
  `defineRosterPlatform` and `createRosterRootTask`

The first four create one headless agent. To start a coordinated roster instead:

```bash
roster new research-roster --template adaptive-graph
```

This creates `src/rosters/research-roster.roster.ts` with named workspace nodes,
capabilities, complete execution limits, and a provider-neutral root task. A
coordinator may expand the graph later without gaining control of runtime
leases, receipts, budgets, accepted outcomes, or certification. Edit the small
example platform rather than adding a second
orchestration framework. This file is a reusable roster definition, not an HTTP
application by itself; import it from an application module or worker that owns
the capability implementations and run lifecycle.

Single-agent scaffold output:

- `src/agents/my-agent.agent.ts`

No central registry or manifest edits are required. Templates come from one
declarative registry in the CLI, and every registered template is compile-tested.

Generated agents import `roster/authoring`; coordinated rosters import
`roster/orchestration`. These are public package exports, so the same files work
in a separate ESM project with the built package installed. `roster dev` starts
the server shipped with that package while keeping the consumer project as its
working directory. The consumer still needs a configured SpacetimeDB backend.

## 2) Authoring model

Every agent follows the same shape:

- `receipts`: typed event declarations
- `view`: pure fold/query helpers over receipts
- `actions`: runnable units that emit receipts
- `goal`: completion predicate

At the orchestration boundary, every domain participant is normalized to a durable
workspace node. Existing agents use the `roster-native` runtime by default; a
runtime adapter can later execute the same logical node through a CLI, sandbox,
or remote service without changing its tasks or artifacts. See
[Workspace Nodes](./workspace-nodes.md).

Coordinated rosters use the breaking platform-v3 contract:
`WorkspaceNode`, `DynamicTaskDefinition`, `AcceptedTaskOutcome`,
`RunExecutionPolicy`, and `nodeId` across tasks, artifacts, and composition.
The domain registry exposes only `node`, `nodesFor`, `assertNodeAssignment`,
and `extendNodes`; platform v3 does not dual-read agent-named orchestration
payloads. Use `defineRosterPlatform` and `createRosterRootTask` for a dynamic
multi-node application. The standalone `defineAgent` routes and
`agents/<agentId>` stream paths documented below identify an agent application,
not an orchestration participant field.

The domain definition remains a pure receipt reducer. The production runtime stores its stream metadata and ordered receipts in SpacetimeDB, while the generated browser client projects the same chain at live head or an exact `at` sequence.

Example:

```ts
import { defineAgent, receipt, assistant, human } from "../sdk/index.js";

export default defineAgent({
  id: "writer",
  version: "1.0.0",

  receipts: {
    "prompt.received": receipt<{ prompt: string }>(),
    "draft.generated": receipt<{ text: string }>(),
    "draft.approved": receipt<{ text: string }>(),
  },

  view: ({ on }) => ({
    prompt: on("prompt.received").last(),
    draft: on("draft.generated").last(),
    done: on("draft.approved").exists(),
  }),

  actions: () => [
    assistant("draft", {
      when: ({ view }) => Boolean(view.prompt) && !view.draft,
      run: async ({ view, emit }) => {
        emit("draft.generated", { text: `Draft for: ${view.prompt?.prompt ?? ""}` });
      },
    }),
    human("approve", {
      when: ({ view }) => Boolean(view.draft) && !view.done,
      run: async ({ view, emit }) => {
        emit("draft.approved", { text: view.draft?.text ?? "" });
      },
    }),
  ],

  goal: ({ view }) => view.done,
});
```

## Headless specs and application modules

Files in `src/agents/*.agent.ts` have two explicit extension shapes:

- A **headless spec** is the object returned by `defineAgent`. It owns receipts,
  views, actions, and a goal. Both `roster run` and the server discover it. In
  `roster dev`, open `/agents/<id>` for the minimal run page, POST JSON such as
  `{ "problem": "...", "runId": "optional" }` to `/agents/<id>/run`, or GET
  `/agents/<id>/metadata` for its machine-readable contract.
- An **application module** default-exports an `AgentModuleFactory` (or an
  `AgentRouteModule`) and registers a purpose-built UI/API. Use this shape when
  the agent needs custom forms, projections, assets, or job handling.

The loader normalizes both into a discriminated `DiscoveredAgentModule` with
`moduleType: "headless" | "application"`. Duplicate IDs across either shape
fail server startup instead of silently shadowing a module. A malformed export
is not treated as a valid agent.

The shared run page includes a per-process CSRF token. Programmatic JSON calls
read the token from the page and send it as `x-roster-csrf`; problem, run ID, and
stream inputs are bounded and validated before a durable run is created.

Application factories receive typed dependency accessors:

```ts
const factory: AgentModuleFactory = (ctx) => createMyRoute({
  runtime: ctx.runtime<MyRuntime>("my-agent"),
  prompts: ctx.prompt<MyPromptConfig>("my-agent"),
  helper: ctx.helper("my-helper", isMyHelper),
});
```

Required runtime and prompt lookups produce named startup errors. Factories use
these typed accessors directly; dependency tables are not exposed as a second
public API.

## 3) Run your agent

For a scaffolded `defineAgent` file:

```bash
roster run my-agent --problem "Write a short summary"
```

Defaults:

- stream: `agents/<agentId>`
- run stream: `agents/<agentId>/runs/<runId>`

Optional flags:

- `--stream <stream>`
- `--run-id <runId>`

The runtime creates or reuses the caller's Roster workspace, ensures the stream metadata, and appends each receipt through an atomic reducer. It does not keep an alternate production authority.

## 4) Inspect and replay

Use receipts as your debugging surface:

```bash
roster inspect <run-id-or-stream>
roster trace <run-id-or-stream>
roster replay <run-id-or-stream>
roster fork <run-id-or-stream> --at <index>
```

All agent pages place Start, Previous, Play/Pause, Next, Live, scrub, and speed controls at the top of the page. Omitting `at` follows the live head. Supplying `at=<sequence>` renders a stable historical prefix while the client continues receiving newer rows for a later return to Live.

Queue operations:

```bash
roster jobs
roster abort <job-id>
```

Browser and worker clients should subscribe to caller-scoped views such as `my_event_streams`, `my_stream_receipts`, `my_stream_branches`, `my_roster_jobs`, and `my_roster_job_events`. Wait for the subscription's initial snapshot before showing Live, then render from the SDK cache and row callbacks.

## 5) Delegate bounded child work

An agent may expand a claimed task into a durable child graph when it discovers genuinely independent work. Expansion is not process creation and is never unbounded:

1. Create the bounded run with `ensureRosterExecution`.
2. Advertise worker capabilities with `setRosterWorkerCapabilities`.
3. Enqueue the root with `enqueueRosterTask`.
4. Claim the parent using `claimRosterTask` and retain its fence.
5. Call `expandAndDelegateRosterTask` once with a stable expansion key,
   bounded child definitions, and one explicit continuation.
6. Let Roster atomically release the parent lease and promote eligible work.
7. Accept child outcomes with the current fence, then let the continuation join
   them and the coordinator certify or stop the run.

The reducer rejects cycles, missing dependencies, duplicate semantic tasks,
stale fences, unauthorized capabilities, and any expansion beyond the run
policy. `maxInflight` separately caps active work, while task claim reserves
estimated cost before an external call begins.

## 6) Dev loop

For server-driven workflows and UI routes:

```bash
roster dev
```

Headless specs and application route modules are both auto-discovered from
`src/agents/*.agent.ts`.

## Stream model

Agent streams:

- `agents/<agentId>`
- `agents/<agentId>/runs/<runId>`
- `agents/<agentId>/runs/<runId>/branches/<branchId>`
- `agents/<agentId>/runs/<runId>/sub/<subRunId>`

Queue streams:

- `jobs` (index)
- `jobs/<jobId>` (authoritative lifecycle)

## Authoring checklist

- Emit meaningful receipts; avoid hidden mutable state.
- Keep `view` logic pure and deterministic.
- Keep side effects inside action `run` functions.
- Keep long model, tool, rendering, and storage work in external workers; reducers only validate and commit bounded state.
- Make action readiness (`when`) explicit.
- Treat dependencies, capabilities, leases, and run limits as correctness constraints rather than hints.
- Give enqueue, expansion, provider, artifact, and completion operations stable idempotency keys.
- Require the current lease fence for heartbeat, completion, failure, and task expansion.
- Prefer stable receipt type names so replay/traces stay readable.

## Common issues

- `receipt: command not found`
  - Use `npm run cli -- <command>`.

- Agent runs but never completes
  - Check `goal(...)`, `when(...)`, dependency readiness, advertised capabilities, and the run's task/in-flight limits with `roster trace` and the task graph projection.

- Browser remains in Syncing
  - Confirm the public database URI is browser-reachable, the workspace capability was redeemed, and the run-filtered subscription reached its initial snapshot.

- Nothing appears in routes
  - Confirm the file ends in `.agent.ts` and default-exports either a valid
    `defineAgent` spec or an application route factory/module. Headless specs
    appear at `/agents/<id>`; application modules choose their own paths.
