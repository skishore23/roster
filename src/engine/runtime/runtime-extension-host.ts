import {
  compileRuntimeExtensionPlan,
  normalizeServiceReference,
  runtimeServiceIdentity,
  type CompiledRuntimeExtension,
  type RuntimeExtensionActivationContext,
  type RuntimeExtensionDefinition,
  type RuntimeExtensionGenerationManifest,
  type RuntimeExtensionLifecycleScope,
  type RuntimeExtensionLimits,
  type RuntimeExtensionPlan,
  type RuntimeServiceKey,
  type RuntimeServiceReference,
} from "./runtime-extension.js";
import { RuntimeEffectScope } from "./runtime-effect-scope.js";

const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const MAX_SCOPE_ID_LENGTH = 240;

class LocalRuntimeExtensionScope implements RuntimeExtensionLifecycleScope {
  readonly #scope: RuntimeEffectScope;

  constructor(activationId: string) {
    this.#scope = new RuntimeEffectScope({
      owner: { kind: "activation", activationId },
    });
  }

  get disposed(): boolean {
    return this.#scope.state !== "open";
  }

  defer(cleanup: () => void | Promise<void>): void {
    this.#scope.defer(cleanup);
  }

  dispose(): Promise<void> {
    return this.#scope.close();
  }
}

type ActiveRuntimeExtension = {
  readonly compiled: CompiledRuntimeExtension;
  readonly scope: LocalRuntimeExtensionScope;
  readonly services: ReadonlyMap<string, unknown>;
};

export type RuntimeServiceViewScope = {
  readonly scopeId: string;
  readonly services?: ReadonlyArray<RuntimeServiceReference>;
};

export interface RuntimeServiceView {
  readonly scopeId: string;
  readonly generationId: string;
  readonly services: ReadonlyArray<RuntimeServiceReference>;
  has(service: RuntimeServiceReference): boolean;
  get<Value>(service: RuntimeServiceKey<Value>): Value;
  attenuate(scope: RuntimeServiceViewScope): RuntimeServiceView;
}

export type RuntimeExtensionWithdrawalFailure = {
  readonly extensionId: string;
  readonly error: unknown;
};

export type RuntimeExtensionReconciliationResult = {
  readonly changed: boolean;
  readonly generation: RuntimeExtensionGenerationManifest;
  readonly activated: ReadonlyArray<string>;
  readonly withdrawn: ReadonlyArray<string>;
  readonly withdrawalFailures: ReadonlyArray<RuntimeExtensionWithdrawalFailure>;
};

const boundedScopeId = (scopeId: string): string => {
  const normalized = scopeId.trim();
  if (!SCOPE_PATTERN.test(normalized) || normalized.length > MAX_SCOPE_ID_LENGTH) {
    throw new Error("Runtime service view scopeId must be a bounded identifier");
  }
  return normalized;
};

const frozenServiceReferences = (
  services: Iterable<RuntimeServiceReference>,
): ReadonlyArray<RuntimeServiceReference> => Object.freeze(
  [...services]
    .map(normalizeServiceReference)
    .sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version)),
);

const emptyPlan = (
  limits: Partial<RuntimeExtensionLimits>,
): RuntimeExtensionPlan => compileRuntimeExtensionPlan([], limits);

/**
 * Process-local runtime extension authority. It never schedules tasks, grants
 * capabilities, mutates WorkspaceNode identity, or persists service values.
 */
export class RuntimeExtensionHost {
  readonly #limits: Partial<RuntimeExtensionLimits>;
  #plan: RuntimeExtensionPlan;
  #active = new Map<string, ActiveRuntimeExtension>();
  #services = new Map<string, unknown>();
  #commitEpoch = 0;
  #reconciliationTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly limits?: Partial<RuntimeExtensionLimits> } = {}) {
    this.#limits = options.limits ?? {};
    this.#plan = emptyPlan(this.#limits);
  }

  generation(): RuntimeExtensionGenerationManifest {
    return this.#plan.manifest;
  }

  view(scope: RuntimeServiceViewScope = { scopeId: "runtime" }): RuntimeServiceView {
    const allowed = scope.services
      ? new Set(scope.services.map(runtimeServiceIdentity))
      : new Set(this.#plan.providerByService.keys());
    return this.#createView(
      boundedScopeId(scope.scopeId),
      allowed,
      this.#commitEpoch,
      this.#plan.manifest.generationId,
      this.#services,
    );
  }

  reconcile(
    definitions: ReadonlyArray<RuntimeExtensionDefinition>,
  ): Promise<RuntimeExtensionReconciliationResult> {
    let desired: RuntimeExtensionPlan;
    try {
      // Compile at the API boundary so caller mutation while an earlier
      // reconciliation drains cannot change this requested desired state.
      desired = compileRuntimeExtensionPlan(definitions, this.#limits);
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.#reconciliationTail.then(() => this.#reconcile(desired));
    this.#reconciliationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): Promise<RuntimeExtensionReconciliationResult> {
    return this.reconcile([]);
  }

  async #reconcile(
    desired: RuntimeExtensionPlan,
  ): Promise<RuntimeExtensionReconciliationResult> {
    if (desired.manifest.generationId === this.#plan.manifest.generationId) {
      return Object.freeze({
        changed: false,
        generation: this.#plan.manifest,
        activated: Object.freeze([]),
        withdrawn: Object.freeze([]),
        withdrawalFailures: Object.freeze([]),
      });
    }

    const affected = this.#affectedDesiredModules(desired);
    const candidate = new Map<string, ActiveRuntimeExtension>();
    for (const moduleId of desired.activationOrder) {
      const current = this.#active.get(moduleId);
      if (current && !affected.has(moduleId)) candidate.set(moduleId, current);
    }
    const candidateServices = this.#servicesFor(candidate, desired);
    const staged: ActiveRuntimeExtension[] = [];
    const activated: string[] = [];
    try {
      for (const moduleId of desired.activationOrder) {
        if (!affected.has(moduleId)) continue;
        const compiled = desired.modules.get(moduleId)!;
        const active = await this.#activate(compiled, candidateServices);
        candidate.set(moduleId, active);
        staged.push(active);
        activated.push(moduleId);
        for (const [serviceId, value] of active.services) candidateServices.set(serviceId, value);
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const active of [...staged].reverse()) {
        try {
          await active.scope.dispose();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Runtime extension staging and rollback both failed",
        );
      }
      throw error;
    }

    const oldPlan = this.#plan;
    const oldActive = this.#active;
    const withdrawing = new Set<string>(
      [...oldActive.keys()].filter((moduleId) =>
        !candidate.has(moduleId) || candidate.get(moduleId) !== oldActive.get(moduleId)),
    );

    // This assignment is the only committed-view transition. Staged values are
    // never observable from host views before the complete candidate exists.
    this.#plan = desired;
    this.#active = candidate;
    this.#services = candidateServices;
    this.#commitEpoch += 1;

    const withdrawn: string[] = [];
    const withdrawalFailures: RuntimeExtensionWithdrawalFailure[] = [];
    for (const moduleId of [...oldPlan.activationOrder].reverse()) {
      if (!withdrawing.has(moduleId)) continue;
      const old = oldActive.get(moduleId);
      if (!old) continue;
      withdrawn.push(moduleId);
      try {
        await old.scope.dispose();
      } catch (error) {
        withdrawalFailures.push(Object.freeze({ extensionId: moduleId, error }));
      }
    }

    return Object.freeze({
      changed: true,
      generation: desired.manifest,
      activated: Object.freeze(activated),
      withdrawn: Object.freeze(withdrawn),
      withdrawalFailures: Object.freeze(withdrawalFailures),
    });
  }

  #affectedDesiredModules(desired: RuntimeExtensionPlan): Set<string> {
    const affected = new Set<string>();
    for (const moduleId of desired.activationOrder) {
      const next = desired.modules.get(moduleId)!;
      const current = this.#plan.modules.get(moduleId);
      if (!current || current.manifest.manifestId !== next.manifest.manifestId) {
        affected.add(moduleId);
      }
    }
    const queue = [...affected].sort();
    while (queue.length > 0) {
      const moduleId = queue.shift()!;
      for (const dependent of desired.dependentsByModule.get(moduleId) ?? []) {
        if (affected.has(dependent)) continue;
        affected.add(dependent);
        queue.push(dependent);
        queue.sort();
      }
    }
    return affected;
  }

  #servicesFor(
    modules: ReadonlyMap<string, ActiveRuntimeExtension>,
    plan: RuntimeExtensionPlan,
  ): Map<string, unknown> {
    const services = new Map<string, unknown>();
    for (const moduleId of plan.activationOrder) {
      const active = modules.get(moduleId);
      if (!active) continue;
      for (const [serviceId, value] of active.services) services.set(serviceId, value);
    }
    return services;
  }

  async #activate(
    compiled: CompiledRuntimeExtension,
    availableServices: ReadonlyMap<string, unknown>,
  ): Promise<ActiveRuntimeExtension> {
    const scope = new LocalRuntimeExtensionScope(compiled.manifest.manifestId);
    const required = new Set(compiled.manifest.requires.map(runtimeServiceIdentity));
    const declared = new Map(compiled.manifest.provides.map((service) => [
      runtimeServiceIdentity(service),
      service,
    ]));
    const provided = new Map<string, unknown>();
    const context: RuntimeExtensionActivationContext = Object.freeze({
      extensionId: compiled.manifest.id,
      scope,
      get: <Value>(service: RuntimeServiceKey<Value>): Value => {
        const serviceId = runtimeServiceIdentity(service);
        if (!required.has(serviceId)) {
          throw new Error(
            `Runtime extension ${compiled.manifest.id} did not declare requirement ${service.id}@${service.version}`,
          );
        }
        if (!availableServices.has(serviceId)) {
          throw new Error(
            `Runtime extension ${compiled.manifest.id} cannot resolve ${service.id}@${service.version} during staging`,
          );
        }
        return availableServices.get(serviceId) as Value;
      },
      provide: <Value>(service: RuntimeServiceKey<Value>, value: Value): void => {
        const serviceId = runtimeServiceIdentity(service);
        if (!declared.has(serviceId)) {
          throw new Error(
            `Runtime extension ${compiled.manifest.id} did not declare provision ${service.id}@${service.version}`,
          );
        }
        if (provided.has(serviceId)) {
          throw new Error(
            `Runtime extension ${compiled.manifest.id} provided ${service.id}@${service.version} more than once`,
          );
        }
        provided.set(serviceId, value);
      },
    });
    try {
      await compiled.activate(context);
      for (const [serviceId, service] of declared) {
        if (!provided.has(serviceId)) {
          throw new Error(
            `Runtime extension ${compiled.manifest.id} did not provide ${service.id}@${service.version}`,
          );
        }
      }
      return Object.freeze({ compiled, scope, services: provided });
    } catch (error) {
      try {
        await scope.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Runtime extension ${compiled.manifest.id} activation and cleanup both failed`,
        );
      }
      throw error;
    }
  }

  #createView(
    scopeId: string,
    allowed: ReadonlySet<string>,
    commitEpoch: number,
    generationId: string,
    values: ReadonlyMap<string, unknown>,
  ): RuntimeServiceView {
    const visible = frozenServiceReferences(
      this.#serviceReferences().filter((service) => allowed.has(runtimeServiceIdentity(service))),
    );
    const visibleIdentities = new Set(visible.map(runtimeServiceIdentity));
    const assertCurrent = (): void => {
      if (commitEpoch !== this.#commitEpoch) {
        throw new Error(`Runtime service view ${scopeId} belongs to a stale committed generation`);
      }
    };
    const view: RuntimeServiceView = {
      scopeId,
      generationId,
      services: visible,
      has: (service) => {
        assertCurrent();
        return visibleIdentities.has(runtimeServiceIdentity(service));
      },
      get: <Value>(service: RuntimeServiceKey<Value>): Value => {
        assertCurrent();
        const serviceId = runtimeServiceIdentity(service);
        if (!visibleIdentities.has(serviceId)) {
          throw new Error(
            `Runtime service view ${scopeId} does not grant ${service.id}@${service.version}`,
          );
        }
        return values.get(serviceId) as Value;
      },
      attenuate: (child) => {
        assertCurrent();
        const requested = child.services
          ? new Set(child.services.map(runtimeServiceIdentity))
          : visibleIdentities;
        const narrowed = new Set([...visibleIdentities].filter((serviceId) => requested.has(serviceId)));
        return this.#createView(
          boundedScopeId(child.scopeId),
          narrowed,
          commitEpoch,
          generationId,
          values,
        );
      },
    };
    return Object.freeze(view);
  }

  #serviceReferences(): ReadonlyArray<RuntimeServiceReference> {
    return [...this.#plan.modules.values()].flatMap((module) => module.manifest.provides);
  }
}
