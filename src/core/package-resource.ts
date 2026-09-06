import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Resolves an application-owned resource from the package that owns this
 * module. A caller's working directory is repository input and must not be
 * allowed to shadow executable browser assets or trusted prompt templates.
 */
export const resolvePackageResource = (...segments: ReadonlyArray<string>): string =>
  resolve(PACKAGE_ROOT, ...segments);
