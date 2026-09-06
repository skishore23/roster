import type { Runtime } from "../core/runtime.js";
import type { AgentLoaderContext, AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import type { TheoremCmd, TheoremEvent, TheoremState } from "../modules/theorem.js";
import { DEFAULT_OPENAI_MODEL } from "../models.js";
import { runTheoremRoster } from "./theorem.js";
import { createTheoremRoute } from "./theorem.agent.js";
import { SpacetimeWebAccess } from "../adapters/spacetimedb-web-access.js";

const AXIOM_ROSTER_EXAMPLES = [
  {
    id: "starter",
    label: "Starter proof",
    problem: "Prove theorem foo : 1 = 1. Keep the normal theorem roster search and let verifier or explorers delegate Lean validation to Axiom when useful.",
  },
  {
    id: "append-length",
    label: "List append",
    problem: "In Lean 4 with Mathlib, prove theorem list_length_append_nat (xs ys : List Nat) : List.length (xs ++ ys) = List.length xs + List.length ys. Use Axiom workers for real Lean checking or repair when needed.",
  },
  {
    id: "repair",
    label: "Repair path",
    problem: "Start with a flawed Lean proof of Nat.add_comm for a constrained case, branch aggressively, and use Axiom workers to repair or reject weak proof attempts before synthesis.",
  },
  {
    id: "reject-false",
    label: "Reject false theorem",
    problem: "Investigate theorem bad : 2 = 3. Use the normal theorem roster debate, but require an Axiom worker to explain the verification failure or disproval path.",
  },
] as const;

const factory: AgentModuleFactory = (ctx: AgentLoaderContext): AgentRouteModule =>
  createTheoremRoute({
    runtime: ctx.runtime<Runtime<TheoremCmd, TheoremEvent, TheoremState>>("theorem"),
    llmText: ctx.llmText,
    prompts: ctx.prompt<Parameters<typeof runTheoremRoster>[0]["prompts"]>("theorem"),
    promptHash: ctx.promptHashes.theorem ?? "",
    promptPath: ctx.promptPaths.theorem ?? "prompts/theorem.prompts.json",
    model: ctx.models.theorem ?? DEFAULT_OPENAI_MODEL,
    enqueueJob: ctx.enqueueJob,
    webAccess: ctx.helper("spacetimeWebAccess", (value): value is SpacetimeWebAccess => value instanceof SpacetimeWebAccess),
  }, {
    routeId: "axiom",
    basePath: "/axiom",
    defaultStream: "agents/axiom-roster",
    jobAgentId: "axiom-roster",
    jobKind: "axiom-roster.run",
    jobIdPrefix: "axiom_roster",
    title: "Roster - Verified Proof",
    brand: "Roster",
    brandSub: "Evidence hierarchy / formal proof",
    controlsTitle: "Verified proof coordination",
    controlsSub: "Hierarchical search and repair with mandatory AXLE evidence at the acceptance boundary.",
    runButtonLabel: "Run Verified Proof",
    examples: AXIOM_ROSTER_EXAMPLES,
  });

export default factory;
