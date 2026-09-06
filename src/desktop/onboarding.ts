import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
} from "node:path";

import {
  type DesktopDeviceIdentity,
  loadOrCreateDesktopDeviceIdentity,
} from "./device-identity.js";

export const DESKTOP_ONBOARDING_SCHEMA_VERSION =
  "roster.desktop-onboarding.v1" as const;
export const MANAGED_SPACETIME_BOOTSTRAP_SCHEMA_VERSION =
  "roster.desktop-spacetime.v1" as const;
export const DESKTOP_SIDECAR_BOOTSTRAP_SCHEMA_VERSION =
  "roster.desktop-bootstrap.v1" as const;

export const MAX_DESKTOP_REPOSITORY_PATH_LENGTH = 4_096;
export const MAX_DESKTOP_RUNTIME_PROFILES = 32;
export const MAX_DESKTOP_RUNTIME_COMMAND_PARTS = 32;
export const MAX_DESKTOP_RUNTIME_COMMAND_PART_LENGTH = 2_048;

const MAX_ID_LENGTH = 80;
const MAX_LABEL_LENGTH = 120;
const MAX_RUNTIME_KIND_LENGTH = 80;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DATABASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CREDENTIAL_FIELD_PATTERN =
  /(?:api[-_]?key|authorization|credential|password|refresh[-_]?token|secret|token)/i;

export type DesktopRuntimeAccess = "read-only" | "workspace-write";
export type DesktopRuntimeProfileSource = "discovered" | "manual";

/**
 * A saved operator choice for a local runtime. It is not a WorkspaceNode and
 * does not contain a node id, binding, lease, session, worktree, or credential.
 */
export type DesktopRuntimeProfile = {
  readonly id: string;
  readonly label: string;
  readonly runtimeKind: string;
  readonly command: ReadonlyArray<string>;
  readonly access: DesktopRuntimeAccess;
  readonly source: DesktopRuntimeProfileSource;
  readonly enabled: boolean;
};

export type DesktopSelectedRepository = {
  readonly path: string;
  readonly name: string;
};

export type DesktopOnboardingStage = "repository" | "runtimes" | "ready";

export type DesktopOnboardingState = {
  readonly schemaVersion: typeof DESKTOP_ONBOARDING_SCHEMA_VERSION;
  readonly selectedRepository?: DesktopSelectedRepository;
  readonly runtimeProfiles: ReadonlyArray<DesktopRuntimeProfile>;
  /** Saved operator choice; it must name one enabled runtime profile. */
  readonly defaultRuntimeId?: string;
  readonly stage: DesktopOnboardingStage;
};

/**
 * Public, non-secret connection settings distributed with the desktop app.
 * Anonymous SpacetimeDB session tokens belong in the OS credential vault and
 * are deliberately absent from this schema.
 */
export type ManagedSpacetimeBootstrapConfig = {
  readonly schemaVersion: typeof MANAGED_SPACETIME_BOOTSTRAP_SCHEMA_VERSION;
  readonly uri: string;
  readonly database: string;
  readonly sessionMode: "anonymous-device";
  readonly connectTimeoutMs: number;
  readonly confirmedReads: boolean;
};

export type DesktopSidecarBootstrap = {
  readonly schemaVersion: typeof DESKTOP_SIDECAR_BOOTSTRAP_SCHEMA_VERSION;
  readonly device: DesktopDeviceIdentity;
  readonly spacetime: ManagedSpacetimeBootstrapConfig;
  readonly onboarding: DesktopOnboardingState;
};

type UnknownRecord = Readonly<Record<string, unknown>>;

const record = (value: unknown, name: string): UnknownRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as UnknownRecord;
};

const boundedString = (
  value: unknown,
  field: string,
  maxLength: number,
): string => {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error(`${field} must not be blank`);
  if (normalized.length > maxLength) {
    throw new Error(`${field} must not exceed ${maxLength} characters`);
  }
  return normalized;
};

const boundedId = (value: unknown, field: string): string => {
  const id = boundedString(value, field, MAX_ID_LENGTH);
  if (!ID_PATTERN.test(id)) throw new Error(`${field} contains unsupported characters`);
  return id;
};

const containsCredentialField = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsCredentialField);
  return Object.entries(value).some(([key, child]) =>
    CREDENTIAL_FIELD_PATTERN.test(key) || containsCredentialField(child));
};

export const normalizeDesktopRuntimeProfile = (
  value: unknown,
): DesktopRuntimeProfile => {
  const candidate = record(value, "Desktop runtime profile");
  const id = boundedId(candidate.id, "Desktop runtime profile id");
  const label = boundedString(
    candidate.label,
    `Desktop runtime profile ${id} label`,
    MAX_LABEL_LENGTH,
  );
  const runtimeKind = boundedString(
    candidate.runtimeKind,
    `Desktop runtime profile ${id} kind`,
    MAX_RUNTIME_KIND_LENGTH,
  );
  if (!ID_PATTERN.test(runtimeKind)) {
    throw new Error(`Desktop runtime profile ${id} kind contains unsupported characters`);
  }
  if (!Array.isArray(candidate.command) || candidate.command.length === 0) {
    throw new Error(`Desktop runtime profile ${id} requires a command`);
  }
  if (candidate.command.length > MAX_DESKTOP_RUNTIME_COMMAND_PARTS) {
    throw new Error(
      `Desktop runtime profile ${id} command exceeds ${MAX_DESKTOP_RUNTIME_COMMAND_PARTS} parts`,
    );
  }
  const command = candidate.command.map((part, index) => {
    if (typeof part !== "string" || !part.trim()) {
      throw new Error(`Desktop runtime profile ${id} command part ${index} must not be blank`);
    }
    if (part.includes("\0") || part.length > MAX_DESKTOP_RUNTIME_COMMAND_PART_LENGTH) {
      throw new Error(`Desktop runtime profile ${id} command part ${index} is invalid`);
    }
    return part;
  });
  if (candidate.access !== "read-only" && candidate.access !== "workspace-write") {
    throw new Error(`Desktop runtime profile ${id} has invalid workspace access`);
  }
  if (candidate.source !== "discovered" && candidate.source !== "manual") {
    throw new Error(`Desktop runtime profile ${id} has invalid source`);
  }
  if (typeof candidate.enabled !== "boolean") {
    throw new Error(`Desktop runtime profile ${id} enabled must be boolean`);
  }
  return {
    id,
    label,
    runtimeKind,
    command,
    access: candidate.access,
    source: candidate.source,
    enabled: candidate.enabled,
  };
};

export const normalizeDesktopSelectedRepository = (
  value: unknown,
): DesktopSelectedRepository => {
  const candidate = record(value, "Selected repository");
  if (typeof candidate.path !== "string") {
    throw new Error("Selected repository path must be a string");
  }
  if (
    !candidate.path.trim()
    || candidate.path.includes("\0")
    || candidate.path.length > MAX_DESKTOP_REPOSITORY_PATH_LENGTH
    || !isAbsolute(candidate.path)
  ) {
    throw new Error("Selected repository path must be a bounded absolute path");
  }
  const path = normalize(candidate.path);
  if (path === parse(path).root) {
    throw new Error("Selected repository path must not be a filesystem root");
  }
  return {
    path,
    name: boundedString(
      candidate.name ?? basename(path),
      "Selected repository name",
      MAX_LABEL_LENGTH,
    ),
  };
};

const onboardingStage = (
  repository: DesktopSelectedRepository | undefined,
  profiles: ReadonlyArray<DesktopRuntimeProfile>,
): DesktopOnboardingStage => {
  if (!repository) return "repository";
  return profiles.some((profile) => profile.enabled) ? "ready" : "runtimes";
};

export const normalizeDesktopOnboardingState = (
  value: unknown,
): DesktopOnboardingState => {
  const candidate = record(value, "Desktop onboarding state");
  if (
    candidate.schemaVersion !== undefined
    && candidate.schemaVersion !== DESKTOP_ONBOARDING_SCHEMA_VERSION
  ) {
    throw new Error(`Unsupported desktop onboarding schema "${String(candidate.schemaVersion)}"`);
  }
  if (!Array.isArray(candidate.runtimeProfiles)) {
    throw new Error("Desktop onboarding runtime profiles must be an array");
  }
  if (candidate.runtimeProfiles.length > MAX_DESKTOP_RUNTIME_PROFILES) {
    throw new Error(
      `Desktop onboarding supports at most ${MAX_DESKTOP_RUNTIME_PROFILES} runtime profiles`,
    );
  }
  const runtimeProfiles = candidate.runtimeProfiles.map(normalizeDesktopRuntimeProfile);
  const ids = new Set<string>();
  for (const profile of runtimeProfiles) {
    if (ids.has(profile.id)) {
      throw new Error(`Desktop onboarding contains duplicate runtime profile ${profile.id}`);
    }
    ids.add(profile.id);
  }
  const selectedRepository = candidate.selectedRepository === undefined
    ? undefined
    : normalizeDesktopSelectedRepository(candidate.selectedRepository);
  const enabledRuntimeIds = runtimeProfiles
    .filter((profile) => profile.enabled)
    .map((profile) => profile.id);
  const defaultRuntimeId = candidate.defaultRuntimeId === undefined
    ? enabledRuntimeIds[0]
    : boundedId(candidate.defaultRuntimeId, "Desktop onboarding default runtime id");
  if (defaultRuntimeId && !enabledRuntimeIds.includes(defaultRuntimeId)) {
    throw new Error("Desktop onboarding default runtime must name an enabled runtime profile");
  }
  return {
    schemaVersion: DESKTOP_ONBOARDING_SCHEMA_VERSION,
    ...(selectedRepository ? { selectedRepository } : {}),
    runtimeProfiles,
    ...(defaultRuntimeId ? { defaultRuntimeId } : {}),
    stage: onboardingStage(selectedRepository, runtimeProfiles),
  };
};

export const createEmptyDesktopOnboardingState = (): DesktopOnboardingState => ({
  schemaVersion: DESKTOP_ONBOARDING_SCHEMA_VERSION,
  runtimeProfiles: [],
  stage: "repository",
});

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost"
  || hostname === "::1"
  || hostname.startsWith("127.");

const boundedInteger = (
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
};

export const normalizeManagedSpacetimeBootstrapConfig = (
  value: unknown,
): ManagedSpacetimeBootstrapConfig => {
  const candidate = record(value, "Managed SpacetimeDB bootstrap config");
  if (
    candidate.schemaVersion !== undefined
    && candidate.schemaVersion !== MANAGED_SPACETIME_BOOTSTRAP_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported managed SpacetimeDB bootstrap schema "${String(candidate.schemaVersion)}"`,
    );
  }
  const rawUri = boundedString(
    candidate.uri,
    "Managed SpacetimeDB uri",
    2_048,
  );
  let parsed: URL;
  try {
    parsed = new URL(rawUri);
  } catch (error) {
    throw new Error("Managed SpacetimeDB uri must be an absolute URL", { cause: error });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Managed SpacetimeDB uri must not contain credentials, query, or fragment");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new Error("Managed SpacetimeDB uri must use HTTPS outside loopback development");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("Managed SpacetimeDB uri must be an origin without a path");
  }
  const database = boundedString(
    candidate.database,
    "Managed SpacetimeDB database",
    128,
  );
  if (!DATABASE_PATTERN.test(database)) {
    throw new Error("Managed SpacetimeDB database contains unsupported characters");
  }
  if (
    candidate.sessionMode !== undefined
    && candidate.sessionMode !== "anonymous-device"
  ) {
    throw new Error("Managed SpacetimeDB desktop sessions must use anonymous-device mode");
  }
  if (
    candidate.confirmedReads !== undefined
    && typeof candidate.confirmedReads !== "boolean"
  ) {
    throw new Error("Managed SpacetimeDB confirmed reads must be boolean");
  }
  return {
    schemaVersion: MANAGED_SPACETIME_BOOTSTRAP_SCHEMA_VERSION,
    uri: parsed.origin,
    database,
    sessionMode: "anonymous-device",
    connectTimeoutMs: boundedInteger(
      candidate.connectTimeoutMs,
      "Managed SpacetimeDB connect timeout",
      10_000,
      1_000,
      60_000,
    ),
    confirmedReads: candidate.confirmedReads === undefined
      ? true
      : candidate.confirmedReads === true,
  };
};

/**
 * Returns only the allowlisted onboarding schema. Unknown properties,
 * including credential-shaped values, cannot enter the serialized document.
 */
export const serializeDesktopOnboardingState = (value: unknown): string =>
  `${JSON.stringify(normalizeDesktopOnboardingState(value))}\n`;

export const assertDesktopStateContainsNoCredentials = (value: unknown): void => {
  if (containsCredentialField(value)) {
    throw new Error("Desktop persisted state must not contain credentials");
  }
};

const readOnboardingState = async (
  filePath: string,
): Promise<DesktopOnboardingState> => {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyDesktopOnboardingState();
    }
    throw error;
  }
  try {
    return normalizeDesktopOnboardingState(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Desktop onboarding state at ${filePath} is not valid JSON`, {
        cause: error,
      });
    }
    throw error;
  }
};

const writeOnboardingState = async (
  filePath: string,
  value: unknown,
): Promise<DesktopOnboardingState> => {
  if (!isAbsolute(filePath)) throw new Error("Desktop onboarding path must be absolute");
  const state = normalizeDesktopOnboardingState(value);
  const serialized = serializeDesktopOnboardingState(state);
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return state;
};

export type DesktopSidecarStateApi = {
  readonly dataDirectory: string;
  readonly deviceIdentityPath: string;
  readonly onboardingPath: string;
  readonly loadDeviceIdentity: () => Promise<DesktopDeviceIdentity>;
  readonly loadOnboarding: () => Promise<DesktopOnboardingState>;
  readonly saveOnboarding: (value: unknown) => Promise<DesktopOnboardingState>;
  readonly bootstrap: (
    spacetime: unknown,
  ) => Promise<DesktopSidecarBootstrap>;
};

/**
 * Filesystem-backed API for the bundled Tauri sidecar. The renderer can receive
 * bootstrap results without gaining arbitrary filesystem or credential access.
 */
export const createDesktopSidecarStateApi = (
  dataDirectory: string,
): DesktopSidecarStateApi => {
  if (!isAbsolute(dataDirectory)) {
    throw new Error("Desktop sidecar data directory must be absolute");
  }
  const normalizedDataDirectory = normalize(dataDirectory);
  const deviceIdentityPath = join(normalizedDataDirectory, "device-identity.json");
  const onboardingPath = join(normalizedDataDirectory, "onboarding.json");
  const loadDeviceIdentity = (): Promise<DesktopDeviceIdentity> =>
    loadOrCreateDesktopDeviceIdentity(deviceIdentityPath);
  const loadOnboarding = (): Promise<DesktopOnboardingState> =>
    readOnboardingState(onboardingPath);
  return {
    dataDirectory: normalizedDataDirectory,
    deviceIdentityPath,
    onboardingPath,
    loadDeviceIdentity,
    loadOnboarding,
    saveOnboarding: (value) => writeOnboardingState(onboardingPath, value),
    bootstrap: async (spacetime) => ({
      schemaVersion: DESKTOP_SIDECAR_BOOTSTRAP_SCHEMA_VERSION,
      device: await loadDeviceIdentity(),
      spacetime: normalizeManagedSpacetimeBootstrapConfig(spacetime),
      onboarding: await loadOnboarding(),
    }),
  };
};
