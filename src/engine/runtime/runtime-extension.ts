import { hashCanonical } from "../../core/canonical.js";

export const RUNTIME_EXTENSION_MANIFEST_VERSION = "roster.runtime-extension-manifest.v1" as const;
export const RUNTIME_EXTENSION_GENERATION_VERSION = "roster.runtime-extension-generation.v1" as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const MAX_ID_LENGTH = 160;
const MAX_VERSION_LENGTH = 160;
const MAX_HASH_LENGTH = 256;

export type RuntimeServiceReference = {
  readonly id: string;
  readonly version: string;
};

/** A typed process-local handle. Only its string identity enters a manifest. */
export type RuntimeServiceKey<Value = unknown> = RuntimeServiceReference & {
  readonly __runtimeServiceValue?: Value;
};

export const defineRuntimeService = <Value>(
  id: string,
  version: string,
): RuntimeServiceKey<Value> => Object.freeze(normalizeServiceReference({ id, version }));

export type RuntimeExtensionLifecycleCleanup = () => void | Promise<void>;

/** Cleanup registration exposed during process-local extension activation. */
export interface RuntimeExtensionLifecycleScope {
  readonly disposed: boolean;
  defer(cleanup: RuntimeExtensionLifecycleCleanup): void;
}

export interface RuntimeExtensionActivationContext {
  readonly extensionId: string;
  readonly scope: RuntimeExtensionLifecycleScope;
  get<Value>(service: RuntimeServiceKey<Value>): Value;
  provide<Value>(service: RuntimeServiceKey<Value>, value: Value): void;
}

export type RuntimeExtensionDefinition = {
  readonly id: string;
  /** Public service contract version; artifact/configuration hashes identify deployments. */
  readonly version: string;
  /** Immutable package, Git, or object identity for generated/deployed modules. */
  readonly artifactHash?: string;
  /** Immutable normalized desired-configuration identity; never contains secrets. */
  readonly configurationHash?: string;
  readonly requires?: ReadonlyArray<RuntimeServiceReference>;
  readonly provides?: ReadonlyArray<RuntimeServiceReference>;
  readonly activate: (context: RuntimeExtensionActivationContext) => void | Promise<void>;
};

export type RuntimeExtensionManifest = {
  readonly schemaVersion: typeof RUNTIME_EXTENSION_MANIFEST_VERSION;
  readonly manifestId: string;
  readonly id: string;
  readonly version: string;
  readonly artifactHash?: string;
  readonly configurationHash?: string;
  readonly requires: ReadonlyArray<RuntimeServiceReference>;
  readonly provides: ReadonlyArray<RuntimeServiceReference>;
};

export type RuntimeExtensionGenerationManifest = {
  readonly schemaVersion: typeof RUNTIME_EXTENSION_GENERATION_VERSION;
  readonly generationId: string;
  readonly modules: ReadonlyArray<RuntimeExtensionManifest>;
};

export type RuntimeExtensionLimits = {
  readonly maxModules: number;
  readonly maxRequiresPerModule: number;
  readonly maxProvidesPerModule: number;
  readonly maxDependencies: number;
};

export const DEFAULT_RUNTIME_EXTENSION_LIMITS: RuntimeExtensionLimits = Object.freeze({
  maxModules: 128,
  maxRequiresPerModule: 64,
  maxProvidesPerModule: 64,
  maxDependencies: 2_048,
});

export type CompiledRuntimeExtension = {
  readonly manifest: RuntimeExtensionManifest;
  readonly activate: RuntimeExtensionDefinition["activate"];
};

/** @internal Process-local compiled graph consumed by RuntimeExtensionHost. */
export type RuntimeExtensionPlan = {
  readonly manifest: RuntimeExtensionGenerationManifest;
  readonly modules: ReadonlyMap<string, CompiledRuntimeExtension>;
  readonly providerByService: ReadonlyMap<string, string>;
  readonly dependenciesByModule: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly dependentsByModule: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly activationOrder: ReadonlyArray<string>;
};

const positiveLimit = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
};

export const normalizeRuntimeExtensionLimits = (
  limits: Partial<RuntimeExtensionLimits> = {},
): RuntimeExtensionLimits => Object.freeze({
  maxModules: positiveLimit(
    limits.maxModules ?? DEFAULT_RUNTIME_EXTENSION_LIMITS.maxModules,
    "Runtime extension maxModules",
  ),
  maxRequiresPerModule: positiveLimit(
    limits.maxRequiresPerModule ?? DEFAULT_RUNTIME_EXTENSION_LIMITS.maxRequiresPerModule,
    "Runtime extension maxRequiresPerModule",
  ),
  maxProvidesPerModule: positiveLimit(
    limits.maxProvidesPerModule ?? DEFAULT_RUNTIME_EXTENSION_LIMITS.maxProvidesPerModule,
    "Runtime extension maxProvidesPerModule",
  ),
  maxDependencies: positiveLimit(
    limits.maxDependencies ?? DEFAULT_RUNTIME_EXTENSION_LIMITS.maxDependencies,
    "Runtime extension maxDependencies",
  ),
});

const boundedId = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized) || normalized.length > MAX_ID_LENGTH) {
    throw new Error(`${label} must be a bounded runtime identifier`);
  }
  return normalized;
};

const boundedVersion = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_VERSION_LENGTH) {
    throw new Error(`${label} must be between 1 and ${MAX_VERSION_LENGTH} characters`);
  }
  return normalized;
};

const boundedHash = (value: string, label: string): string => {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > MAX_HASH_LENGTH
    || /[\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    throw new Error(`${label} must be a non-empty bounded hash`);
  }
  return normalized;
};

export const normalizeServiceReference = (
  service: RuntimeServiceReference,
): RuntimeServiceReference => Object.freeze({
  id: boundedId(service.id, "Runtime service id"),
  version: boundedVersion(service.version, `Runtime service ${service.id} version`),
});

/** Length framing avoids ambiguous composite identities without restricting versions. */
export const runtimeServiceIdentity = (service: RuntimeServiceReference): string => {
  const normalized = normalizeServiceReference(service);
  return `${normalized.id.length}:${normalized.id}${normalized.version}`;
};

const normalizedReferences = (
  input: ReadonlyArray<RuntimeServiceReference> | undefined,
  label: string,
  maximum: number,
): ReadonlyArray<RuntimeServiceReference> => {
  const references = (input ?? []).map(normalizeServiceReference);
  if (references.length > maximum) {
    throw new Error(`${label} exceeds maximum ${maximum}`);
  }
  const identities = references.map(runtimeServiceIdentity);
  if (new Set(identities).size !== identities.length) {
    throw new Error(`${label} contains a duplicate exact service version`);
  }
  return Object.freeze(references.sort((left, right) =>
    left.id.localeCompare(right.id) || left.version.localeCompare(right.version)));
};

const compileModule = (
  definition: RuntimeExtensionDefinition,
  limits: RuntimeExtensionLimits,
): CompiledRuntimeExtension => {
  const id = boundedId(definition.id, "Runtime extension id");
  const version = boundedVersion(definition.version, `Runtime extension ${id} version`);
  const activate = definition.activate;
  if (typeof activate !== "function") {
    throw new Error(`Runtime extension ${id} requires an activate function`);
  }
  const requires = normalizedReferences(
    definition.requires,
    `Runtime extension ${id} requirements`,
    limits.maxRequiresPerModule,
  );
  const provides = normalizedReferences(
    definition.provides,
    `Runtime extension ${id} provisions`,
    limits.maxProvidesPerModule,
  );
  const content = Object.freeze({
    schemaVersion: RUNTIME_EXTENSION_MANIFEST_VERSION,
    id,
    version,
    ...(definition.artifactHash !== undefined ? {
      artifactHash: boundedHash(
        definition.artifactHash,
        `Runtime extension ${id} artifactHash`,
      ),
    } : {}),
    ...(definition.configurationHash !== undefined ? {
      configurationHash: boundedHash(
        definition.configurationHash,
        `Runtime extension ${id} configurationHash`,
      ),
    } : {}),
    requires,
    provides,
  });
  const manifest: RuntimeExtensionManifest = Object.freeze({
    ...content,
    manifestId: `runtime_extension_${hashCanonical(content).slice(0, 28)}`,
  });
  return Object.freeze({ manifest, activate });
};

const deterministicTopologicalOrder = (
  moduleIds: ReadonlyArray<string>,
  dependencies: ReadonlyMap<string, ReadonlyArray<string>>,
  dependents: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<string> => {
  const remaining = new Map(moduleIds.map((moduleId) => [
    moduleId,
    dependencies.get(moduleId)?.length ?? 0,
  ]));
  const ready = moduleIds.filter((moduleId) => remaining.get(moduleId) === 0).sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const moduleId = ready.shift()!;
    ordered.push(moduleId);
    for (const dependent of dependents.get(moduleId) ?? []) {
      const next = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (ordered.length !== moduleIds.length) {
    const cyclic = moduleIds.filter((moduleId) => !ordered.includes(moduleId)).sort();
    throw new Error(`Runtime extension dependency cycle includes: ${cyclic.join(", ")}`);
  }
  return Object.freeze(ordered);
};

export const compileRuntimeExtensionPlan = (
  definitions: ReadonlyArray<RuntimeExtensionDefinition>,
  inputLimits: Partial<RuntimeExtensionLimits> = {},
): RuntimeExtensionPlan => {
  const limits = normalizeRuntimeExtensionLimits(inputLimits);
  if (definitions.length > limits.maxModules) {
    throw new Error(`Runtime extension module count exceeds maximum ${limits.maxModules}`);
  }

  const modules = new Map<string, CompiledRuntimeExtension>();
  for (const definition of definitions) {
    const compiled = compileModule(definition, limits);
    if (modules.has(compiled.manifest.id)) {
      throw new Error(`Duplicate runtime extension ${compiled.manifest.id}`);
    }
    modules.set(compiled.manifest.id, compiled);
  }

  const providerByService = new Map<string, string>();
  for (const module of modules.values()) {
    for (const provision of module.manifest.provides) {
      const serviceIdentity = runtimeServiceIdentity(provision);
      const prior = providerByService.get(serviceIdentity);
      if (prior) {
        throw new Error(
          `Runtime service ${provision.id}@${provision.version} is provided by both ${prior} and ${module.manifest.id}`,
        );
      }
      providerByService.set(serviceIdentity, module.manifest.id);
    }
  }

  const totalDependencies = [...modules.values()].reduce(
    (total, module) => total + module.manifest.requires.length,
    0,
  );
  if (totalDependencies > limits.maxDependencies) {
    throw new Error(`Runtime extension dependency count exceeds maximum ${limits.maxDependencies}`);
  }

  const dependenciesByModule = new Map<string, ReadonlyArray<string>>();
  const mutableDependents = new Map<string, Set<string>>(
    [...modules.keys()].map((moduleId) => [moduleId, new Set<string>()]),
  );
  for (const module of modules.values()) {
    const dependencies = new Set<string>();
    for (const requirement of module.manifest.requires) {
      const providerId = providerByService.get(runtimeServiceIdentity(requirement));
      if (!providerId) {
        throw new Error(
          `Runtime extension ${module.manifest.id} requires missing service ${requirement.id}@${requirement.version}`,
        );
      }
      dependencies.add(providerId);
      mutableDependents.get(providerId)!.add(module.manifest.id);
    }
    dependenciesByModule.set(module.manifest.id, Object.freeze([...dependencies].sort()));
  }
  const dependentsByModule = new Map<string, ReadonlyArray<string>>(
    [...mutableDependents].map(([moduleId, dependents]) => [
      moduleId,
      Object.freeze([...dependents].sort()),
    ]),
  );
  const moduleIds = [...modules.keys()].sort();
  const activationOrder = deterministicTopologicalOrder(
    moduleIds,
    dependenciesByModule,
    dependentsByModule,
  );
  const moduleManifests = Object.freeze(
    moduleIds.map((moduleId) => modules.get(moduleId)!.manifest),
  );
  const generationContent = Object.freeze({
    schemaVersion: RUNTIME_EXTENSION_GENERATION_VERSION,
    modules: moduleManifests,
  });
  const manifest: RuntimeExtensionGenerationManifest = Object.freeze({
    ...generationContent,
    generationId: `runtime_generation_${hashCanonical(generationContent).slice(0, 28)}`,
  });
  return Object.freeze({
    manifest,
    modules,
    providerByService,
    dependenciesByModule,
    dependentsByModule,
    activationOrder,
  });
};
