import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import type {
  DesktopDeviceIdentity,
  DesktopOnboardingState,
  ManagedSpacetimeBootstrapConfig,
} from "./index.js";

export const DESKTOP_RUNTIME_ENV_SCHEMA_VERSION =
  "roster.desktop-runtime-env.v1" as const;

export type DesktopRuntimeEnvironment = {
  readonly schemaVersion: typeof DESKTOP_RUNTIME_ENV_SCHEMA_VERSION;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

const runtimePath = (
  onboarding: DesktopOnboardingState,
): string | undefined => {
  const directories = onboarding.runtimeProfiles
    .filter((profile) => profile.enabled)
    .map((profile) => dirname(profile.command[0]!));
  const unique = [...new Set(directories)];
  return unique.length > 0 ? unique.join(process.platform === "win32" ? ";" : ":") : undefined;
};

const spacetimeIdentityTokenPath = (
  dataDirectory: string,
  spacetime: ManagedSpacetimeBootstrapConfig,
): string => {
  const scope = createHash("sha256")
    .update(spacetime.uri)
    .update("\0")
    .update(spacetime.database)
    .digest("hex")
    .slice(0, 16);
  return join(dataDirectory, `spacetimedb-identity-${scope}.token`);
};

export const desktopRuntimeEnvironment = (input: {
  readonly dataDirectory: string;
  readonly device: DesktopDeviceIdentity;
  readonly onboarding: DesktopOnboardingState;
  readonly spacetime: ManagedSpacetimeBootstrapConfig;
  readonly port: number;
  readonly inheritedPath?: string;
}): DesktopRuntimeEnvironment => {
  const repository = input.onboarding.selectedRepository;
  if (!repository || input.onboarding.stage !== "ready") {
    throw new Error("Roster desktop runtime requires completed repository and agent onboarding");
  }
  if (!Number.isSafeInteger(input.port) || input.port < 1_024 || input.port > 65_535) {
    throw new Error("Roster desktop runtime port must be an integer between 1024 and 65535");
  }
  const configuredRuntimePath = runtimePath(input.onboarding);
  const path = [configuredRuntimePath, input.inheritedPath]
    .filter((value): value is string => Boolean(value))
    .join(process.platform === "win32" ? ";" : ":");
  return {
    schemaVersion: DESKTOP_RUNTIME_ENV_SCHEMA_VERSION,
    cwd: repository.path,
    env: {
      NODE_ENV: "production",
      PORT: String(input.port),
      DATA_DIR: join(input.dataDirectory, "runtime"),
      SPACETIMEDB_URI: input.spacetime.uri,
      SPACETIMEDB_PUBLIC_URI: input.spacetime.uri,
      SPACETIMEDB_DATABASE: input.spacetime.database,
      // SpacetimeDB tokens are issued by one control plane. Keeping the
      // endpoint/database scope in the filename prevents a development token
      // from bricking the production desktop app (and vice versa).
      SPACETIMEDB_TOKEN_PATH: spacetimeIdentityTokenPath(
        input.dataDirectory,
        input.spacetime,
      ),
      SPACETIMEDB_CONNECT_TIMEOUT_MS: String(input.spacetime.connectTimeoutMs),
      SPACETIMEDB_CONFIRMED_READS: input.spacetime.confirmedReads ? "1" : "0",
      ROSTER_WORKSPACE_ID: `roster/${input.device.deviceId}`,
      ROSTER_WORKSPACE_NAME: `Roster · ${repository.name}`,
      ROSTER_SERVER_SURFACE: "repository",
      ...(path ? { PATH: path } : {}),
      ...(configuredRuntimePath ? { ROSTER_CODING_CLI_PATH: configuredRuntimePath } : {}),
    },
  };
};
