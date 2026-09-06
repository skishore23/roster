export {
  createDesktopDeviceIdentity,
  DESKTOP_DEVICE_IDENTITY_SCHEMA_VERSION,
  DESKTOP_DEVICE_RANDOM_BYTES,
  loadOrCreateDesktopDeviceIdentity,
  MAX_DESKTOP_DEVICE_ID_LENGTH,
  normalizeDesktopDeviceIdentity,
  type DesktopDeviceIdentity,
  type DesktopDeviceIdentityOptions,
} from "./device-identity.js";

export {
  assertDesktopStateContainsNoCredentials,
  createDesktopSidecarStateApi,
  createEmptyDesktopOnboardingState,
  DESKTOP_ONBOARDING_SCHEMA_VERSION,
  DESKTOP_SIDECAR_BOOTSTRAP_SCHEMA_VERSION,
  MANAGED_SPACETIME_BOOTSTRAP_SCHEMA_VERSION,
  MAX_DESKTOP_REPOSITORY_PATH_LENGTH,
  MAX_DESKTOP_RUNTIME_COMMAND_PART_LENGTH,
  MAX_DESKTOP_RUNTIME_COMMAND_PARTS,
  MAX_DESKTOP_RUNTIME_PROFILES,
  normalizeDesktopOnboardingState,
  normalizeDesktopRuntimeProfile,
  normalizeDesktopSelectedRepository,
  normalizeManagedSpacetimeBootstrapConfig,
  serializeDesktopOnboardingState,
  type DesktopOnboardingStage,
  type DesktopOnboardingState,
  type DesktopRuntimeAccess,
  type DesktopRuntimeProfile,
  type DesktopRuntimeProfileSource,
  type DesktopSelectedRepository,
  type DesktopSidecarBootstrap,
  type DesktopSidecarStateApi,
  type ManagedSpacetimeBootstrapConfig,
} from "./onboarding.js";

export {
  desktopRuntimeEnvironment,
  DESKTOP_RUNTIME_ENV_SCHEMA_VERSION,
  type DesktopRuntimeEnvironment,
} from "./runtime-config.js";
