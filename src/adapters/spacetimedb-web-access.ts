import { createHash, randomBytes } from "node:crypto";

import { boundedFiniteInteger } from "../core/numbers.js";
import type { RosterRealtimeBootConfig, RosterRealtimeDomain } from "../views/roster-realtime.js";
import type { SpacetimeControlPlane } from "./spacetimedb-control.js";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const publicUri = (controlPlane: SpacetimeControlPlane): string => {
  const explicit = process.env.SPACETIMEDB_PUBLIC_URI?.trim();
  const value = explicit || controlPlane.config.uri;
  if (process.env.NODE_ENV === "production") {
    if (!explicit) throw new Error("SPACETIMEDB_PUBLIC_URI is required in production");
    const parsed = new URL(explicit);
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !loopback) {
      throw new Error("SPACETIMEDB_PUBLIC_URI must use HTTPS outside loopback development");
    }
  }
  return value;
};

export const workspaceViewerLimits = (env: NodeJS.ProcessEnv = process.env) => ({
  maxUses: boundedFiniteInteger(env.ROSTER_VIEWER_MAX_USES, 10_000, 1, 10_000),
  ttlSeconds: boundedFiniteInteger(env.ROSTER_VIEWER_TTL_SECONDS, 86_400, 60, 2_592_000),
});

export const codingCliViewerLimits = (env: NodeJS.ProcessEnv = process.env) => ({
  maxUses: boundedFiniteInteger(env.ROSTER_CODING_CLI_VIEWER_MAX_USES, 8, 1, 32),
  ttlSeconds: boundedFiniteInteger(env.ROSTER_CODING_CLI_VIEWER_TTL_SECONDS, 600, 60, 3_600),
});

export type SpacetimeViewerSession = {
  readonly capabilitySecret: string;
  readonly capabilityId: string;
  readonly expiresAt: number;
  readonly uri: string;
  readonly database: string;
  readonly confirmedReads: boolean;
};

export class SpacetimeWebAccess {
  private constructor(
    readonly controlPlane: SpacetimeControlPlane,
    readonly workspaceId: string,
    readonly capabilitySecret: string,
    readonly capabilityId: string,
    readonly uri: string,
  ) {}

  static async create(
    controlPlane: SpacetimeControlPlane,
    workspaceId: string,
  ): Promise<SpacetimeWebAccess> {
    const capabilitySecret = randomBytes(32).toString("base64url");
    const capabilityId = `workspace-viewer-${randomBytes(12).toString("hex")}`;
    const { maxUses, ttlSeconds } = workspaceViewerLimits();
    await controlPlane.createWorkspaceViewerCapability({
      workspaceId,
      capabilityId,
      capabilityHash: sha256Hex(capabilitySecret),
      maxUses,
      ttlSeconds,
    });
    return new SpacetimeWebAccess(
      controlPlane,
      workspaceId,
      capabilitySecret,
      capabilityId,
      publicUri(controlPlane),
    );
  }

  boot(input: {
    readonly domain: RosterRealtimeDomain;
    readonly stream: string;
    readonly runId?: string;
    readonly runStream?: string;
    readonly branchStream?: string;
  }): RosterRealtimeBootConfig {
    return {
      ...input,
      workspaceId: this.workspaceId,
      capabilitySecret: this.capabilitySecret,
      realtime: {
        enabled: true,
        uri: this.uri,
        database: this.controlPlane.config.database,
        confirmedReads: this.controlPlane.config.confirmedReads,
      },
    };
  }

  /**
   * Mints a bounded capability for one authenticated, caller-scoped client
   * attachment. The process-wide browser boot capability is deliberately not
   * reused or exposed through an API response.
   */
  async createViewerSession(runId: string): Promise<SpacetimeViewerSession> {
    const capabilitySecret = randomBytes(32).toString("base64url");
    const capabilityId = `coding-run-viewer-${randomBytes(12).toString("hex")}`;
    const { maxUses, ttlSeconds } = codingCliViewerLimits();
    await this.controlPlane.createViewerCapability({
      runId,
      capabilityId,
      capabilityHash: sha256Hex(capabilitySecret),
      maxUses,
      ttlSeconds,
    });
    return {
      capabilitySecret,
      capabilityId,
      expiresAt: Date.now() + ttlSeconds * 1_000,
      uri: this.uri,
      database: this.controlPlane.config.database,
      confirmedReads: this.controlPlane.config.confirmedReads,
    };
  }

  connectSources(): ReadonlyArray<string> {
    const http = new URL(this.uri);
    const socket = new URL(this.uri);
    socket.protocol = http.protocol === "https:" ? "wss:" : "ws:";
    return [http.origin, socket.origin];
  }
}
