/**
 * Provider-neutral contracts shared by the engine and the public SDK.
 *
 * The engine owns these shapes. SDK modules provide the authoring helpers and
 * re-export the contracts, keeping the dependency direction core -> engine ->
 * SDK instead of making the engine depend on its public facade.
 */
export type ActionKind = "action" | "assistant" | "tool" | "human";

export type ActionRunContext<View, EmitFn> = {
  readonly view: View;
  readonly emit: EmitFn;
};

export type AgentAction<
  View,
  EmitFn = (type: string, body: Record<string, unknown>) => void,
> = {
  readonly id: string;
  readonly kind: ActionKind;
  readonly when?: (ctx: { readonly view: View }) => boolean;
  readonly run: (ctx: ActionRunContext<View, EmitFn>) => Promise<void> | void;
  readonly watch?: ReadonlyArray<string>;
  readonly exclusive?: boolean;
  readonly maxConcurrency?: number;
};

export type MergeScoreVector = Readonly<Record<string, number>>;

export type MergeCandidate = {
  readonly id: string;
  readonly meta?: Record<string, unknown>;
};

export type MergeDecision = {
  readonly candidateId: string;
  readonly reason?: string;
};

export type MergePolicy<Ctx, Evidence = unknown> = {
  readonly id: string;
  readonly version: string;
  readonly shouldRecompute?: (ctx: Ctx) => boolean;
  readonly candidates: (ctx: Ctx) => ReadonlyArray<MergeCandidate>;
  readonly evidence: (ctx: Ctx) => Evidence;
  readonly score: (
    candidate: MergeCandidate,
    evidence: Evidence,
    ctx: Ctx,
  ) => MergeScoreVector;
  readonly choose: (
    scored: ReadonlyArray<{
      readonly candidate: MergeCandidate;
      readonly score: MergeScoreVector;
    }>,
  ) => MergeDecision;
};

export type ReceiptDeclaration<T> = {
  readonly __receipt: true;
  readonly sample?: T;
};

export type ReceiptBody<Declaration> =
  Declaration extends ReceiptDeclaration<infer Body> ? Body : never;
