# Canvas Roster

Canvas Roster is a model-driven collaborative vector studio at `/canvas`. A user can describe any visual subject. An Art Director model creates a prompt-specific scene contract, then 3–8 specialist artist calls publish independently owned SVG patches into a shared Yjs ledger. Canvas uses the same SpacetimeDB workspace, receipt, task, lease, and direct-subscription architecture as the other Roster pages.

Canvas is part of the breaking Roster v2 protocol surface. It consumes only
Roster v2 receipts and schemas. Recreate development runs after upgrading
rather than mixing protocol generations in one stream.

## Requirements

Set `OPENAI_API_KEY` before starting the server. Canvas Roster does not silently substitute a fixed drawing when model access is unavailable; the run fails with an explicit status.

Set a shared `CANVAS_CSRF_SECRET` of at least 32 characters on every production application replica. Canvas run forms carry a signed, short-lived token, so in-app browser bridges may submit even when they report a nonstandard fetch site while foreign HTTP(S) origins remain rejected. Development generates an ephemeral process-local secret automatically.

Publish the SpacetimeDB module before starting Roster. Application startup fails if its configured database is unavailable. See [SpacetimeDB Control Plane](./spacetimedb.md) for local setup, identity persistence, caller-scoped subscriptions, and production requirements.

Canvas uses responsibility-specific model routing by default:

- Art Director: `gpt-5.6-terra`
- parallel painters: `gpt-5.6-luna`
- subject/prompt validator: `gpt-5.6-terra`
- composition validator: `gpt-5.6-luna`
- consistency/finish validator: `gpt-5.6-luna`
- first Finishing Artist repair: `gpt-5.6-luna`
- final/rescue repair escalation: `gpt-5.6-terra`

This balanced route keeps the high-volume painter frontier and two narrower validator calls on the cost-sensitive tier, spends the stronger model on planning and semantic fidelity, and escalates repair strength only after a first repair fails. The three model validators run in parallel against the same rendered PNG. No additional judge-model call is used; a deterministic council projector aggregates their independently owned dimensions. `CANVAS_MODEL` pins every role to one model for a baseline or cost comparison. `CANVAS_DIRECTOR_MODEL`, `CANVAS_PAINTER_MODEL`, `CANVAS_CRITIC_MODEL`, `CANVAS_FINISHER_MODEL`, and `CANVAS_FINISHER_ESCALATION_MODEL` override individual roles and take precedence over `CANVAS_MODEL`. Roster v2 does not infer Canvas routing from a global provider model variable. The live agent cards and `run.configured` receipt expose the routing bound to the actual model adapter so a run never merely claims to use a heterogeneous team.

Every provider attempt reserves cost against the active fenced task before the request, forwards that reservation as `X-Client-Request-Id`, and settles reported input, cached-input, and output usage afterward. `CANVAS_RUN_BUDGET_MICROS` sets the per-run ceiling. `CANVAS_INPUT_COST_MICROS_PER_MILLION_TOKENS`, `CANVAS_CACHED_INPUT_COST_MICROS_PER_MILLION_TOKENS`, and `CANVAS_OUTPUT_COST_MICROS_PER_MILLION_TOKENS` let operators install their current account rate card; built-in values are deliberately conservative guards, not a claim about current pricing. Clearly rejected requests release their reservation. Ambiguous timeouts, network failures, 5xx responses, and settlement failures retain it and stop rather than risk an unaccounted duplicate model call.

## Attached studio members

Canvas uses the same member and runtime-placement APIs as Coding. A logical Art
Director, painter, critic, or Finishing Artist may execute through
`attachCodex`, `attachClaude`, `attachPi`, `attachHermes`, `attachCommand`,
`attachA2A`, or a registered custom runtime without creating a second Canvas
workflow. The built-in Responses API path remains the default
`roster-native` implementation.

`runCanvasRoster` accepts a shared `NodeRuntimeRegistry` and a
`runtimeForDemand` resolver for newly materialized specialists. For example, a
caller can keep the scene contract unchanged while placing painters on Pi,
independent critics on Hermes, and a remote specialty reviewer on A2A:

```ts
import {
  attachA2A,
  attachHermes,
  attachPi,
  createStandardNodeRuntimeRegistry,
  rosterAgentRuntime,
} from "roster/runtime";

const nodeRuntimes = createStandardNodeRuntimeRegistry();
const runtimeForDemand = (demand: { capability: string }) => {
  if (demand.capability === "critique.subject") {
    return rosterAgentRuntime(attachA2A({
      endpoint: "https://agents.example.com/canvas",
    }));
  }
  if (demand.capability.startsWith("critique.")) {
    return rosterAgentRuntime(attachHermes({ provider: "openrouter" }));
  }
  return rosterAgentRuntime(attachPi({ tools: ["read"] }));
};

// Pass both nodeRuntimes and runtimeForDemand to runCanvasRoster.
```

`runCanvasRoster` also requires one explicit execution plane: a
`TaskGraphControl`, a durability-compatible `DataReferenceStore`, and a
task-fenced `createTaskContext` factory. The production route attaches
`SpacetimeTaskGraphControl` to the Canvas execution, stores accepted task values
under `$DATA_DIR/roster-platform/data-references`, and persists the bounded
shared workspace under `$DATA_DIR/roster-platform/shared-workspaces`. The
platform initializes that graph once with the real painter, deliberation, and
composition seeds; callers must not preinitialize it with an empty seed set.

For saved preferences or access-aware selection, define named
`NodeRuntimeProfile`s with `defineRuntimePlacementPolicy`, resolve once with
`resolveRuntimePlacement`, and supply the resolved runtime through
`runtimeForDemand`. Persist the effective binding before dispatch. Do not
re-resolve a changed policy while resuming an existing Canvas run, and never
put provider credentials in a profile or runtime envelope.

### Trusted task-acceptance boundary

An attached agent owns generation only. It returns a draft matching the task's
explicit artifact result contract; it cannot write the Yjs ledger, emit an accepted patch,
resolve a conflict, advance the scene frontier, or certify the composition.
The versioned task acceptance policy is the trusted, domain-owned boundary that
Roster invokes for both native and external execution before an
`AcceptedTaskOutcome` is published.

For a painter task, Canvas decodes and normalizes the returned patch, verifies
that its run, member, task, and semantic-part identities match the exact
assignment, admits it to `CanvasSceneLedger`, and only then emits
`scene.patch.applied`. The built-in model adapter constructs server-owned object
and patch identities before this boundary. An external draft must satisfy the
same contract; mismatched ownership or malformed geometry is rejected before it
can enter shared state.

```ts
acceptance.register(
  { policyId: "canvas.patch.accept", policyVersion: "3" },
  async ({ definition, attempt, draft }) => {
    const patch = normalizeCanvasPatch(draft);
    const assignment = currentCanvasAssignment(artist, part);
    assertAssignedCanvasPatch(patch, assignment);
    ledger.add(patch, assignment.provenance);
    await emitScenePatchApplied(patch);
    return createAcceptedCanvasPatchOutcome({
      definition,
      attempt,
      patch,
    });
  },
);
```

The snippet names the boundary rather than literal private helpers. In
production the acceptance hook must remain bounded and idempotent so a retry
cannot apply a patch twice. Composite control such as validation-council
projection, peer support, repair authorization, and certification stays in
Roster-owned code; an attached critic contributes a bounded report or vote but
does not replace that control loop. Cost reservation also remains outside the
adapter and occurs under the active fenced task before provider dispatch.

## Prompt pipeline

Base prompt templates live in `prompts/canvas.prompts.json` and are loaded by `src/prompts/canvas.ts`; the model adapter appends the schema-coupled feature-ownership and scaffold contracts so prompt text and structured validation advance together.

1. The Art Director receives the visual brief, the exact requested team size, and the 1000×1000 canvas contract. It returns the subject, focal bounds, art direction, palette, shared anchors, a versioned low-detail composition scaffold, and 3–8 prompt-specific painter assignments. The scaffold fixes the dominant silhouette, focal scale, horizon, balance, negative space, and important overlaps before painter fan-out. Seven- and eight-painter plans receive an additional high-capacity contract: the extra roles must add visible secondary subjects, foreground depth, material cues, environmental storytelling, or lighting detail rather than duplicate the primary silhouette.
2. Painter ownership is semantic rather than spatial. Every painter declares a `featureKind` and one or more globally exclusive `ownedFeatures`; its region is a safety envelope that may overlap other feature envelopes where forms attach or occlude. Grid-cell and isolated-section ownership is rejected by the model contract.
3. The scaffold is published as the shared `composition.scaffold` artifact. Every painter receives the exact same immutable plan and a rendered scaffold PNG, then starts concurrently. `coordinatesWith` records shared-anchor relationships but never creates a scheduling dependency.
4. Each assignment also has a semantic part ID, composition role, paint mode, maximum footprint, protected anchors, and bleed policy. These structured fields keep hierarchy and occlusion rules out of truncation-prone prose.
5. Each painter returns schema-constrained visual marks. Structural roles are capped at 24 marks; detail and accent roles may use up to 32, with a 256-object active-scene ceiling. The server—not the model or runtime adapter—stamps object IDs, semantic IDs, member ownership, task ownership, part ownership, and layer boundaries. The trusted `acceptOutput` boundary then verifies that exact assignment before ledger admission. It also enforces non-path region/footprint bounds and low-opacity rules for transparent shells, linework, and accents.
6. The Yjs ledger merges the independent patches. Deterministic structural validation checks plan coverage, safe renderability, ownership, layer boundaries, and convergence.
7. Four independent validator roles inspect the exact scene hash: the deterministic structural projector, a strong-model subject validator, a lower-cost composition validator, and a lower-cost consistency validator. Their reports are add-only Yjs updates. Delivery order cannot change the result, and conflicting reports from one validator remain explicit conflicts.
8. The deterministic council projector requires all named specialties. Subject identity owns prompt match and recognizability; composition owns hierarchy and coherence; consistency owns seams, line weight, palette, lighting, repeated forms, detail density, and polish. There is no all-purpose judge model and no extra synthesis call.
9. Actionable minor consistency findings create one bounded polish frontier while budget remains. They are not silently discarded merely because an average score passes. After bounded attempts, a recognizable scene can still complete with the exact remaining findings preserved as notes.
10. The council's lead validator publishes a CRDT control proposal—not a command—against the exact scene frontier. Other artist roles independently endorse, object, abstain, withdraw, or counter-propose. Production peer votes are separate structured model calls routed through the lower-cost painter/finisher tier; each receives its own responsibility, the exact bounded action, and the council evidence.
11. A conflict-free peer-supported proposal is mechanically certified before the generic effects runtime may create repair work or certify the scene. An empty proposal frontier is never treated as certification. If a Finishing Artist objects and the endorsement threshold is not met, the findings are routed to a bounded polish attempt rather than ignored.
12. Validators receive the back-to-front painter ownership map so they assign a foreground contact, rim, or highlight fix to a layer that can actually perform it. Missing subjects, wrong counts, broken relationships, severe occlusion, and unreadability are blocking; stylistic preferences remain non-blocking notes after the bounded polish opportunity.
13. If the bounded finishing budget cannot clear the quality target but the PNG remains recognizable, prompt-related, renderable, and structurally valid, the run finishes as **Completed with visual notes**. Hard failure is reserved for an unusable/unrecognizable render, invalid geometry, unresolved Yjs conflicts, or runtime/model failure.

All model calls use the Responses API structured-output adapter in `src/adapters/openai.ts`, with a per-call model override stamped by studio responsibility. Invalid structured or semantically inconsistent output receives one correction attempt. If a lower-cost painter, specialty validator, peer-control vote, or first repair still violates its structured domain contract, only that task is retried with the stronger finishing model; the whole studio is not upgraded. Authentication, budget, rate-limit, and uncertain provider failures are never disguised as format errors or automatically duplicated. A transient rate-limit rejection receives bounded provider backoff, while a hard HTTP 429 quota or billing failure stops immediately, trips the shared provider admission circuit, and is reported separately. While that circuit is blocked, Canvas disables its form and rejects submissions before creating a durable run. A failed attempt records a structured failure class and retryability in its terminal receipt; the displayed message remains sanitized. Failed terminal runs remain immutable, so the studio offers an explicit fresh-run retry using the retained prompt and artist count. Score thresholds are applied server-side without asking the critic to inflate a score on unchanged pixels.

## Durable realtime flow

`POST /canvas/run` creates the run in SpacetimeDB before any model work begins, creates a bounded viewer capability, launches the coordinator, and redirects to the run page with the raw capability in `#access=…`. Because URL fragments do not reach the application server, the secret is absent from its request logs. The browser consumes and removes the fragment immediately, hashes it, joins the run as a read-only viewer, and preserves its own SpacetimeDB identity token for reconnects.

The browser then subscribes directly to exact-run filters over `my_canvas_run_ui`, `my_scene_plan`, `my_canvas_agents`, `my_canvas_task_statuses`, `my_scene_objects`, `my_scene_reviews`, and `my_canvas_activity`. These views expose the live visual frontier and collaboration state without exposing the full receipt log, leases, member identities, capability verifier, or worker-only patch data. Row insert/update/delete callbacks drive incremental SVG and dashboard changes; the application server does not proxy each update.

The connection indicator distinguishes initial connection, atomic snapshot sync, live delivery, reconnecting, access failure, and disabled realtime. Agent cards and grouped team counts make parallel activity visible, while the bounded activity feed shows proposals, endorsements, objections, projected conflicts, certifications, planning, painting, review, and repair. Scene objects always render in canonical layer/rank order, so concurrent completion order cannot corrupt the composition.

Every typed Canvas event is appended and projected transactionally through SpacetimeDB. On startup, replicas subscribe to the durable dispatch frontier and compete for one fenced receipt-authority lease per non-terminal run; this lease authorizes event commits and final frontier publication, but it does not schedule a second task graph. `runCanvasRoster` owns the single durable graph lifecycle. Its bounded graph snapshots are projected as `task.graph.projected` receipts, making ready, leased, accepted, failed, waiting, and dynamically expanded work visible without recreating legacy task lifecycle receipts. Discovered repair work is atomically expanded into its own `compose.final` child task plus an explicit deliberation continuation, owned and fenced to the Finishing Artist rather than borrowing a validator lease. The long-lived deliberation task therefore has no competing parent wall-clock timeout: provider timeouts, child leases, bounded decision frontiers, graph depth/fan-out, and the run budget are independent limits. The winner folds durable receipts, reconstructs accepted patches into the scene ledger, preserves completed painter outcomes through durable data references, and resumes the same graph after process loss. A completed run is never launched again. Roster fails closed when its control plane is unavailable.

## Current canvas contract

Generated art can use `rect`, `circle`, `ellipse`, `line`, `polygon`, `polyline`, and parsed SVG `path` marks. Rectangles support bounded `rx`/`ry` corners. Marks may use separate fill/stroke opacity, constrained caps and joins, and numeric dash arrays. Fills may be a solid six-digit color, `none`, or one typed linear/radial gradient with 2–4 ordered stops and normalized coordinates. Gradient definitions receive deterministic server IDs; models cannot supply raw `<defs>` or `url(...)` references.

The validation council is a quality gate, not a guarantee of professional illustration. It can reject and repair obvious hierarchy, occlusion, prompt-match, consistency, and polish failures, but the available medium remains constrained vector geometry. Transparent-shell painters must publish a readable, contrast-checked main contour. Photorealism, raster textures, arbitrary fonts, masks, blur, filters, imported images, transforms, arbitrary CSS, and freehand browser editing are not currently supported.

Every path is parsed as `M/L/H/V/C/S/Q/T/A/Z` geometry before publication. Curve control hulls and swept elliptical-arc extrema contribute to the same region and maximum-footprint checks as primitive marks, closing the former path-only bounds gap.

The live SVG is re-sorted by canonical layer and rank after every streamed patch. Painter completion order never becomes paint order, so the browser displays the same frontier every validator reviews.

The current Yjs document coordinates one server-side run and preserves immutable initial and replacement patches. Its accepted frontier is recoverable from SpacetimeDB projections after process loss. The browser consumes the sanitized scene-object projection rather than joining the Yjs document itself; browser-to-browser editing, cursors/awareness, and client-authored Yjs sessions remain future work.

The per-run receipt authority is durably leased and fenced across replicas. Scheduling, retries, joins, accepted outcomes, and repair expansion belong to the single shared bounded task graph, whose specialist calls carry explicit dependencies, capabilities, and accepted data references. Keep logical population separate from provider concurrency: increasing artists should add visibly distinct assignments, while `maxInflight`, task depth/fan-out, retry count, and run budget remain hard ceilings. Capability links are bearer access, so production also needs TLS, application login/OIDC, short lifetimes, account quotas, and service identities stored in a secret manager. Keep large render artifacts and raw provider payloads in object storage rather than database rows.

## Tests

```bash
node --import tsx --test --test-concurrency=1 \
  tests/smoke/canvas-model.test.ts \
  tests/smoke/canvas-core.test.ts \
  tests/smoke/canvas-workflow.test.ts \
  tests/smoke/canvas-cutover-contract.test.ts
```

The tests use injected structured-model fixtures for non-cat briefs, so they verify arbitrary prompt planning without requiring network access.
