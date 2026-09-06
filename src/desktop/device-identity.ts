import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export const DESKTOP_DEVICE_IDENTITY_SCHEMA_VERSION =
  "roster.desktop-device.v1" as const;
export const DESKTOP_DEVICE_RANDOM_BYTES = 24;
export const MAX_DESKTOP_DEVICE_ID_LENGTH = 40;

const DEVICE_ID_PATTERN = /^device_[A-Za-z0-9_-]{32}$/;

export type DesktopDeviceIdentity = {
  readonly schemaVersion: typeof DESKTOP_DEVICE_IDENTITY_SCHEMA_VERSION;
  /**
   * A random installation identifier. It is neither a hardware fingerprint
   * nor a credential and must never be used as proof of authorization.
   */
  readonly deviceId: string;
  readonly createdAt: string;
};

export type DesktopDeviceIdentityOptions = {
  readonly now?: () => Date;
  readonly randomSource?: (size: number) => Uint8Array;
};

const normalizeCreatedAt = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("Desktop device identity requires a creation timestamp");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error("Desktop device identity creation timestamp must be canonical ISO-8601");
  }
  return value;
};

export const normalizeDesktopDeviceIdentity = (
  value: unknown,
): DesktopDeviceIdentity => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Desktop device identity must be an object");
  }
  const candidate = value as {
    readonly schemaVersion?: unknown;
    readonly deviceId?: unknown;
    readonly createdAt?: unknown;
  };
  if (candidate.schemaVersion !== DESKTOP_DEVICE_IDENTITY_SCHEMA_VERSION) {
    throw new Error(`Unsupported desktop device identity schema "${String(candidate.schemaVersion)}"`);
  }
  if (
    typeof candidate.deviceId !== "string"
    || candidate.deviceId.length > MAX_DESKTOP_DEVICE_ID_LENGTH
    || !DEVICE_ID_PATTERN.test(candidate.deviceId)
  ) {
    throw new Error("Desktop device identity contains an invalid random installation id");
  }
  return {
    schemaVersion: DESKTOP_DEVICE_IDENTITY_SCHEMA_VERSION,
    deviceId: candidate.deviceId,
    createdAt: normalizeCreatedAt(candidate.createdAt),
  };
};

export const createDesktopDeviceIdentity = (
  options: DesktopDeviceIdentityOptions = {},
): DesktopDeviceIdentity => {
  const bytes = options.randomSource?.(DESKTOP_DEVICE_RANDOM_BYTES)
    ?? randomBytes(DESKTOP_DEVICE_RANDOM_BYTES);
  if (bytes.byteLength !== DESKTOP_DEVICE_RANDOM_BYTES) {
    throw new Error(
      `Desktop device identity random source must return ${DESKTOP_DEVICE_RANDOM_BYTES} bytes`,
    );
  }
  return normalizeDesktopDeviceIdentity({
    schemaVersion: DESKTOP_DEVICE_IDENTITY_SCHEMA_VERSION,
    deviceId: `device_${Buffer.from(bytes).toString("base64url")}`,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
  });
};

const readIdentity = async (filePath: string): Promise<DesktopDeviceIdentity> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Desktop device identity at ${filePath} is not valid JSON`, {
        cause: error,
      });
    }
    throw error;
  }
  return normalizeDesktopDeviceIdentity(parsed);
};

const isMissingFile = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const removeIfPresent = async (filePath: string): Promise<void> => {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
};

/**
 * Creates one durable installation identity using an atomic hard-link publish.
 * Concurrent sidecars converge on the first complete identity file.
 */
export const loadOrCreateDesktopDeviceIdentity = async (
  filePath: string,
  options: DesktopDeviceIdentityOptions = {},
): Promise<DesktopDeviceIdentity> => {
  if (!isAbsolute(filePath)) {
    throw new Error("Desktop device identity path must be absolute");
  }
  try {
    return await readIdentity(filePath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const identity = createDesktopDeviceIdentity(options);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(identity)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await link(temporaryPath, filePath);
    await chmod(filePath, 0o600);
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return await readIdentity(filePath);
  } finally {
    await removeIfPresent(temporaryPath);
  }
};
